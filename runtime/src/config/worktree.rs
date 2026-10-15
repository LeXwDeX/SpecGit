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
use std::{
    io::Read,
    path::{Component, Path, PathBuf},
};

/// Files that exist only after `init`, `migrate` or an Issue checkpoint wrote
/// this worktree's state. Setup-only receipts do not prove initialization, and a
/// guard receipt alone may be retained for shared hooks after removal.
pub const INITIALIZED_MARKERS: [&str; 3] =
    ["guidance.json", "local-routing.json", "selection.json"];
/// Integration receipts reported for context; they do not prove initialization.
pub const RECEIPT_MARKERS: [&str; 3] = [
    "guard-hooks.json",
    "setup-guard-hooks.json",
    "agent-assets/ownership.json",
];
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
    let path = text
        .strip_suffix('\n')
        .ok_or_else(|| Diagnostic::input(&format!("Git returned an unterminated {what} path.")))?;
    #[cfg(windows)]
    let path = path.strip_suffix('\r').unwrap_or(path);
    Ok(PathBuf::from(path))
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

fn metadata_bytes(path: &Path, what: &str) -> Result<Vec<u8>, Diagnostic> {
    safe_path(path)?;
    let file = crate::assets::open_regular(path)
        .map_err(|_| Diagnostic::input(&format!("Git {what} cannot be read.")))?;
    let mut bytes = Vec::new();
    file.take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| Diagnostic::input(&format!("Git {what} cannot be read.")))?;
    if bytes.len() > 4096 {
        return Err(Diagnostic::input(&format!("Git {what} is too large.")));
    }
    Ok(bytes)
}

fn protocol_line<'a>(bytes: &'a [u8], what: &str) -> Result<&'a str, Diagnostic> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| Diagnostic::input(&format!("Git {what} is not UTF-8.")))?;
    let line = text.strip_suffix('\n').unwrap_or(text);
    #[cfg(windows)]
    let line = line.strip_suffix('\r').unwrap_or(line);
    Ok(line)
}

fn metadata_path(path: &Path) -> Result<PathBuf, Diagnostic> {
    let bytes = metadata_bytes(path, "worktree metadata")?;
    let path = PathBuf::from(protocol_line(&bytes, "worktree metadata")?);
    if path.as_os_str().is_empty() {
        return Err(Diagnostic::input(
            "Git worktree metadata has an empty path.",
        ));
    }
    Ok(path)
}

// Git writes legitimate relative paths such as ../.. in commondir. Inspect
// every prefix before folding traversal so a symlink/.. boundary stays visible.
fn safe_git_path(path: &Path) -> Result<PathBuf, Diagnostic> {
    if !path.is_absolute() {
        return Err(Diagnostic::input("Git metadata path is not absolute."));
    }
    let mut resolved = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                resolved.push(component.as_os_str());
                if resolved.is_absolute() {
                    safe_path(&resolved)?;
                }
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if !resolved.pop() || !resolved.is_absolute() {
                    return Err(Diagnostic::input("Git metadata path escapes its root."));
                }
            }
        }
    }
    safe_path(&resolved)?;
    Ok(resolved)
}

fn git_dir(root: &Path) -> Result<Option<PathBuf>, Diagnostic> {
    let marker = root.join(".git");
    let metadata = match std::fs::symlink_metadata(&marker) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(Diagnostic::input(
                "Git worktree marker cannot be inspected.",
            ));
        }
    };
    if metadata.is_dir() {
        return Ok(Some(marker.canonicalize().map_err(|_| {
            Diagnostic::input("Git directory cannot be resolved.")
        })?));
    }
    if !metadata.is_file() {
        return Err(Diagnostic::input(
            "Git worktree marker is not a file or directory.",
        ));
    }
    let bytes = metadata_bytes(&marker, "worktree marker")?;
    let path = protocol_line(&bytes, "worktree marker")?
        .strip_prefix("gitdir: ")
        .ok_or_else(|| Diagnostic::input("Git worktree marker is malformed."))?;
    let path = Path::new(path);
    let path = if path.is_absolute() {
        path.to_owned()
    } else {
        root.join(path)
    };
    let path = safe_git_path(&path)?;
    Ok(Some(path.canonicalize().map_err(|_| {
        Diagnostic::input("Git directory cannot be resolved.")
    })?))
}

