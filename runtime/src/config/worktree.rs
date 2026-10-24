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

struct WorktreeRecord {
    path: PathBuf,
    prunable: bool,
    skipped: bool,
}

fn worktree_records(list: Vec<u8>) -> Result<Vec<WorktreeRecord>, Diagnostic> {
    let mut records: Vec<WorktreeRecord> = vec![];
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
            records.push(WorktreeRecord {
                path,
                prunable: false,
                skipped: false,
            });
        } else if (field == b"bare" || field.starts_with(b"prunable"))
            && let Some(last) = records.last_mut()
        {
            last.skipped = true;
            last.prunable |= field.starts_with(b"prunable");
        }
    }
    Ok(records)
}

async fn prunable_checkouts(process: &Process, root: &Path) -> Result<Vec<PathBuf>, Diagnostic> {
    let list = project::git(process, root, &["worktree", "list", "--porcelain", "-z"]).await?;
    Ok(worktree_records(list)?
        .into_iter()
        .filter(|record| record.prunable)
        .map(|record| record.path)
        .collect())
}

/// Every other existing, non-bare worktree of this repository.
pub async fn siblings(process: &Process, root: &Path) -> Result<Vec<Worktree>, Diagnostic> {
    let list = project::git(process, root, &["worktree", "list", "--porcelain", "-z"]).await?;
    let records = worktree_records(list)?;
    let current_private = private_root(process, root).await?;
    let common = common_dir(root)?;
    let mut worktrees = vec![];
    for record in records {
        // A bare entry has no checkout; a prunable or missing one cannot consume assets.
        if record.skipped || !record.path.is_dir() || same(&record.path, root) {
            continue;
        }
        // Submodules may report their own Git metadata directory as a worktree.
        // It is neither a checkout nor an independent consumer.
        if common
            .as_ref()
            .is_some_and(|common| record.path.starts_with(common))
        {
            continue;
        }
        let sibling_private = private_root(process, &record.path).await?;
        if same(&sibling_private, &current_private) {
            continue;
        }
        worktrees.push(Worktree {
            private_root: sibling_private,
            hooks: hooks(process, &record.path).await?,
            root: record.path,
        });
    }
    Ok(worktrees)
}

fn evidence_conflict(message: &str) -> Diagnostic {
    Diagnostic::new(
        Code::RollbackConflict,
        "rollback",
        message,
        "Retry the exact rollback after the sibling worktree and its SpecGit state are readable and stable; this attempt restored nothing and kept the journal.",
    )
}

fn evidence_error(what: &str, path: &Path, cause: Diagnostic) -> Diagnostic {
    evidence_conflict(&format!(
        "{what} at {} cannot be read: {}",
        path.display(),
        cause.message
    ))
}

/// Compare permissions the way the owned-asset journal records them. Windows
/// has no Unix mode; the read-only flag remains the material bit there.
fn permission_signature(permissions: Option<&std::fs::Permissions>) -> (Option<bool>, Option<u32>) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        (
            permissions.map(std::fs::Permissions::readonly),
            permissions.map(|permissions| permissions.mode() & 0o7777),
        )
    }
    #[cfg(not(unix))]
    {
        (permissions.map(std::fs::Permissions::readonly), None)
    }
}

fn same_snapshot(expected: &crate::assets::Snapshot, actual: &crate::assets::Snapshot) -> bool {
    expected.bytes == actual.bytes
        && permission_signature(expected.permissions.as_ref())
            == permission_signature(actual.permissions.as_ref())
}

/// Evidence files are small receipts, not owned assets. Bound their read so a
/// sibling cannot turn a rollback recheck into an unbounded memory operation.
const EVIDENCE_LIMIT: usize = 1_048_576;

