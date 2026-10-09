//! Read-only worktree state probes shared by guard, hook context, init, rollback and removal.
//!
//! A worktree's SpecGit-private state lives under its own Git directory
//! (`<git_dir>/specgit-v2`). Linked worktrees share `info/exclude` and the common
//! hooks directory, so asset retirement must consult every sibling first.
use crate::{
    assets::{Applied, AssetStore, safe_path},
    diagnostic::{Code, Diagnostic},
    process::Process,
    project,
};
use serde::Serialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// Files that exist only after `init`, `migrate` or an Issue checkpoint wrote
/// this worktree's state. Setup-only receipts do not prove initialization, and a
/// guard receipt alone may be retained for shared hooks after removal.
pub const INITIALIZED_MARKERS: [&str; 3] =
    ["guidance.json", "local-routing.json", "selection.json"];
/// Integration receipts reported for context; they do not prove initialization.
pub const RECEIPT_MARKERS: [&str; 2] = ["guard-hooks.json", "agent-assets/ownership.json"];
const WORKTREE_LIMIT: usize = 64;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct PrivateState {
    /// Present initialization markers.
    pub initialized: Vec<&'static str>,
    /// Present integration receipts.
    pub receipts: Vec<&'static str>,
}
impl PrivateState {
    /// True when this worktree was initialized, even if its declaration is gone.
    pub fn is_initialized(&self) -> bool {
        !self.initialized.is_empty()
    }
    pub fn markers(&self) -> Vec<&'static str> {
        self.initialized
            .iter()
            .chain(&self.receipts)
            .copied()
            .collect()
    }
}

fn present(path: &Path) -> Result<bool, Diagnostic> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(Diagnostic::new(
            Code::IoFailed,
            "local_state",
            "SpecGit private worktree state cannot be inspected.",
            "Restore local access to the Git directory and retry.",
        )),
    }
}

/// Probe `<git_dir>/specgit-v2` without reading or changing its contents.
pub fn private_state(private_root: &Path) -> Result<PrivateState, Diagnostic> {
    safe_path(private_root)?;
    let mut state = PrivateState::default();
    for name in INITIALIZED_MARKERS {
        if present(&private_root.join(name))? {
            state.initialized.push(name);
        }
    }
    for name in RECEIPT_MARKERS {
        if present(&private_root.join(name))? {
            state.receipts.push(name);
        }
    }
    Ok(state)
}

fn git_line(bytes: Vec<u8>, what: &str) -> Result<PathBuf, Diagnostic> {
    let text = String::from_utf8(bytes)
        .map_err(|_| Diagnostic::input(&format!("Git returned a non-UTF-8 {what} path.")))?;
    Ok(PathBuf::from(text.trim_end_matches(['\r', '\n'])))
}

/// The worktree's SpecGit-private root, `<absolute git dir>/specgit-v2`.
pub async fn private_root(process: &Process, root: &Path) -> Result<PathBuf, Diagnostic> {
    let git_dir = git_line(
        project::git(process, root, &["rev-parse", "--absolute-git-dir"]).await?,
        "metadata",
    )?;
    Ok(git_dir.join("specgit-v2"))
}

/// Husky's `core.hooksPath=.husky/_` delegates to user scripts in `.husky/`.
pub fn hook_root(effective: PathBuf) -> PathBuf {
    if effective.file_name().is_some_and(|name| name == "_")
        && effective
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|name| name == ".husky")
    {
        effective
            .parent()
            .map_or_else(|| effective.clone(), Path::to_path_buf)
    } else {
        effective
    }
}