fn common_dir(root: &Path) -> Result<Option<PathBuf>, Diagnostic> {
    let Some(git_dir) = git_dir(root)? else {
        return Ok(None);
    };
    let marker = git_dir.join("commondir");
    let common = if present(&marker)? {
        let path = metadata_path(&marker)?;
        if path.is_absolute() {
            path
        } else {
            git_dir.join(path)
        }
    } else {
        git_dir
    };
    let common = safe_git_path(&common)?;
    let common = common
        .canonicalize()
        .map_err(|_| Diagnostic::input("Git common directory cannot be resolved."))?;
    safe_path(&common)?;
    Ok(Some(common))
}

/// Reject an executable under any checkout linked to this repository.
/// Missing Git markers in simple fixture projects retain the caller's root-only check.
pub fn source_in_same_repository_checkout(source: &Path, root: &Path) -> Result<bool, Diagnostic> {
    let Some(common) = common_dir(root)? else {
        return Ok(false);
    };
    let source = source
        .canonicalize()
        .map_err(|_| Diagnostic::input("Shared executable cannot be resolved."))?;
    for ancestor in source.ancestors().skip(1) {
        if let Some(candidate) = common_dir(ancestor)?
            && candidate == common
        {
            return Ok(true);
        }
    }
    let registry = common.join("worktrees");
    if !present(&registry)? {
        return Ok(false);
    }
    let entries = std::fs::read_dir(&registry)
        .map_err(|_| Diagnostic::input("Git worktree registry cannot be read."))?;
    for (index, entry) in entries.enumerate() {
        if index >= WORKTREE_LIMIT {
            return Err(Diagnostic::input(
                "Worktree discovery exceeds 64 worktrees.",
            ));
        }
        let entry = entry.map_err(|_| Diagnostic::input("Git worktree registry is incomplete."))?;
        let gitdir = entry.path().join("gitdir");
        let marker = metadata_path(&gitdir)?;
        let marker = if marker.is_absolute() {
            marker
        } else {
            entry.path().join(marker)
        };
        let marker = safe_git_path(&marker)?;
        let Some(checkout) = marker.parent() else {
            return Err(Diagnostic::input("Git worktree path is malformed."));
        };
        if !present(checkout)? {
            continue;
        } // Prunable worktree cannot contain a runnable source.
        let checkout = checkout
            .canonicalize()
            .map_err(|_| Diagnostic::input("Git worktree path cannot be resolved."))?;
        if source.starts_with(checkout) {
            return Ok(true);
        }
    }
    Ok(false)
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

/// Siblings that keep a declaration (even invalid or legacy) or selected integration state.
/// This compatibility view includes either asset kind; retirement uses the specific views below.
pub async fn sibling_consumers(
    process: &Process,
    root: &Path,
) -> Result<Vec<Consumer>, Diagnostic> {
    consumers_for(process, root, SharedAsset::Any).await
}

/// Siblings that still need shared native Git hooks.
pub async fn sibling_hook_consumers(
    process: &Process,
    root: &Path,
) -> Result<Vec<Consumer>, Diagnostic> {
    consumers_for(process, root, SharedAsset::Hooks).await
}

/// Siblings that still need the shared declaration and Skill exclusions.
pub async fn sibling_exclusion_consumers(
    process: &Process,
    root: &Path,
) -> Result<Vec<Consumer>, Diagnostic> {
    consumers_for(process, root, SharedAsset::Exclusions).await
}

enum SharedAsset {
    Any,
    Hooks,
    Exclusions,
}

async fn consumers_for(
    process: &Process,
    root: &Path,
    asset: SharedAsset,
) -> Result<Vec<Consumer>, Diagnostic> {
    let mut consumers = vec![];
    for sibling in siblings(process, root).await? {
        let pointer = super::snapshot(&sibling.root)?;
        let state = private_state(&sibling.private_root)?;
        let initialized = pointer.bytes.is_some() || state.is_initialized();
        let consumes = initialized
            || match asset {
                SharedAsset::Any => !state.receipts.is_empty(),
                SharedAsset::Exclusions => state.receipts.contains(&"agent-assets/ownership.json"),
                SharedAsset::Hooks => {
                    state
                        .receipts
                        .iter()
                        .any(|name| matches!(*name, "guard-hooks.json" | "setup-guard-hooks.json"))
                        || setup_guard_demand(
                            crate::assets::Snapshot::read(
                                &sibling.private_root.join("agent-assets/ownership.json"),
                            )?
                            .bytes
                            .as_deref(),
                            &sibling.root,
                        )?
                }
            };
        if consumes {
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

/// Validate the complete setup receipt before determining active native guard demand.
pub(crate) fn setup_guard_demand(bytes: Option<&[u8]>, root: &Path) -> Result<bool, Diagnostic> {
    let Some(bytes) = bytes else {
        return Ok(false);
    };
    let demand = crate::project_receipt::decode(bytes)?;
    let actual = root
        .canonicalize()
        .map_err(|_| Diagnostic::input("The setup guard consumer root cannot be resolved."))?;
    if demand.root.canonicalize().ok().as_ref() != Some(&actual) {
        return Err(Diagnostic::input(
            "The setup guard consumer belongs to another root; preserve its hooks.",
        ));
    }
    Ok(demand
        .purposes
        .values()
        .any(|purposes| purposes.contains(&crate::project_receipt::HookPurpose::Guard)))
}

/// Shared serialization for native Git hook ownership across linked worktrees.
pub async fn native_guard_lock(process: &Process, root: &Path) -> Result<PathBuf, Diagnostic> {
    let common = git_line(
        project::git(
            process,
            root,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )
        .await?,
        "common metadata",
    )?;
    Ok(common.join("specgit-v2/native-guard-lock"))
}

/// Preserve the selected rollback boundaries while accepting Windows' ordinary
/// and canonical spellings of the same existing directories. No new directory
/// or journal-provided root can enter the authorization set.
pub fn rollback_allowed_roots(selected: &[PathBuf]) -> Result<Vec<PathBuf>, Diagnostic> {
    for directory in selected {
        crate::assets::safe_path(directory)?;
    }
    #[cfg(windows)]
    {
        let mut roots = selected.to_vec();
        for directory in selected {
            if directory.try_exists().map_err(|_| {
                Diagnostic::input("A selected rollback root cannot be inspected safely.")
            })? {
                let canonical = directory.canonicalize().map_err(|_| {
                    Diagnostic::input("A selected rollback root cannot be resolved safely.")
                })?;
                crate::assets::safe_path(&canonical)?;
                if let Some(ordinary) = crate::assets::ordinary_windows_path(&canonical) {
                    crate::assets::safe_path(&ordinary)?;
                    if ordinary.canonicalize().map_err(|_| {
                        Diagnostic::input("A rollback alias cannot be resolved safely.")
                    })? != canonical
                    {
                        return Err(Diagnostic::input(
                            "A rollback alias no longer names the selected directory.",
                        ));
                    }
                    if !roots.contains(&ordinary) {
                        roots.push(ordinary);
                    }
                }
                if !roots.contains(&canonical) {
                    roots.push(canonical);
                }
            }
        }
        Ok(roots)
    }
    #[cfg(not(windows))]
    {
        Ok(selected.to_vec())
    }
}

/// Read-only proof roots in the fixed, bounded shared custody namespace.
/// Git metadata resolution supplies the root; receipts cannot name extra stores.
pub(crate) fn shared_setup_guard_stores(root: &Path) -> Result<Vec<PathBuf>, Diagnostic> {
    let Some(common) = common_dir(root)? else {
        return Ok(vec![]);
    };
    let namespace = common.join("specgit-v2/shared-setup-guard");
    crate::assets::safe_path(&namespace)?;
    if !namespace
        .try_exists()
        .map_err(|_| Diagnostic::input("Shared guard histories cannot be inspected."))?
    {
        return Ok(vec![]);
    }
    let mut stores = Vec::new();
    for (index, entry) in std::fs::read_dir(namespace)
        .map_err(|_| Diagnostic::input("Shared guard histories cannot be read."))?
        .enumerate()
    {
        if index >= 128 {
            return Err(Diagnostic::input(
                "Shared guard history inventory exceeds its bound.",
            ));
        }
        let path = entry
            .map_err(|_| Diagnostic::input("A shared guard history cannot be read."))?
            .path();
        let Some(name) = path.file_name().and_then(|v| v.to_str()) else {
            continue;
        };
        if name.len() == 64 && name.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            crate::assets::safe_path(&path)?;
            stores.push(path.join("assets"));
        }
    }
    Ok(stores)
}

async fn shared_setup_guard_namespace(
    process: &Process,
    root: &Path,
) -> Result<PathBuf, Diagnostic> {
    let common = git_line(
        project::git(
            process,
            root,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )
        .await?,
        "common metadata",
    )?;
    Ok(common.join("specgit-v2/shared-setup-guard"))
}

/// The custody key of one effective hook directory. Every bucket name is
/// derived by this single rule, so recorded receipts can be verified against it.
fn shared_setup_guard_key(hooks: &Path) -> Result<String, Diagnostic> {
    let identity = if hooks
        .try_exists()
        .map_err(|_| Diagnostic::input("The shared hook directory cannot be inspected."))?
    {
        hooks
            .canonicalize()
            .map_err(|_| Diagnostic::input("The shared hook directory cannot be resolved."))?
    } else {
        hooks.to_owned()
    };
    crate::assets::safe_path(&identity)?;
    Ok(crate::assets::hash(identity.as_os_str().as_encoded_bytes()))
}

/// Stable custody for setup-owned hooks after their worktree owner retires.
/// The namespace is bounded to the current effective hook directory.
pub(crate) async fn shared_setup_guard_private(
    process: &Process,
    root: &Path,
) -> Result<PathBuf, Diagnostic> {
    let namespace = shared_setup_guard_namespace(process, root).await?;
    let hooks = hooks(process, root).await?;
    Ok(namespace.join(shared_setup_guard_key(&hooks)?))
}

const CUSTODY_LIMIT: usize = 128;

/// One custody bucket that holds a receipt or a transaction history.
struct CustodyBucket {
    directory: PathBuf,
    receipt: bool,
}

/// Bounded inventory of every custody bucket, independent of the current
/// hook path. Unreadable entries fail closed instead of hiding custody.
fn custody_buckets(namespace: &Path) -> Result<Vec<CustodyBucket>, Diagnostic> {
    crate::assets::safe_path(namespace)?;
    if !namespace
        .try_exists()
        .map_err(|_| Diagnostic::input("Shared guard custody cannot be inspected."))?
    {
        return Ok(vec![]);
    }
    let mut buckets = Vec::new();
    for (index, entry) in std::fs::read_dir(namespace)
        .map_err(|_| Diagnostic::input("Shared guard custody cannot be read."))?
        .enumerate()
    {
        if index >= CUSTODY_LIMIT {
            return Err(Diagnostic::input(
                "Shared guard custody inventory exceeds its bound.",
            ));
        }
        let path = entry
            .map_err(|_| Diagnostic::input("A shared guard custody entry cannot be read."))?
            .path();
        let Some(name) = path.file_name().and_then(|v| v.to_str()) else {
            continue;
        };
        if name.len() != 64 || !name.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            continue;
        }
        crate::assets::safe_path(&path)?;
        let receipt = present(&path.join("setup-guard-hooks.json"))?;
        if receipt || present(&path.join("assets/transactions"))? {
            buckets.push(CustodyBucket {
                directory: path,
                receipt,
            });
        }
    }
    buckets.sort_by(|a, b| a.directory.cmp(&b.directory));
    Ok(buckets)
}

fn custody_conflict(message: &str, remedy: &str) -> Diagnostic {
    Diagnostic::new(Code::OwnershipConflict, "git_guard", message, remedy)
}

/// Read a custody receipt, derive the hook directory it records and prove that
/// the bucket name is that directory's custody key.
fn verified_custody_hooks(bucket: &Path) -> Result<(PathBuf, crate::assets::Snapshot), Diagnostic> {
    let path = bucket.join("setup-guard-hooks.json");
    let snapshot = crate::assets::Snapshot::read(&path)?;
    let unverifiable = || {
        custody_conflict(
            &format!(
                "The retained shared setup guard receipt {} cannot be verified.",
                path.display()
            ),
            "Preserve the receipt and its transactions; inspect them before setup, removal or rollback.",
        )
    };
    let value = crate::input::json(
        snapshot.bytes.as_deref().ok_or_else(unverifiable)?,
        1_048_576,
        16,
    )
    .map_err(|_| unverifiable())?;
    let hooks = value
        .get("hooks")
        .and_then(Value::as_object)
        .ok_or_else(unverifiable)?;
    if hooks.len() != 2 {
        return Err(unverifiable());
    }
    let mut directory: Option<PathBuf> = None;
    for stage in ["pre-commit", "pre-push"] {
        let recorded = PathBuf::from(
            hooks
                .get(stage)
                .and_then(|hook| hook.get("path"))
                .and_then(Value::as_str)
                .ok_or_else(unverifiable)?,
        );
        if !recorded.is_absolute() || recorded.file_name().and_then(|n| n.to_str()) != Some(stage) {
            return Err(unverifiable());
        }
        let parent = recorded.parent().ok_or_else(unverifiable)?.to_owned();
        if directory.as_ref().is_some_and(|known| *known != parent) {
            return Err(unverifiable());
        }
        directory = Some(parent);
    }
    let directory = directory.ok_or_else(unverifiable)?;
    let name = bucket.file_name().and_then(|n| n.to_str());
    if name != Some(shared_setup_guard_key(&directory)?.as_str()) {
        return Err(custody_conflict(
            &format!(
                "The shared setup guard custody {} does not match the hook directory {} recorded by its receipt.",
                bucket.display(),
                directory.display()
            ),
            "Preserve the custody directory and its transactions; inspect them before setup, removal or rollback.",
        ));
    }
    Ok((directory, snapshot))
}

/// Retained setup guard custody recorded for another effective hook directory.
pub(crate) struct ForeignCustody {
    pub(crate) directory: PathBuf,
    pub(crate) hooks: PathBuf,
    pub(crate) receipt: PathBuf,
    pub(crate) snapshot: crate::assets::Snapshot,
}

/// Every verified custody receipt whose key differs from the current hook
/// directory's key. Unverifiable receipts are conflicts, never "no custody".
pub(crate) async fn foreign_setup_guard_custody(
    process: &Process,
    root: &Path,
) -> Result<Vec<ForeignCustody>, Diagnostic> {
    let current = shared_setup_guard_private(process, root).await?;
    let namespace = current
        .parent()
        .ok_or_else(|| Diagnostic::input("Shared guard custody is malformed."))?;
    let mut foreign = Vec::new();
    for bucket in custody_buckets(namespace)? {
        if !bucket.receipt || bucket.directory.file_name() == current.file_name() {
            continue;
        }
        let (hooks, snapshot) = verified_custody_hooks(&bucket.directory)?;
        foreign.push(ForeignCustody {
            receipt: bucket.directory.join("setup-guard-hooks.json"),
            directory: bucket.directory,
            hooks,
            snapshot,
        });
    }
    Ok(foreign)
}

/// Resolve an exact journal in the caller's ordinary stores or any shared
/// custody bucket. Ambiguous IDs never select a history by search order.
/// The returned shared root is the matched bucket's directory, or the current
/// key's bucket for an ordinary store. A journal retained for another hook
/// directory is found but fails closed: rollback safety checks and callers'
/// writable roots are derived from the current hook path.
pub(crate) async fn rollback_store(
    process: &Process,
    root: &Path,
    id: &str,
    local: &[PathBuf],
) -> Result<(PathBuf, PathBuf), Diagnostic> {
    if !id.starts_with("tx-") || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err(Diagnostic::input("Use an exact reported transaction id."));
    }
    let shared = shared_setup_guard_private(process, root).await?;
    let namespace = shared
        .parent()
        .ok_or_else(|| Diagnostic::input("Shared guard custody is malformed."))?;
    let mut candidates: Vec<(PathBuf, Option<PathBuf>)> =
        local.iter().map(|store| (store.clone(), None)).collect();
    candidates.push((shared.join("assets"), Some(shared.clone())));
    for bucket in custody_buckets(namespace)? {
        candidates.push((bucket.directory.join("assets"), Some(bucket.directory)));
    }
    candidates.sort();
    candidates.dedup();
    let mut matching = Vec::new();
    for (store, bucket) in candidates {
        let journal = store.join("transactions").join(id).join("journal.json");
        crate::assets::safe_path(&journal)?;
        if journal
            .try_exists()
            .map_err(|_| Diagnostic::input("The rollback journal cannot be inspected."))?
        {
            matching.push((store, bucket));
        }
    }
    if matching.len() != 1 {
        return Err(Diagnostic::input(
            "Use an exact, unique local or shared-custody transaction id; missing or duplicate histories require inspection.",
        ));
    }
    let (store, bucket) = matching.remove(0);
    let Some(bucket) = bucket else {
        return Ok((store, shared));
    };
    if bucket.file_name() != shared.file_name() {
        let recorded = if present(&bucket.join("setup-guard-hooks.json"))? {
            let (hooks, _) = verified_custody_hooks(&bucket)?;
            format!(
                " Its receipt records the hook directory {}.",
                hooks.display()
            )
        } else {
            String::new()
        };
        return Err(Diagnostic::new(
            Code::RollbackConflict,
            "rollback",
            &format!(
                "Transaction {id} is recorded in shared setup guard custody {} for a different effective hook directory than the current core.hooksPath.{recorded}",
                bucket.display()
            ),
            &format!(
                "Restore core.hooksPath to the hook directory that transaction {id} changed, then retry the exact rollback; the journal and its custody were preserved."
            ),
        ));
    }
    Ok((store, bucket))
}

/// A native serialization lock acquired before any transaction-store lock.
pub struct NativeGuardLock {
    _store: AssetStore,
    path: PathBuf,
}

pub async fn lock_native_guard(
    process: &Process,
    root: &Path,
) -> Result<NativeGuardLock, Diagnostic> {
    let path = native_guard_lock(process, root).await?;
    #[cfg(feature = "test-fixtures")]
    if let Some(marker) = std::env::var_os("SPECGIT_FIXTURE_NATIVE_LOCK_READY") {
        std::fs::write(marker, b"ready")
            .map_err(|_| Diagnostic::input("Native lock fixture marker is unavailable."))?;
    }
    Ok(NativeGuardLock {
        path: path.clone(),
        _store: AssetStore::lock(
            &path,
            std::slice::from_ref(&path),
            std::time::Duration::from_secs(2),
        )?,
    })
}

/// Compatibility entry point. A prelocked store cannot establish the required
/// native-guard-before-assets order; callers must use the typed locked API.
pub async fn rollback(
    _store: &AssetStore,
    _process: &Process,
    _root: &Path,
    _exclude: &Path,
    _id: &str,
) -> Result<(Applied, Value), Diagnostic> {
    Err(Diagnostic::input(
        "Acquire lock_native_guard before the asset store, then use rollback_with_lock; the prelocked compatibility entry cannot safely establish rollback lock order.",
    ))
}

/// Bounded witness of the linked-worktree registry (`<common>/worktrees`).
/// Git adds an entry there when a checkout is registered, before its files
/// are checked out, so a changed listing means the consumer scan is stale.
struct WorktreeInventory {
    path: PathBuf,
    entries: Vec<std::ffi::OsString>,
}
impl WorktreeInventory {
    const LIMIT: usize = 1024;
    fn read(path: PathBuf) -> Result<Self, Diagnostic> {
        let unreadable = || {
            Diagnostic::new(
                Code::RollbackConflict,
                "rollback",
                "The Git worktree inventory is unreadable.",
                "Inspect the repository's linked worktrees, then retry the exact rollback; no rollback target was changed.",
            )
        };
        let mut entries = Vec::new();
        match std::fs::read_dir(&path) {
            Ok(directory) => {
                for entry in directory.take(Self::LIMIT + 1) {
                    entries.push(entry.map_err(|_| unreadable())?.file_name());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(unreadable()),
        }
        if entries.len() > Self::LIMIT {
            return Err(Diagnostic::new(
                Code::RollbackConflict,
                "rollback",
                "The Git worktree inventory exceeds its bounded limit.",
                "Prune unused linked worktrees, then retry the exact rollback; no rollback target was changed.",
            ));
        }
        entries.sort();
        Ok(Self { path, entries })
    }
    fn verify(&self) -> Result<(), Diagnostic> {
        if Self::read(self.path.clone())?.entries != self.entries {
            return Err(Diagnostic::new(
                Code::RollbackConflict,
                "rollback",
                "The Git worktree inventory changed after rollback planning.",
                "Retry the exact rollback so shared consumers are rescanned; this attempt restored nothing and kept the journal.",
            ));
        }
        Ok(())
    }
}

/// Roll back with native serialization held before the transaction-store lock.
/// Shared consumers and current ownership are rechecked under both locks.
pub async fn rollback_with_lock(
    serialization: &NativeGuardLock,
    store: &AssetStore,
    process: &Process,
    root: &Path,
    exclude: &Path,
    id: &str,
) -> Result<(Applied, Value), Diagnostic> {
    if native_guard_lock(process, root).await? != serialization.path {
        return Err(Diagnostic::input(
            "The native guard lock belongs to another repository.",
        ));
    }
    // `git worktree add` registers its checkout without SpecGit's lock.
    // Witness the registry before the consumer scan and require it unchanged
    // under the lock and before every rollback write.
    let inventory = WorktreeInventory::read(
        serialization
            .path
            .parent()
            .and_then(Path::parent)
            .ok_or_else(|| Diagnostic::input("The native guard lock path is malformed."))?
            .join("worktrees"),
    )?;
    let consumers = sibling_consumers(process, root).await?;
    let hook_consumers = sibling_hook_consumers(process, root).await?;
    let mut retain = if sibling_exclusion_consumers(process, root).await?.is_empty() {
        vec![]
    } else {
        vec![exclude.to_owned()]
    };
    let hook_root = hooks(process, root).await?;
    let private = private_root(process, root).await?;
    let setup_receipt = private.join("agent-assets/ownership.json");
    let setup_after = match store.rollback_content(id, &setup_receipt)? {
        Some(content) => content,
        None => crate::assets::Snapshot::read(&setup_receipt)?.bytes,
    };
    let current_setup_consumer = setup_guard_demand(setup_after.as_deref(), root)?;
    let installed_guard = ["pre-commit", "pre-push"]
        .iter()
        .map(|stage| crate::assets::Snapshot::read(&hook_root.join(stage)))
        .collect::<Result<Vec<_>, _>>()?
        .iter()
        .any(|snapshot| {
            snapshot.bytes.as_deref().is_some_and(|bytes| {
                bytes
                    .windows(b"specgit-v2:pre-".len())
                    .any(|part| part == b"specgit-v2:pre-")
            })
        });
    // A source-transfer rollback may restore the original owner without losing
    // either hook. Permit that recovery while retaining genuinely destructive
    // rollbacks that would remove a consumer's only guard.
    let mut restores_source = false;
    let mut source_count = 0;
    let shared_source = shared_setup_guard_private(process, root)
        .await?
        .join("setup-guard-hooks.json");
    let source_paths = [
        private.join("guard-hooks.json"),
        private.join("setup-guard-hooks.json"),
        shared_source,
    ];
    for path in &source_paths {
        let target = store.rollback_content(id, path)?;
        restores_source |= matches!(&target, Some(Some(_)));
        let bytes = match target {
            Some(bytes) => bytes,
            None => crate::assets::Snapshot::read(path)?.bytes,
        };
        source_count += usize::from(bytes.is_some());
    }
    let mut preserves_hooks = true;
    for stage in ["pre-commit", "pre-push"] {
        let path = hook_root.join(stage);
        let target = match store.rollback_content(id, &path)? {
            Some(bytes) => bytes,
            None => crate::assets::Snapshot::read(&path)?.bytes,
        };
        preserves_hooks &= target.as_deref().is_some_and(|bytes| {
            bytes
                .windows(b"specgit guard --stage ".len())
                .any(|part| part == b"specgit guard --stage ")
        });
    }
    let restores_complete_source = restores_source && source_count == 1 && preserves_hooks;
    if installed_guard
        && !restores_complete_source
        && (current_setup_consumer
            || hook_consumers
                .iter()
                .any(|consumer| shares_hooks(consumer, &hook_root)))
    {
        retain.extend([hook_root.join("pre-commit"), hook_root.join("pre-push")]);
        retain.extend(source_paths);
    }
    inventory.verify()?;
    let (applied, retained) =
        store.rollback_retaining_checked(id, &retain, &|| inventory.verify())?;
    let retained: Vec<_> = retained
        .iter()
        .map(|path| json!({"path":path,"reason":if current_setup_consumer {"setup_guard_purpose"}else{"shared_initialized_worktree"},"shared_consumers":consumers}))
        .collect();
    Ok((applied, json!(retained)))
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::safe_git_path;
    use super::{git_dir, metadata_path};
    use std::{fs, path::Path};

    #[test]
    fn metadata_read_is_bounded_and_preserves_path_newline() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let marker = base.join("gitdir");
        fs::write(&marker, b"/checkout/ends-with-newline\n\n").unwrap();
        assert_eq!(
            metadata_path(&marker).unwrap(),
            Path::new("/checkout/ends-with-newline\n")
        );
        fs::write(&marker, vec![b'a'; 4097]).unwrap();
        assert!(
            metadata_path(&marker)
                .unwrap_err()
                .message
                .contains("too large")
        );

        let root = base.join("checkout");
        fs::create_dir(&root).unwrap();
        fs::write(root.join(".git"), vec![b'a'; 4097]).unwrap();
        assert!(git_dir(&root).unwrap_err().message.contains("too large"));
    }

    #[test]
    fn custody_receipt_must_name_its_own_bucket_key() {
        use super::{custody_buckets, shared_setup_guard_key, verified_custody_hooks};
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let hooks = base.join("hooks");
        fs::create_dir(&hooks).unwrap();
        let receipt = serde_json::to_vec(&serde_json::json!({
            "version": 2,
            "hooks": {
                "pre-commit": {"path": hooks.join("pre-commit")},
                "pre-push": {"path": hooks.join("pre-push")},
            }
        }))
        .unwrap();
        let namespace = base.join("shared-setup-guard");
        let good = namespace.join(shared_setup_guard_key(&hooks).unwrap());
        let wrong = namespace.join("0".repeat(64));
        let history = namespace.join("f".repeat(64));
        for bucket in [&good, &wrong] {
            fs::create_dir_all(bucket).unwrap();
            fs::write(bucket.join("setup-guard-hooks.json"), &receipt).unwrap();
        }
        fs::create_dir_all(history.join("assets/transactions")).unwrap();
        fs::create_dir_all(namespace.join("not-a-key")).unwrap();
        fs::create_dir_all(namespace.join("e".repeat(64))).unwrap();
        let found: Vec<_> = custody_buckets(&namespace)
            .unwrap()
            .into_iter()
            .map(|b| (b.directory, b.receipt))
            .collect();
        let mut expected = vec![
            (wrong.clone(), true),
            (history, false),
            (good.clone(), true),
        ];
        expected.sort();
        assert_eq!(found, expected);
        assert_eq!(verified_custody_hooks(&good).unwrap().0, hooks);
        assert!(
            verified_custody_hooks(&wrong)
                .unwrap_err()
                .message
                .contains("does not match")
        );
        fs::write(good.join("setup-guard-hooks.json"), b"{}").unwrap();
        assert!(
            verified_custody_hooks(&good)
                .unwrap_err()
                .message
                .contains("cannot be verified")
        );
    }

    #[cfg(unix)]
    #[test]
    fn relative_git_path_checks_symlink_before_folding_parent() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let root = base.as_path();
        fs::create_dir(root.join("real")).unwrap();
        symlink(root.join("real"), root.join("link")).unwrap();
        assert!(safe_git_path(&root.join("link/../real")).is_err());
        assert_eq!(
            safe_git_path(&root.join("real/../real")).unwrap(),
            root.join("real")
        );
    }
}