fn bounded_snapshot(path: &Path, limit: usize) -> Result<crate::assets::Snapshot, Diagnostic> {
    safe_path(path)?;
    let file = match crate::assets::open_regular(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(crate::assets::Snapshot {
                bytes: None,
                permissions: None,
            });
        }
        Err(_) => return Err(Diagnostic::input("The evidence file cannot be read.")),
        Ok(file) => file,
    };
    let metadata = file
        .metadata()
        .map_err(|_| Diagnostic::input("The evidence metadata cannot be read."))?;
    if !metadata.is_file() || metadata.len() > limit as u64 {
        return Err(Diagnostic::input(
            "The evidence file is too large or not a regular file.",
        ));
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Diagnostic::input("The evidence file cannot be read."))?;
    if bytes.len() > limit {
        return Err(Diagnostic::input("The evidence file is too large."));
    }
    Ok(crate::assets::Snapshot {
        bytes: Some(bytes),
        permissions: Some(metadata.permissions()),
    })
}

fn checkout_marker(root: &Path) -> Result<Option<crate::assets::Snapshot>, Diagnostic> {
    let path = root.join(".git");
    let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
        Diagnostic::new(
            Code::RollbackConflict,
            "rollback",
            &format!(
                "The Git worktree marker {} cannot be inspected ({:?}).",
                path.display(),
                error.kind()
            ),
            "Inspect the checkout, then retry the exact rollback; no rollback target was changed.",
        )
    })?;
    if metadata.is_dir() {
        return Ok(None);
    }
    if !metadata.is_file() {
        return Err(evidence_conflict(
            "A linked checkout marker is not a regular file.",
        ));
    }
    let snapshot = bounded_snapshot(&path, 4096)
        .map_err(|cause| evidence_error("The linked checkout marker", &path, cause))?;
    if snapshot.bytes.is_none() {
        return Err(evidence_conflict(
            "A linked checkout marker disappeared while it was inspected.",
        ));
    }
    Ok(Some(snapshot))
}

/// Native Git metadata that proves an index, reference or configuration
/// operation is active. A registered checkout with such a lock is incomplete.
fn active_git_lock(directory: &Path) -> Result<bool, Diagnostic> {
    for name in ["index.lock", "HEAD.lock", "config.lock"] {
        let path = directory.join(name);
        match std::fs::symlink_metadata(&path) {
            Ok(_) => return Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                return Err(evidence_error(
                    "A Git operation marker",
                    &path,
                    Diagnostic::input("The marker cannot be inspected."),
                ));
            }
        }
    }
    Ok(false)
}

fn private_snapshots(
    private_root: &Path,
) -> Result<Vec<(&'static str, crate::assets::Snapshot)>, Diagnostic> {
    INITIALIZED_MARKERS
        .iter()
        .chain(RECEIPT_MARKERS.iter())
        .map(|name| {
            let path = private_root.join(name);
            bounded_snapshot(&path, EVIDENCE_LIMIT)
                .map(|snapshot| (*name, snapshot))
                .map_err(|cause| evidence_error("SpecGit private worktree state", &path, cause))
        })
        .collect()
}