/// The effective hook directory Git uses for this worktree.
pub async fn hooks(process: &Process, root: &Path) -> Result<PathBuf, Diagnostic> {
    Ok(hook_root(git_line(
        project::git(
            process,
            root,
            &["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
        )
        .await?,
        "hooks",
    )?))
}

/// The lost-declaration diagnostic: SpecGit integration remains, so callers fail closed.
pub fn lost_declaration(root: &Path, state: &PrivateState) -> Diagnostic {
    Diagnostic::new(
        Code::EvidenceRejected,
        "local_state",
        &format!(
            "{} has no .specgit.yaml, but this worktree still has SpecGit private state ({}). The declaration was probably deleted, for example by a commit that untracked it; checks fail closed instead of treating the worktree as uninitialized.",
            root.display(),
            state.markers().join(", ")
        ),
        "Restore .specgit.yaml from a backup (outside the agent edit hook), or recreate it with specgit init --config-file <original declaration> so its rules are unchanged, then retry. To retire this worktree's integration, restore the declaration first and then run specgit remove.",
    )
}

/// `Some(diagnostic)` when the declaration is missing while this worktree is initialized.
pub async fn declaration_lost(
    process: &Process,
    root: &Path,
) -> Result<Option<Diagnostic>, Diagnostic> {
    if super::snapshot(root)?.bytes.is_some() {
        return Ok(None);
    }
    let state = private_state(&private_root(process, root).await?)?;
    Ok(state
        .is_initialized()
        .then(|| lost_declaration(root, &state)))
}

/// One linked worktree of the current repository.
#[derive(Debug, Clone)]
pub struct Worktree {
    pub root: PathBuf,
    pub private_root: PathBuf,
    pub hooks: PathBuf,
}

/// A sibling worktree that still relies on shared exclusion or hook assets.
#[derive(Debug, Clone, Serialize)]
pub struct Consumer {
    pub root: PathBuf,
    pub declaration_sha256: Option<String>,
    pub private_state: Vec<&'static str>,
    #[serde(skip)]
    pub hooks: PathBuf,
}

fn same(a: &Path, b: &Path) -> bool {
    a == b || matches!((a.canonicalize(), b.canonicalize()), (Ok(a), Ok(b)) if a == b)
}

/// Every other existing, non-bare worktree of this repository.
pub async fn siblings(process: &Process, root: &Path) -> Result<Vec<Worktree>, Diagnostic> {
    let list = project::git(process, root, &["worktree", "list", "--porcelain", "-z"]).await?;
    let mut records: Vec<(PathBuf, bool)> = vec![];
    for field in list.split(|b| *b == 0) {
        if let Some(raw) = field.strip_prefix(b"worktree ") {
            if records.len() >= WORKTREE_LIMIT {
                return Err(Diagnostic::input(&format!(
                    "Worktree discovery exceeds {WORKTREE_LIMIT} worktrees."
                )));
            }
            let path = PathBuf::from(
                std::str::from_utf8(raw)
                    .map_err(|_| Diagnostic::input("Invalid worktree path."))?,
            );
            safe_path(&path)?;
            records.push((path, false));
        } else if (field == b"bare" || field.starts_with(b"prunable"))
            && let Some(last) = records.last_mut()
        {
            last.1 = true;
        }
    }
    let mut worktrees = vec![];
    for (path, skipped) in records {
        // A bare entry has no checkout; a prunable or missing one cannot consume assets.
        if skipped || !path.is_dir() || same(&path, root) {
            continue;
        }
        worktrees.push(Worktree {
            private_root: private_root(process, &path).await?,
            hooks: hooks(process, &path).await?,
            root: path,
        });
    }
    Ok(worktrees)
}

/// Siblings that keep a declaration (even invalid or legacy) or initialized private state.
/// They keep the shared `info/exclude` block and shared hook blocks in use.
pub async fn sibling_consumers(
    process: &Process,
    root: &Path,
) -> Result<Vec<Consumer>, Diagnostic> {
    let mut consumers = vec![];
    for sibling in siblings(process, root).await? {
        let pointer = super::snapshot(&sibling.root)?;
        let state = private_state(&sibling.private_root)?;
        if pointer.bytes.is_some() || state.is_initialized() {
            consumers.push(Consumer {
                declaration_sha256: pointer.digest(),
                private_state: state.markers(),
                hooks: sibling.hooks,
                root: sibling.root,
            });
        }
    }
    Ok(consumers)
}

/// True when the consumer resolves the same effective hook directory.
pub fn shares_hooks(consumer: &Consumer, hooks: &Path) -> bool {
    same(&consumer.hooks, hooks)
}

/// Roll back an init or migrate journal while keeping the worktree-shared
/// `info/exclude` file when a sibling worktree still relies on its block.
/// Retained paths are reported with the consumers that keep them in use.
pub async fn rollback(
    store: &AssetStore,
    process: &Process,
    root: &Path,
    exclude: &Path,
    id: &str,
) -> Result<(Applied, Value), Diagnostic> {
    let consumers = sibling_consumers(process, root).await?;
    let retain = if consumers.is_empty() {
        vec![]
    } else {
        vec![exclude.to_owned()]
    };
    let (applied, retained) = store.rollback_retaining(id, &retain)?;
    let retained: Vec<_> = retained
        .iter()
        .map(|path| json!({"path":path,"reason":"shared_initialized_worktree","shared_consumers":consumers}))
        .collect();
    Ok((applied, json!(retained)))
}