fn state_from_markers(markers: &[(&'static str, crate::assets::Snapshot)]) -> PrivateState {
    let mut state = PrivateState::default();
    for (name, snapshot) in markers {
        if snapshot.bytes.is_none() {
            continue;
        }
        if INITIALIZED_MARKERS.contains(name) {
            state.initialized.push(name);
        } else {
            state.receipts.push(name);
        }
    }
    state
}

/// Snapshot of one sibling's rollback-relevant state. It is read before the
/// consumer lists are built and rechecked before every rollback write. The
/// current worktree is intentionally absent: rollback changes its own assets.
struct SiblingEvidence {
    root: PathBuf,
    private_root: PathBuf,
    git_dir: PathBuf,
    common: PathBuf,
    hooks: PathBuf,
    declaration: crate::assets::Snapshot,
    state: PrivateState,
    markers: Vec<(&'static str, crate::assets::Snapshot)>,
    commondir: crate::assets::Snapshot,
    git_marker: Option<crate::assets::Snapshot>,
}
impl SiblingEvidence {
    fn initialized(&self) -> bool {
        self.declaration.bytes.is_some() || self.state.is_initialized()
    }
    fn consumes_any(&self) -> bool {
        self.initialized() || !self.state.receipts.is_empty()
    }
    fn consumes_hooks(&self, guard_demand: bool) -> bool {
        self.initialized()
            || self
                .state
                .receipts
                .iter()
                .any(|name| matches!(*name, "guard-hooks.json" | "setup-guard-hooks.json"))
            || guard_demand
    }
    fn consumes_exclusions(&self) -> bool {
        self.initialized() || self.state.receipts.contains(&"agent-assets/ownership.json")
    }
    fn as_consumer(&self) -> Consumer {
        Consumer {
            root: self.root.clone(),
            declaration_sha256: self.declaration.digest(),
            private_state: self.state.markers(),
            hooks: self.hooks.clone(),
        }
    }
    fn verify_active(&self) -> Result<(), Diagnostic> {
        for directory in [&self.git_dir, &self.common] {
            if active_git_lock(directory)? {
                return Err(evidence_conflict(
                    "A Git checkout or configuration operation is active in a sibling worktree.",
                ));
            }
        }
        Ok(())
    }
    fn verify(&self) -> Result<(), Diagnostic> {
        if !self.root.is_dir() {
            return Err(evidence_conflict(
                "A sibling checkout disappeared after rollback planning.",
            ));
        }
        self.verify_active()?;
        let actual_git = git_dir(&self.root)
            .map_err(|cause| evidence_error("The Git directory", &self.root, cause))?;
        let expected_git = self.git_dir.canonicalize().map_err(|_| {
            evidence_conflict("A sibling worktree's Git directory changed after rollback planning.")
        })?;
        if actual_git.as_deref() != Some(expected_git.as_path()) {
            return Err(evidence_conflict(
                "A sibling worktree's Git directory changed after rollback planning.",
            ));
        }
        let actual_common = common_dir(&self.root)
            .map_err(|cause| evidence_error("The Git common directory", &self.root, cause))?;
        let expected_common = self.common.canonicalize().map_err(|_| {
            evidence_conflict(
                "A sibling worktree's Git common directory changed after rollback planning.",
            )
        })?;
        if actual_common.as_deref() != Some(expected_common.as_path()) {
            return Err(evidence_conflict(
                "A sibling worktree's Git common directory changed after rollback planning.",
            ));
        }
        let declaration = super::snapshot(&self.root).map_err(|cause| {
            evidence_error("The declaration", &self.root.join(".specgit.yaml"), cause)
        })?;
        if !same_snapshot(&self.declaration, &declaration) {
            return Err(evidence_conflict(
                "A sibling worktree's SpecGit declaration changed after rollback planning.",
            ));
        }
        for (name, expected) in &self.markers {
            let path = self.private_root.join(name);
            let actual = bounded_snapshot(&path, EVIDENCE_LIMIT)
                .map_err(|cause| evidence_error("SpecGit private worktree state", &path, cause))?;
            if !same_snapshot(expected, &actual) {
                return Err(evidence_conflict(
                    "A sibling worktree's SpecGit private state changed after rollback planning.",
                ));
            }
        }
        let commondir =
            bounded_snapshot(&self.git_dir.join("commondir"), EVIDENCE_LIMIT).map_err(|cause| {
                evidence_error(
                    "The Git common-directory link",
                    &self.git_dir.join("commondir"),
                    cause,
                )
            })?;
        if !same_snapshot(&self.commondir, &commondir) {
            return Err(evidence_conflict(
                "A sibling worktree's Git common-directory link changed after rollback planning.",
            ));
        }
        let marker = checkout_marker(&self.root)?;
        if marker.as_ref().map(|snapshot| {
            (
                &snapshot.bytes,
                permission_signature(snapshot.permissions.as_ref()),
            )
        }) != self.git_marker.as_ref().map(|snapshot| {
            (
                &snapshot.bytes,
                permission_signature(snapshot.permissions.as_ref()),
            )
        }) {
            return Err(evidence_conflict(
                "A sibling worktree's checkout identity changed after rollback planning.",
            ));
        }
        // The stored paths are derived from the Git directory. If that
        // directory moved without changing the checkout marker, its private
        // state is no longer at the observed location.
        if !self.private_root.is_dir()
            && self
                .markers
                .iter()
                .any(|(_, snapshot)| snapshot.bytes.is_some())
        {
            return Err(evidence_conflict(
                "A sibling worktree's private state directory disappeared after rollback planning.",
            ));
        }
        Ok(())
    }
}

/// One consumer scan plus the evidence needed to recheck it before every
/// rollback write. `siblings()` runs once so all three views see one state.
struct SharedScan {
    common: PathBuf,
    consumers: Vec<Consumer>,
    hook_consumers: Vec<Consumer>,
    exclusion_consumers: Vec<Consumer>,
    observations: Vec<SiblingEvidence>,
}

async fn scan_shared(process: &Process, root: &Path) -> Result<SharedScan, Diagnostic> {
    let siblings = siblings(process, root)
        .await
        .map_err(|cause| evidence_error("The shared worktree inventory", root, cause))?;
    let common = common_dir(root)
        .map_err(|cause| evidence_error("The Git common directory", root, cause))?
        .ok_or_else(|| evidence_conflict("The Git common directory is unavailable."))?;
    let mut scan = SharedScan {
        common: common.clone(),
        consumers: vec![],
        hook_consumers: vec![],
        exclusion_consumers: vec![],
        observations: vec![],
    };
    for sibling in siblings {
        let declaration = super::snapshot(&sibling.root).map_err(|cause| {
            evidence_error(
                "The declaration",
                &sibling.root.join(".specgit.yaml"),
                cause,
            )
        })?;
        let markers = private_snapshots(&sibling.private_root)?;
        let state = state_from_markers(&markers);
        let ownership = markers
            .iter()
            .find(|(name, _)| *name == "agent-assets/ownership.json")
            .and_then(|(_, snapshot)| snapshot.bytes.as_deref());
        let guard_demand = setup_guard_demand(ownership, &sibling.root).map_err(|cause| {
            evidence_error(
                "The setup guard demand",
                &sibling.private_root.join("agent-assets/ownership.json"),
                cause,
            )
        })?;
        let git_dir = sibling
            .private_root
            .parent()
            .ok_or_else(|| evidence_conflict("A sibling's Git directory is malformed."))?
            .to_owned();
        let commondir =
            bounded_snapshot(&git_dir.join("commondir"), EVIDENCE_LIMIT).map_err(|cause| {
                evidence_error(
                    "The Git common-directory link",
                    &git_dir.join("commondir"),
                    cause,
                )
            })?;
        let git_marker = checkout_marker(&sibling.root)?;
        let evidence = SiblingEvidence {
            root: sibling.root,
            private_root: sibling.private_root,
            git_dir,
            common: common.clone(),
            hooks: sibling.hooks,
            declaration,
            state,
            markers,
            commondir,
            git_marker,
        };
        evidence.verify_active()?;
        if evidence.consumes_any() {
            scan.consumers.push(evidence.as_consumer());
        }
        if evidence.consumes_hooks(guard_demand) {
            scan.hook_consumers.push(evidence.as_consumer());
        }
        if evidence.consumes_exclusions() {
            scan.exclusion_consumers.push(evidence.as_consumer());
        }
        scan.observations.push(evidence);
    }
    Ok(scan)
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

/// Unfinished transactions in every shared custody bucket, including buckets
/// whose receipt was already removed by an interrupted transaction. Unreadable
/// or malformed journals are errors, never "nothing pending".
pub(crate) fn pending_custody_transactions(
    namespace: &Path,
) -> Result<Vec<(PathBuf, Vec<String>)>, Diagnostic> {
    let mut pending = Vec::new();
    for bucket in custody_buckets(namespace)? {
        let ids = AssetStore::pending_at(&bucket.directory.join("assets"))?;
        if !ids.is_empty() {
            pending.push((bucket.directory, ids));
        }
    }
    Ok(pending)
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

/// One registered linked worktree. Checkout presence is part of the witness:
/// `git worktree add` registers before checking out, and a prunable entry can
/// become an active checkout without changing the registry name set.
#[derive(Debug, PartialEq, Eq)]
struct InventoryEntry {
    name: std::ffi::OsString,
    git_dir: PathBuf,
    checkout: PathBuf,
    checkout_present: bool,
}

/// Bounded witness of the linked-worktree registry (`<common>/worktrees`).
/// Git adds an entry there when a checkout is registered, before its files
/// are checked out, so a changed listing means the consumer scan is stale.
#[derive(Debug)]
struct WorktreeInventory {
    path: PathBuf,
    prunable: Vec<PathBuf>,
    entries: Vec<InventoryEntry>,
}
impl WorktreeInventory {
    const LIMIT: usize = 1024;
    fn read(path: PathBuf, prunable: &[PathBuf]) -> Result<Self, Diagnostic> {
        let unreadable = || {
            Diagnostic::new(
                Code::RollbackConflict,
                "rollback",
                "The Git worktree inventory is unreadable or incomplete.",
                "Inspect the repository's linked worktrees, then retry the exact rollback; no rollback target was changed.",
            )
        };
        let common = path
            .parent()
            .ok_or_else(unreadable)?
            .canonicalize()
            .map_err(|_| unreadable())?;
        let mut entries = Vec::new();
        match std::fs::read_dir(&path) {
            Ok(directory) => {
                for entry in directory.take(Self::LIMIT + 1) {
                    let entry = entry.map_err(|_| unreadable())?;
                    let name = entry.file_name();
                    let marker =
                        metadata_path(&entry.path().join("gitdir")).map_err(|_| unreadable())?;
                    let marker = if marker.is_absolute() {
                        marker
                    } else {
                        entry.path().join(marker)
                    };
                    let checkout_marker = safe_git_path(&marker).map_err(|_| unreadable())?;
                    let checkout = checkout_marker.parent().ok_or_else(unreadable)?.to_owned();
                    safe_path(&checkout).map_err(|_| unreadable())?;
                    let checkout_present = match std::fs::symlink_metadata(&checkout) {
                        Ok(metadata) if metadata.is_dir() => true,
                        Ok(_) => return Err(unreadable()),
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                        Err(_) => return Err(unreadable()),
                    };
                    let prunable = prunable.iter().any(|path| same(path, &checkout));
                    // Git reports a registry entry with a missing checkout as
                    // prunable. A present directory with a prunable marker, a
                    // missing marker or a marker for another Git directory is
                    // not cleanup-safe: it may still hold a declaration.
                    if checkout_present && prunable {
                        return Err(unreadable());
                    }
                    if !checkout_present && !prunable {
                        return Err(unreadable());
                    }
                    if checkout_present {
                        let metadata = std::fs::symlink_metadata(checkout.join(".git"))
                            .map_err(|_| unreadable())?;
                        if !metadata.is_file() {
                            return Err(unreadable());
                        }
                        let actual_git = git_dir(&checkout)
                            .map_err(|_| unreadable())?
                            .ok_or_else(unreadable)?;
                        let expected_git = entry.path().canonicalize().map_err(|_| unreadable())?;
                        if actual_git != expected_git {
                            return Err(unreadable());
                        }
                        let actual_common = common_dir(&checkout)
                            .map_err(|_| unreadable())?
                            .ok_or_else(unreadable)?;
                        if actual_common != common {
                            return Err(unreadable());
                        }
                    }
                    if prunable && active_git_lock(&entry.path()).map_err(|_| unreadable())? {
                        return Err(unreadable());
                    }
                    entries.push(InventoryEntry {
                        name,
                        git_dir: entry.path(),
                        checkout,
                        checkout_present,
                    });
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
        entries.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(Self {
            path,
            prunable: prunable.to_vec(),
            entries,
        })
    }
    fn verify(&self) -> Result<(), Diagnostic> {
        if Self::read(self.path.clone(), &self.prunable)?.entries != self.entries {
            return Err(Diagnostic::new(
                Code::RollbackConflict,
                "rollback",
                "The Git worktree inventory changed after rollback planning.",
                "Retry the exact rollback so shared consumers are rescanned; this attempt restored nothing and kept the journal.",
            ));
        }
        Ok(())
    }
    /// The registry and the consumer scan must cover the same present
    /// checkouts. The main checkout has no registry entry, so it is accepted
    /// only when its Git directory is the common directory.
    fn verify_observed(
        &self,
        root: &Path,
        common: &Path,
        observations: &[SiblingEvidence],
    ) -> Result<(), Diagnostic> {
        for entry in &self.entries {
            if !entry.checkout_present || same(&entry.checkout, root) {
                continue;
            }
            if !observations
                .iter()
                .any(|observation| same(&observation.root, &entry.checkout))
            {
                return Err(evidence_conflict(
                    "A registered checkout disappeared while shared consumers were scanned.",
                ));
            }
        }
        for observation in observations {
            if same(&observation.root, root) || same(&observation.git_dir, common) {
                continue;
            }
            if !self
                .entries
                .iter()
                .any(|entry| entry.checkout_present && same(&entry.checkout, &observation.root))
            {
                return Err(evidence_conflict(
                    "A sibling checkout is not registered in the Git worktree inventory.",
                ));
            }
        }
        Ok(())
    }
}

/// The marker written by the current native guard implementation. A journal
/// target with this marker is a guard hook, not an unrelated user or legacy hook.
fn has_native_guard(bytes: Option<&[u8]>) -> bool {
    bytes.is_some_and(|bytes| {
        bytes
            .windows(b"specgit-v2:pre-".len())
            .any(|part| part == b"specgit-v2:pre-")
    })
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
        &prunable_checkouts(process, root)
            .await
            .map_err(|cause| evidence_error("The shared worktree inventory", root, cause))?,
    )?;
    let shared = scan_shared(process, root).await?;
    inventory.verify_observed(root, &shared.common, &shared.observations)?;
    let mut retain = if shared.exclusion_consumers.is_empty() {
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
        .any(|snapshot| has_native_guard(snapshot.bytes.as_deref()));
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
                .windows(b" guard --stage ".len())
                .any(|part| part == b" guard --stage ")
        });
    }
    let restores_complete_source = restores_source && source_count == 1 && preserves_hooks;
    // The current worktree may point `core.hooksPath` elsewhere after the
    // journal was written. A journal hook target is still the managed guard
    // that an active sibling needs, so retain it without scanning other paths.
    let journal_paths = store.rollback_paths(id)?;
    let journal_hooks: Vec<_> = journal_paths
        .iter()
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| matches!(name, "pre-commit" | "pre-push"))
        })
        .cloned()
        .collect();
    let journal_sources: Vec<_> = journal_paths
        .iter()
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| matches!(name, "guard-hooks.json" | "setup-guard-hooks.json"))
        })
        .cloned()
        .collect();
    let mut native_journal_hooks = Vec::new();
    for path in &journal_hooks {
        let snapshot = crate::assets::Snapshot::read(path)
            .map_err(|cause| evidence_error("A journal hook target", path, cause))?;
        if has_native_guard(snapshot.bytes.as_deref()) {
            native_journal_hooks.push(path.clone());
        }
    }
    if !restores_complete_source
        && (current_setup_consumer || !shared.hook_consumers.is_empty())
        && (installed_guard || !native_journal_hooks.is_empty())
    {
        retain.extend(native_journal_hooks);
        retain.extend(journal_sources);
        retain.extend([hook_root.join("pre-commit"), hook_root.join("pre-push")]);
        retain.extend(source_paths);
    }
    let check = || {
        inventory.verify()?;
        for sibling in &shared.observations {
            sibling.verify()?;
        }
        Ok(())
    };
    check()?;
    let (applied, retained) = store.rollback_retaining_checked(id, &retain, &check)?;
    let retained: Vec<_> = retained
        .iter()
        .map(|path| json!({"path":path,"reason":if current_setup_consumer {"setup_guard_purpose"}else{"shared_initialized_worktree"},"shared_consumers":shared.consumers}))
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

    #[test]
    fn inventory_witnesses_checkout_appearance_without_registry_change() {
        use super::WorktreeInventory;
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let registry = base.join("common/worktrees");
        let entry = registry.join("a");
        let checkout = base.join("checkout");
        fs::create_dir_all(&entry).unwrap();
        fs::create_dir_all(&checkout).unwrap();
        fs::write(
            checkout.join(".git"),
            format!("gitdir: {}\n", entry.display()),
        )
        .unwrap();
        fs::write(
            entry.join("gitdir"),
            format!("{}\n", checkout.join(".git").display()),
        )
        .unwrap();
        fs::write(entry.join("commondir"), b"../..\n").unwrap();
        let before = WorktreeInventory::read(registry.clone(), &[]).unwrap();
        assert_eq!(before.entries.len(), 1);
        assert_eq!(before.entries[0].checkout, checkout);
        assert!(before.entries[0].checkout_present);

        fs::remove_dir_all(&checkout).unwrap();
        let gone =
            WorktreeInventory::read(registry.clone(), std::slice::from_ref(&checkout)).unwrap();
        assert!(!gone.entries[0].checkout_present);
        assert_ne!(before.entries, gone.entries);

        fs::create_dir_all(&checkout).unwrap();
        assert!(
            WorktreeInventory::read(registry.clone(), std::slice::from_ref(&checkout))
                .unwrap_err()
                .message
                .contains("incomplete")
        );
        assert!(
            WorktreeInventory::read(registry.clone(), &[])
                .unwrap_err()
                .message
                .contains("incomplete")
        );
        fs::write(entry.join("index.lock"), b"").unwrap();
        assert!(
            WorktreeInventory::read(registry.clone(), std::slice::from_ref(&checkout))
                .unwrap_err()
                .message
                .contains("incomplete")
        );
        fs::remove_file(entry.join("index.lock")).unwrap();
        fs::write(
            checkout.join(".git"),
            format!("gitdir: {}\n", entry.display()),
        )
        .unwrap();
        assert!(
            WorktreeInventory::read(registry.clone(), std::slice::from_ref(&checkout))
                .unwrap_err()
                .message
                .contains("incomplete")
        );
        let active = WorktreeInventory::read(registry.clone(), &[]).unwrap();
        assert!(active.entries[0].checkout_present);
    }

    fn evidence_for(root: &Path) -> super::SiblingEvidence {
        use super::{checkout_marker, private_snapshots, state_from_markers};
        let git_dir = root.join(".git");
        let private_root = git_dir.join("specgit-v2");
        let declaration = crate::config::snapshot(root).unwrap();
        let markers = private_snapshots(&private_root).unwrap();
        let state = state_from_markers(&markers);
        let commondir = crate::assets::Snapshot::read(&git_dir.join("commondir")).unwrap();
        let git_marker = checkout_marker(root).unwrap();
        super::SiblingEvidence {
            root: root.to_owned(),
            private_root,
            git_dir,
            common: root.join(".git"),
            hooks: root.join("hooks"),
            declaration,
            state,
            markers,
            commondir,
            git_marker,
        }
    }

    #[test]
    fn sibling_evidence_rechecks_declaration_markers_commondir_and_locks() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let root = base.join("checkout");
        fs::create_dir_all(root.join(".git")).unwrap();
        let evidence = evidence_for(&root);
        evidence.verify().unwrap();

        fs::write(root.join(".specgit.yaml"), b"version: 2\n").unwrap();
        assert!(
            evidence
                .verify()
                .unwrap_err()
                .message
                .contains("declaration changed")
        );
        fs::remove_file(root.join(".specgit.yaml")).unwrap();
        fs::create_dir_all(root.join(".git/specgit-v2")).unwrap();
        fs::write(
            root.join(".git/specgit-v2/guidance.json"),
            br#"{"version":1,"blocks":{}}"#,
        )
        .unwrap();
        assert!(
            evidence
                .verify()
                .unwrap_err()
                .message
                .contains("private state changed")
        );
        fs::remove_file(root.join(".git/specgit-v2/guidance.json")).unwrap();
        fs::write(root.join(".git/commondir"), b".\n").unwrap();
        assert!(
            evidence
                .verify()
                .unwrap_err()
                .message
                .contains("common-directory")
        );
        fs::remove_file(root.join(".git/commondir")).unwrap();
        fs::write(root.join(".git/index.lock"), b"").unwrap();
        assert!(evidence.verify().unwrap_err().message.contains("active"));
    }

    #[cfg(unix)]
    #[test]
    fn sibling_evidence_compares_declaration_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let root = base.join("checkout");
        fs::create_dir_all(root.join(".git")).unwrap();
        let declaration = root.join(".specgit.yaml");
        fs::write(&declaration, b"version: 2\n").unwrap();
        fs::set_permissions(&declaration, fs::Permissions::from_mode(0o644)).unwrap();
        let evidence = evidence_for(&root);
        evidence.verify().unwrap();
        fs::set_permissions(&declaration, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(
            evidence
                .verify()
                .unwrap_err()
                .message
                .contains("declaration changed")
        );
    }
}
