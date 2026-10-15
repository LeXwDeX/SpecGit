//! Expected-content transactions for explicitly selected owned assets.
//! The journal retains recoverable preimages; an edit after planning is a conflict.
use crate::diagnostic::{Code, Diagnostic};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions, Permissions, TryLockError},
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};

const FILE_LIMIT: u64 = 134_217_728;
const JOURNAL_LIMIT: usize = 1_048_576;
pub fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
#[cfg(feature = "test-fixtures")]
fn fixture_crash(point: &str) {
    if std::env::var("SPECGIT_FIXTURE_ASSET_CRASH").as_deref() == Ok(point) {
        std::process::exit(99);
    }
}

fn error(code: Code, message: &str) -> Diagnostic {
    Diagnostic::new(
        code,
        "owned_assets",
        message,
        "Keep the existing files. Inspect the reported transaction or refresh the plan before retrying.",
    )
}
fn io_error() -> Diagnostic {
    error(
        Code::IoFailed,
        "The owned-asset filesystem operation failed.",
    )
}

fn filesystem_error(operation: &str, cause: &std::io::Error) -> Diagnostic {
    // Error strings can contain user paths or file contents. Keep only the
    // operation and structured OS classification in machine-readable reports.
    error(
        Code::IoFailed,
        &format!(
            "The owned-asset filesystem operation {operation} failed (kind={:?}, os_code={:?}).",
            cause.kind(),
            cause.raw_os_error()
        ),
    )
}

/// Reject symbolic links at every existing component, including a dangling leaf.
pub fn safe_path(path: &Path) -> Result<(), Diagnostic> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(error(
            Code::UnsafePath,
            "Asset paths must be absolute without traversal.",
        ));
    }
    let mut prefix = PathBuf::new();
    for part in path.components() {
        prefix.push(part.as_os_str());
        // A Windows verbatim drive prefix is not a complete filesystem path
        // until its following root separator has been appended.
        if matches!(part, Component::Prefix(_)) {
            continue;
        }
        match fs::symlink_metadata(&prefix) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(error(
                    Code::UnsafePath,
                    &format!(
                        "A symbolic-link boundary at {:?} prevents this asset operation.",
                        prefix
                    ),
                ));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(filesystem_error("path_metadata", &e)),
        }
    }
    Ok(())
}

#[cfg(windows)]
fn same_missing_asset_path(recorded: &Path, selected: &Path) -> bool {
    if recorded == selected {
        return true;
    }
    // The leaf is absent, so require the same name under the same existing,
    // symlink-free parent. This accepts Windows verbatim/ordinary path aliases
    // without treating a different directory as owned.
    let (Some(recorded_parent), Some(selected_parent)) = (recorded.parent(), selected.parent())
    else {
        return false;
    };
    if recorded.file_name() != selected.file_name()
        || safe_path(recorded).is_err()
        || safe_path(selected).is_err()
    {
        return false;
    }
    matches!(
        (recorded_parent.canonicalize(), selected_parent.canonicalize()),
        (Ok(recorded), Ok(selected)) if recorded == selected
    )
}
/// Open only ordinary files; nonblocking/no-follow also covers a Unix leaf swap.
pub fn open_regular(path: &Path) -> std::io::Result<File> {
    if !fs::symlink_metadata(path)?.file_type().is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Not a regular file",
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Not a regular file",
        ));
    }
    Ok(file)
}

fn ensure_directory(path: &Path) -> Result<(), Diagnostic> {
    safe_path(path)?;
    fs::create_dir_all(path).map_err(|e| filesystem_error("create_directory", &e))?;
    safe_path(path)
}

#[derive(Clone, Debug)]
pub struct Snapshot {
    pub bytes: Option<Vec<u8>>,
    pub permissions: Option<Permissions>,
}
impl Snapshot {
    pub fn read(path: &Path) -> Result<Self, Diagnostic> {
        safe_path(path)?;
        let meta = match fs::symlink_metadata(path) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self {
                    bytes: None,
                    permissions: None,
                });
            }
            Err(e) => return Err(filesystem_error("snapshot_metadata", &e)),
        };
        if !meta.is_file() {
            return Err(error(
                Code::OwnershipConflict,
                "An asset destination is not a regular file.",
            ));
        }
        if meta.len() > FILE_LIMIT {
            return Err(error(
                Code::InputLimit,
                "An asset exceeds the bounded file allowance.",
            ));
        }
        let mut bytes = vec![];
        open_regular(path)
            .map_err(|e| filesystem_error("snapshot_open", &e))?
            .take(FILE_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| filesystem_error("snapshot_read", &e))?;
        if bytes.len() as u64 > FILE_LIMIT {
            return Err(error(
                Code::InputLimit,
                "An asset grew beyond its read allowance.",
            ));
        }
        safe_path(path)?;
        Ok(Self {
            bytes: Some(bytes),
            permissions: Some(meta.permissions()),
        })
    }
    pub fn digest(&self) -> Option<String> {
        self.bytes.as_deref().map(hash)
    }
}
#[derive(Clone, Debug)]
pub struct Change {
    pub path: PathBuf,
    pub before: Snapshot,
    pub after: Option<Vec<u8>>,
    pub permissions: Option<Permissions>,
}
impl Change {
    pub fn new(path: PathBuf, after: Option<Vec<u8>>) -> Result<Self, Diagnostic> {
        let before = Snapshot::read(&path)?;
        Ok(Self {
            path,
            permissions: before.permissions.clone(),
            before,
            after,
        })
    }
    pub fn unchanged(&self) -> bool {
        self.before.bytes == self.after
            && PermissionRecord::capture(self.before.permissions.as_ref())
                == PermissionRecord::capture(self.permissions.as_ref())
    }
}
#[derive(Debug, Serialize)]
pub struct Applied {
    pub transaction: String,
    pub changes: usize,
}

/// A read-only maintenance preview. Construction never creates the asset store.
/// Dependencies include receipts, journals and external executable snapshots.
pub struct MaintenancePlan {
    store: PathBuf,
    allowed: Vec<PathBuf>,
    changes: Vec<Change>,
    dependencies: Vec<Change>,
    precondition: Option<Box<dyn Fn() -> Result<(), Diagnostic> + Send + Sync>>,
}

#[derive(Clone, Debug, Serialize)]
pub struct MaintenanceAsset {
    pub path: PathBuf,
    pub state: &'static str,
}

/// The exact files a plan inspected before any repair was applied.
#[derive(Clone)]
pub struct MaintenanceBaseline {
    reads: BTreeMap<PathBuf, Snapshot>,
    writes: BTreeSet<PathBuf>,
}

/// Files written by a completed plan, read back with their actual permissions.
#[derive(Clone)]
pub struct MaintenanceWrites(BTreeMap<PathBuf, Snapshot>);

impl MaintenancePlan {
    pub fn new(
        store: PathBuf,
        allowed: Vec<PathBuf>,
        changes: Vec<Change>,
        dependencies: Vec<Change>,
    ) -> Self {
        Self {
            store,
            allowed,
            changes,
            dependencies,
            precondition: None,
        }
    }

    /// Recheck a read-only ownership condition under the asset lock and before
    /// each write. The caller owns the check; the asset store stays independent
    /// of project-specific rules.
    pub fn with_precondition(
        mut self,
        check: impl Fn() -> Result<(), Diagnostic> + Send + Sync + 'static,
    ) -> Self {
        self.precondition = Some(Box::new(check));
        self
    }

    pub fn assets(&self) -> Vec<MaintenanceAsset> {
        self.changes
            .iter()
            .filter(|change| !change.unchanged())
            .map(|change| MaintenanceAsset {
                path: change.path.clone(),
                state: if change.after.is_none() {
                    "removed"
                } else if change.before.bytes.is_none() {
                    "created"
                } else {
                    "updated"
                },
            })
            .collect()
    }

    pub fn depend_on(&mut self, path: &Path) -> Result<(), Diagnostic> {
        let snapshot = Snapshot::read(path)?;
        self.depend_on_snapshot(path, &snapshot);
        Ok(())
    }

    pub fn depend_on_snapshot(&mut self, path: &Path, snapshot: &Snapshot) {
        self.dependencies.push(Change {
            path: path.to_owned(),
            before: snapshot.clone(),
            after: snapshot.bytes.clone(),
            permissions: snapshot.permissions.clone(),
        });
    }

    pub fn read_set(&self) -> MaintenanceBaseline {
        let mut paths = BTreeMap::new();
        for change in self.dependencies.iter().chain(&self.changes) {
            paths.insert(change.path.clone(), change.before.clone());
        }
        MaintenanceBaseline {
            reads: paths,
            writes: self
                .changes
                .iter()
                .filter(|change| !change.unchanged())
                .map(|change| change.path.clone())
                .collect(),
        }
    }

    /// Verify the exact postimages before treating them as this command's own
    /// writes during a subsequent plan. A concurrent edit never becomes proof.
    pub fn write_set(&self) -> Result<MaintenanceWrites, Diagnostic> {
        let mut paths = BTreeMap::new();
        for change in self.changes.iter().filter(|change| !change.unchanged()) {
            let current = Snapshot::read(&change.path)?;
            if !matches_after(change, &current) {
                return Err(error(
                    Code::ConcurrentEdit,
                    "A maintenance output changed after the transaction.",
                ));
            }
            paths.insert(change.path.clone(), current);
        }
        Ok(MaintenanceWrites(paths))
    }

    /// Bind a freshly planned step to the original read set plus only the
    /// postimages this command has confirmed from earlier steps.
    pub fn validate_rebase(
        &mut self,
        baseline: &MaintenanceBaseline,
        prior: &[MaintenanceWrites],
    ) -> Result<(), Diagnostic> {
        let current = self.read_set();
        for (path, snapshot) in &current.reads {
            if !baseline.reads.contains_key(path) {
                let expected = prior
                    .iter()
                    .filter_map(|writes| writes.0.get(path))
                    .next_back()
                    .ok_or_else(|| {
                        error(
                            Code::ConcurrentEdit,
                            "A replanned maintenance step reads a new unverified path.",
                        )
                    })?;
                if !same_snapshot(snapshot, expected)
                    || !same_snapshot(&Snapshot::read(path)?, expected)
                {
                    return Err(error(
                        Code::ConcurrentEdit,
                        "A new maintenance input differs from the confirmed repair output.",
                    ));
                }
            }
        }
        if !current.writes.is_subset(&baseline.writes) {
            return Err(error(
                Code::ConcurrentEdit,
                "A replanned maintenance step would expand its write scope.",
            ));
        }
        for (path, original) in &baseline.reads {
            let expected = prior
                .iter()
                .filter_map(|writes| writes.0.get(path))
                .next_back()
                .unwrap_or(original);
            let planned = self
                .dependencies
                .iter()
                .chain(&self.changes)
                .find(|change| &change.path == path);
            let actual = if let Some(change) = planned {
                &change.before
            } else {
                self.depend_on_snapshot(path, expected);
                expected
            };
            if !same_snapshot(actual, expected) || !same_snapshot(&Snapshot::read(path)?, expected)
            {
                return Err(error(
                    Code::ConcurrentEdit,
                    "A maintenance input changed outside the confirmed repairs.",
                ));
            }
        }
        Ok(())
    }

    pub fn apply(&self) -> Result<Applied, Diagnostic> {
        if self.assets().is_empty() {
            return Ok(Applied {
                transaction: String::new(),
                changes: 0,
            });
        }
        let store = AssetStore::lock(&self.store, &self.allowed, Duration::from_secs(2))?;
        if !store.pending_transactions()?.is_empty() {
            return Err(error(
                Code::RollbackConflict,
                "An interrupted transaction requires explicit recovery before maintenance.",
            ));
        }
        let pending: Vec<_> = self
            .changes
            .iter()
            .filter(|change| !change.unchanged())
            .collect();
        let recheck = |written: usize| {
            if let Some(check) = &self.precondition {
                check()?;
            }
            for dependency in &self.dependencies {
                safe_path(&dependency.path)?;
                let current = Snapshot::read(&dependency.path)?;
                let own_write = pending[..written]
                    .iter()
                    .find(|change| change.path == dependency.path);
                let matches = own_write.map_or_else(
                    || same_snapshot(&current, &dependency.before),
                    |change| matches_after(change, &current),
                );
                if !matches {
                    return Err(error(
                        Code::ConcurrentEdit,
                        "A maintenance dependency changed after planning.",
                    ));
                }
            }
            Ok(())
        };
        recheck(0)?;
        store.apply_checked(self.changes.clone(), recheck)
    }
}

fn same_snapshot(left: &Snapshot, right: &Snapshot) -> bool {
    left.digest() == right.digest()
        && PermissionRecord::capture(left.permissions.as_ref())
            == PermissionRecord::capture(right.permissions.as_ref())
}

fn matches_after(change: &Change, actual: &Snapshot) -> bool {
    actual.digest() == change.after.as_deref().map(hash)
        && PermissionRecord::capture(actual.permissions.as_ref())
            == PermissionRecord::after(change.after.is_some(), change.permissions.as_ref())
}

/// A stable lock file is never deleted, avoiding lock-inode replacement races
/// between cooperating writers. OS release handles process death without PID reuse.
pub struct AssetStore {
    root: PathBuf,
    allowed: Vec<PathBuf>,
    _lock: File,
}
impl AssetStore {
    /// One-file runtime checkpoints use atomic replacement, without a rollback
    /// journal that could erase evidence of an already attempted remote write.
    pub(crate) fn checkpoint(
        &self,
        path: &Path,
        expected: &Snapshot,
        bytes: &[u8],
    ) -> Result<(), Diagnostic> {
        self.validate(path)?;
        let actual = Snapshot::read(path)?;
        if actual.bytes != expected.bytes {
            return Err(error(
                Code::ConcurrentEdit,
                "The checkpoint changed outside the held operation lock.",
            ));
        }
        atomic(path, bytes, actual.permissions.as_ref())
    }
    pub fn lock(root: &Path, allowed: &[PathBuf], timeout: Duration) -> Result<Self, Diagnostic> {
        if timeout.is_zero() || timeout > Duration::from_secs(30) {
            return Err(Diagnostic::input(
                "Asset lock timeout must be positive and at most 30 seconds.",
            ));
        }
        ensure_directory(root)?;
        for path in allowed {
            safe_path(path)?;
        }
        let lock_path = root.join(".specgit-lock");
        safe_path(&lock_path)?;
        let mut file = match OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&lock_path)
        {
            Ok(mut file) => {
                file.write_all(b"specgit-owned-assets-v2\n")
                    .map_err(|e| filesystem_error("lock_marker_write", &e))?;
                file.sync_all()
                    .map_err(|e| filesystem_error("lock_marker_sync", &e))?;
                file
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => OpenOptions::new()
                .read(true)
                .write(true)
                .open(&lock_path)
                .map_err(|e| filesystem_error("lock_open", &e))?,
            Err(e) => return Err(filesystem_error("lock_create", &e)),
        };
        let start = Instant::now();
        loop {
            match file.try_lock() {
                Ok(()) => break,
                Err(TryLockError::WouldBlock) if start.elapsed() < timeout => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(TryLockError::WouldBlock) => {
                    return Err(error(
                        Code::LockBusy,
                        "Another owned-asset transaction holds the lock.",
                    ));
                }
                Err(TryLockError::Error(e)) => return Err(filesystem_error("lock_acquire", &e)),
            }
        }
        safe_path(&lock_path)?;
        // Windows byte-range locks are mandatory: inspect through the owning
        // handle only after acquisition, never via a second unlocked reader.
        file.seek(SeekFrom::Start(0))
            .map_err(|e| filesystem_error("lock_seek", &e))?;
        let mut marker = Vec::new();
        (&mut file)
            .take(64)
            .read_to_end(&mut marker)
            .map_err(|e| filesystem_error("lock_marker_read", &e))?;
        if marker != b"specgit-owned-assets-v2\n" {
            return Err(error(
                Code::OwnershipConflict,
                "The asset lock path belongs to another owner.",
            ));
        }
        let mut allowed = allowed.to_vec();
        allowed.push(root.to_owned());
        Ok(Self {
            root: root.into(),
            allowed,
            _lock: file,
        })
    }
    fn validate(&self, path: &Path) -> Result<(), Diagnostic> {
        safe_path(path)?;
        if !self
            .allowed
            .iter()
            .any(|root| path.starts_with(root) && path != root)
        {
            return Err(error(
                Code::UnsafePath,
                "The asset is outside the explicitly selected roots.",
            ));
        }
        Ok(())
    }
    pub fn pending_transactions(&self) -> Result<Vec<String>, Diagnostic> {
        Self::pending_at(&self.root)
    }
    /// Read-only inspection must not create the store or its lock file.
    pub(crate) fn pending_at(root: &Path) -> Result<Vec<String>, Diagnostic> {
        let directory = root.join("transactions");
        safe_path(&directory)?;
        if !directory.exists() {
            return Ok(vec![]);
        }
        let mut pending = vec![];
        for (i, entry) in fs::read_dir(directory).map_err(|_| io_error())?.enumerate() {
            if i >= 1000 {
                return Err(error(
                    Code::OutputLimit,
                    "Transaction inventory exceeds its bound; inspect retained backups before further writes.",
                ));
            }
            let entry = entry.map_err(|_| io_error())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with("tx-") {
                continue;
            }
            let bytes = Snapshot::read(&entry.path().join("journal.json"))?;
            let Some(bytes) = bytes.bytes else {
                continue;
            };
            if bytes.len() > JOURNAL_LIMIT {
                return Err(error(
                    Code::InputLimit,
                    "Transaction journal exceeds its allowance.",
                ));
            }
            let journal: Journal = serde_json::from_slice(&bytes).map_err(|_| {
                error(
                    Code::RollbackConflict,
                    "A retained transaction journal is damaged.",
                )
            })?;
            if journal.state == "prepared" {
                pending.push(name);
            }
        }
        pending.sort();
        Ok(pending)
    }
    /// Existing init/migrate journals prove the exact bytes and permissions of
    /// declarations written before a separate removal command was shipped.
    pub(crate) fn owned_at(
        root: &Path,
        path: &Path,
        snapshot: &Snapshot,
    ) -> Result<Option<Change>, Diagnostic> {
        Self::owned_matching_at(root, path, snapshot, None)
    }
    /// Follow committed receipt revisions back to the transaction that wrote
    /// the asset. Every journal in the chain is returned for lock-time recheck.
    pub(crate) fn owned_pair_at(
        root: &Path,
        receipt_path: &Path,
        receipt: &Snapshot,
        asset_path: &Path,
        asset: &Snapshot,
        asset_digest: Option<&str>,
    ) -> Result<Option<Vec<Change>>, Diagnostic> {
        Self::owned_pair_across_at(
            &[root.to_owned()],
            receipt_path,
            receipt,
            asset_path,
            asset,
            asset_digest,
        )
    }

    pub(crate) fn owned_pair_across_at(
        roots: &[PathBuf],
        receipt_path: &Path,
        receipt: &Snapshot,
        asset_path: &Path,
        asset: &Snapshot,
        asset_digest: Option<&str>,
    ) -> Result<Option<Vec<Change>>, Diagnostic> {
        if receipt.bytes.is_none() || (asset.bytes.is_none() && asset_digest.is_none()) {
            return Ok(None);
        }
        let expected_receipt = receipt_path.canonicalize().map_err(|_| io_error())?;
        // A removed leaf (or its parent directory) cannot be canonicalized.
        // The journal path must exactly equal the selected absolute path.
        safe_path(asset_path)?;
        let expected_asset = if asset.bytes.is_some() {
            asset_path.canonicalize().map_err(|_| io_error())?
        } else {
            asset_path.to_owned()
        };
        let mut paths = Vec::new();
        for root in roots {
            let directory = root.join("transactions");
            safe_path(&directory)?;
            if !directory.exists() {
                continue;
            }
            for entry in fs::read_dir(directory).map_err(|_| io_error())? {
                if paths.len() >= 1000 {
                    return Err(error(
                        Code::OutputLimit,
                        "Transaction inventory exceeds its bound.",
                    ));
                }
                paths.push(entry.map_err(|_| io_error())?.path());
            }
        }
        paths.sort();
        let mut records = Vec::new();
        for entry in paths {
            if !entry
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("tx-"))
            {
                continue;
            }
            let journal_path = entry.join("journal.json");
            let before = Snapshot::read(&journal_path)?;
            let Some(bytes) = &before.bytes else { continue };
            let journal: Journal =
                serde_json::from_value(crate::input::json(bytes, JOURNAL_LIMIT, 20)?).map_err(
                    |_| {
                        error(
                            Code::RollbackConflict,
                            "A retained transaction journal is damaged.",
                        )
                    },
                )?;
            if journal.version != 2 || journal.entries.len() > 100 {
                return Err(error(
                    Code::RollbackConflict,
                    "A retained transaction journal is unsupported.",
                ));
            }
            if journal.state == "committed" {
                records.push((journal_path, before, journal));
            }
        }
        let initial_digest = receipt.digest().expect("present receipt");
        let mut queue = std::collections::VecDeque::from([(
            initial_digest.clone(),
            PermissionRecord::capture(receipt.permissions.as_ref()),
        )]);
        let mut visited = std::collections::HashSet::new();
        let mut dependencies = Vec::new();
        let mut permission_conflicts = BTreeSet::new();
        let mut matched = false;
        let mut incomplete = false;
        while let Some((current, expected_permissions)) = queue.pop_front() {
            if !visited.insert((current.clone(), expected_permissions.clone())) {
                continue;
            }
            let mut receipt_found = false;
            for (path, snapshot, journal) in &records {
                let Some(receipt_entry) = journal.entries.iter().find(|e| {
                    safe_path(&e.path).is_ok()
                        && e.path.canonicalize().ok().as_deref() == Some(expected_receipt.as_path())
                        && e.after.as_deref() == Some(current.as_str())
                }) else {
                    continue;
                };
                receipt_found = true;
                // Every reachable candidate matters: a matching branch cannot
                // hide a contradictory one, and all are lock-time dependencies.
                if !dependencies
                    .iter()
                    .any(|proof: &Change| proof.path == *path)
                {
                    dependencies.push(Change {
                        path: path.clone(),
                        before: snapshot.clone(),
                        after: snapshot.bytes.clone(),
                        permissions: snapshot.permissions.clone(),
                    });
                }
                if receipt_entry.after_permissions.as_ref() != Some(&expected_permissions) {
                    incomplete = true;
                    if let Some(recorded) = &receipt_entry.after_permissions {
                        permission_conflicts.insert(if current == initial_digest {
                            format!(
                                "Recorded permissions do not match the observed permissions for {}: recorded {}; observed {}.",
                                receipt_path.display(), recorded.description(), expected_permissions.description()
                            )
                        } else {
                            format!(
                                "Receipt permission records disagree for {}: earlier write {}; later preimage {}.",
                                receipt_path.display(), recorded.description(), expected_permissions.description()
                            )
                        });
                    }
                    continue;
                }
                let asset_entry = journal.entries.iter().find(|e| {
                    safe_path(&e.path).is_ok()
                        && if asset.bytes.is_some() {
                            e.path.canonicalize().ok().as_deref() == Some(expected_asset.as_path())
                        } else {
                            #[cfg(windows)]
                            {
                                same_missing_asset_path(&e.path, &expected_asset)
                            }
                            #[cfg(not(windows))]
                            {
                                e.path == expected_asset
                            }
                        }
                });
                if let Some(entry) = asset_entry {
                    // A removal, different digest or missing permissions ends
                    // this branch. Never fall back to a still older asset.
                    if entry.after.is_none()
                        || asset_digest.is_some_and(|digest| entry.after.as_deref() != Some(digest))
                    {
                        incomplete = true;
                        continue;
                    }
                    let observed = if asset.bytes.is_none() {
                        PermissionRecord::after(true, None)
                    } else {
                        PermissionRecord::capture(asset.permissions.as_ref())
                    };
                    if entry.after_permissions.as_ref() == Some(&observed) {
                        matched = true;
                    } else {
                        incomplete = true;
                        if asset.bytes.is_some()
                            && let Some(recorded) = &entry.after_permissions
                        {
                            permission_conflicts.insert(format!(
                                "Recorded permissions do not match the observed permissions for {}: recorded {}; observed {}.",
                                asset_path.display(), recorded.description(), observed.description()
                            ));
                        }
                    }
                    continue;
                }
                if let Some(previous) = &receipt_entry.before {
                    queue.push_back((previous.clone(), receipt_entry.permissions.clone()));
                } else {
                    incomplete = true;
                }
            }
            incomplete |= !receipt_found;
        }
        if !permission_conflicts.is_empty() {
            return Err(Diagnostic::new(
                Code::OwnershipConflict,
                "owned_assets",
                &permission_conflicts
                    .into_iter()
                    .collect::<Vec<_>>()
                    .join(" "),
                "Keep the existing files and permissions. Reconcile the recorded and observed permissions explicitly, then preview again; no permission change or ownership adoption was authorized.",
            ));
        }
        Ok((matched && !incomplete).then_some(dependencies))
    }

    fn owned_matching_at(
        root: &Path,
        path: &Path,
        snapshot: &Snapshot,
        recorded_digest: Option<&str>,
    ) -> Result<Option<Change>, Diagnostic> {
        let directory = root.join("transactions");
        safe_path(&directory)?;
        if !directory.exists() {
            return Ok(None);
        }
        let mut paths = Vec::new();
        for (i, entry) in fs::read_dir(directory).map_err(|_| io_error())?.enumerate() {
            if i >= 1000 {
                return Err(error(
                    Code::OutputLimit,
                    "Transaction inventory exceeds its bound.",
                ));
            }
            paths.push(entry.map_err(|_| io_error())?.path());
        }
        paths.sort();
        let expected_path = path.canonicalize().map_err(|_| io_error())?;
        for entry in paths {
            if !entry
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("tx-"))
            {
                continue;
            }
            let journal_path = entry.join("journal.json");
            let before = Snapshot::read(&journal_path)?;
            let Some(bytes) = &before.bytes else { continue };
            let journal: Journal =
                serde_json::from_value(crate::input::json(bytes, JOURNAL_LIMIT, 20)?).map_err(
                    |_| {
                        error(
                            Code::RollbackConflict,
                            "A retained transaction journal is damaged.",
                        )
                    },
                )?;
            if journal.version != 2 || journal.entries.len() > 100 {
                return Err(error(
                    Code::RollbackConflict,
                    "A retained transaction journal is unsupported.",
                ));
            }
            if journal.state == "committed"
                && journal.entries.iter().any(|entry| {
                    safe_path(&entry.path).is_ok()
                        && entry.path.canonicalize().ok().as_ref() == Some(&expected_path)
                        && match recorded_digest {
                            Some(digest) => {
                                entry.after.as_deref() == Some(digest)
                                    && entry.after_permissions.as_ref()
                                        == Some(&PermissionRecord::capture(
                                            snapshot.permissions.as_ref(),
                                        ))
                            }
                            None => entry.matches(snapshot, true),
                        }
                })
            {
                return Ok(Some(Change {
                    path: journal_path,
                    after: before.bytes.clone(),
                    permissions: before.permissions.clone(),
                    before,
                }));
            }
        }
        Ok(None)
    }
    pub fn apply(&self, changes: Vec<Change>) -> Result<Applied, Diagnostic> {
        self.apply_checked(changes, |_| Ok(()))
    }
    /// A commit observer allows callers to stop after an external precondition
    /// changes. Failure rolls back committed entries using their expected hashes.
    pub fn apply_checked(
        &self,
        changes: Vec<Change>,
        mut before_write: impl FnMut(usize) -> Result<(), Diagnostic>,
    ) -> Result<Applied, Diagnostic> {
        self.apply_checked_recording(changes, &[], &mut before_write)
    }

    /// Record an explicit ownership baseline without rewriting unchanged bytes.
    pub(crate) fn apply_recording(
        &self,
        changes: Vec<Change>,
        observations: &[PathBuf],
    ) -> Result<Applied, Diagnostic> {
        self.apply_checked_recording(changes, observations, &mut |_| Ok(()))
    }

    fn apply_checked_recording(
        &self,
        changes: Vec<Change>,
        observations: &[PathBuf],
        before_write: &mut impl FnMut(usize) -> Result<(), Diagnostic>,
    ) -> Result<Applied, Diagnostic> {
        let pending = self.pending_transactions()?;
        if !pending.is_empty() {
            return Err(error(
                Code::RollbackConflict,
                &format!(
                    "An interrupted transaction requires explicit rollback first: {}",
                    pending.join(", ")
                ),
            ));
        }
        // Unchanged journal proofs are read dependencies. Validate them under
        // the lock even though they are not written into a new transaction.
        let mut paths = std::collections::HashSet::new();
        for change in &changes {
            self.validate(&change.path)?;
            if !paths.insert(&change.path) {
                return Err(Diagnostic::input(
                    "An asset path occurs twice in the transaction.",
                ));
            }
            self.expected_snapshot(&change.path, &change.before)?;
        }
        let proofs: Vec<_> = changes
            .iter()
            .filter(|c| c.unchanged())
            .map(|c| (c.path.clone(), c.before.clone()))
            .collect();
        let changes: Vec<_> = changes
            .into_iter()
            .filter(|c| !c.unchanged() || observations.contains(&c.path))
            .collect();
        if changes
            .iter()
            .map(|c| {
                c.before
                    .bytes
                    .as_ref()
                    .map_or(0, Vec::len)
                    .saturating_add(c.after.as_ref().map_or(0, Vec::len))
            })
            .try_fold(0usize, |a, b| a.checked_add(b))
            .is_none_or(|n| n > 268_435_456)
        {
            return Err(Diagnostic::input(
                "Asset transaction exceeds its total byte allowance.",
            ));
        }
        if changes.len() > 100 {
            return Err(Diagnostic::input(
                "At most 100 asset changes may be committed together.",
            ));
        }
        if changes.is_empty() {
            return Ok(Applied {
                transaction: String::new(),
                changes: 0,
            });
        }
        let transactions = self.root.join("transactions");
        ensure_directory(&transactions)?;
        let directory = tempfile::Builder::new()
            .prefix("tx-")
            .tempdir_in(&transactions)
            .map_err(|_| io_error())?
            .keep();
        private_directory(&directory)?;
        let id = directory
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(io_error)?
            .to_owned();
        let mut journal = Journal {
            version: 2,
            state: "prepared".into(),
            entries: vec![],
        };
        for (i, change) in changes.iter().enumerate() {
            let backup = format!("{i}.before");
            if let Some(bytes) = &change.before.bytes {
                atomic(&directory.join(&backup), bytes, None)?;
            }
            journal.entries.push(Entry {
                path: change.path.clone(),
                before: change.before.digest(),
                after: change.after.as_deref().map(hash),
                backup,
                permissions: PermissionRecord::capture(change.before.permissions.as_ref()),
                after_permissions: Some(PermissionRecord::after(
                    change.after.is_some(),
                    change.permissions.as_ref(),
                )),
            });
        }
        self.save_journal(&directory, &journal)?;
        for (i, change) in changes.iter().enumerate() {
            let result = (|| {
                #[cfg(feature = "test-fixtures")]
                fixture_crash(&format!("before-write:{i}"));
                before_write(i)?;
                for (path, expected) in &proofs {
                    self.validate(path)?;
                    self.expected_snapshot(path, expected)?;
                }
                self.validate(&change.path)?;
                self.expected_snapshot(&change.path, &change.before)?;
                if change.unchanged() {
                    return Ok(());
                }
                match &change.after {
                    Some(bytes) => atomic(&change.path, bytes, change.permissions.as_ref()),
                    None => fs::remove_file(&change.path).map_err(|_| io_error()),
                }
            })();
            if let Err(original) = result {
                // Restore only our own writes. A concurrent edit to the current
                // uncommitted entry belongs to its writer and is left intact.
                let current_was_written = Snapshot::read(&change.path)
                    .map(|s| journal.entries[i].matches(&s, true))
                    .unwrap_or(false);
                let end = if current_was_written { i + 1 } else { i };
                if self.restore(&directory, &journal.entries[..end]).is_err() {
                    return Err(error(
                        Code::RollbackConflict,
                        &format!(
                            "Transaction {id} could not be fully restored; retained backups require inspection."
                        ),
                    ));
                }
                journal.state = "rolled_back".into();
                self.save_journal(&directory, &journal)?;
                return Err(original);
            }
        }
        #[cfg(feature = "test-fixtures")]
        fixture_crash("before-commit");
        journal.state = "committed".into();
        self.save_journal(&directory, &journal)?;
        Ok(Applied {
            transaction: id,
            changes: changes.len(),
        })
    }
    fn expected_snapshot(&self, path: &Path, expected: &Snapshot) -> Result<(), Diagnostic> {
        let actual = Snapshot::read(path)?;
        if actual.digest() != expected.digest()
            || PermissionRecord::capture(actual.permissions.as_ref())
                != PermissionRecord::capture(expected.permissions.as_ref())
        {
            return Err(error(
                Code::ConcurrentEdit,
                "An asset or its permissions changed after inspection.",
            ));
        }
        Ok(())
    }
    fn save_journal(&self, directory: &Path, journal: &Journal) -> Result<(), Diagnostic> {
        let bytes = serde_json::to_vec_pretty(journal).map_err(|_| io_error())?;
        if bytes.len() > JOURNAL_LIMIT {
            return Err(error(
                Code::InputLimit,
                "Transaction journal exceeds its size allowance.",
            ));
        }
        atomic(&directory.join("journal.json"), &bytes, None)
    }
    fn restore(&self, directory: &Path, entries: &[Entry]) -> Result<(), Diagnostic> {
        // Validate every preimage before the first restore, including backup hashes.
        for entry in entries {
            self.validate(&entry.path)?;
            if entry.after_permissions.is_none() {
                return Err(error(
                    Code::RollbackConflict,
                    "Legacy rollback evidence lacks post-write permissions; preserve backups and inspect explicitly.",
                ));
            }
            let current = Snapshot::read(&entry.path)?;
            if !entry.matches(&current, false) && !entry.matches(&current, true) {
                return Err(error(
                    Code::RollbackConflict,
                    "A concurrent edit prevents safe rollback.",
                ));
            }
            if entry.before.is_some() {
                if entry.backup.contains(['/', '\\']) || entry.backup.starts_with('.') {
                    return Err(error(Code::UnsafePath, "Invalid backup locator."));
                }
                if Snapshot::read(&directory.join(&entry.backup))?.digest() != entry.before {
                    return Err(error(
                        Code::RollbackConflict,
                        "A backup is missing or changed.",
                    ));
                }
            }
        }
        for entry in entries.iter().rev() {
            let current = Snapshot::read(&entry.path)?;
            if entry.matches(&current, false) {
                continue;
            }
            if !entry.matches(&current, true) {
                return Err(error(
                    Code::RollbackConflict,
                    "A concurrent content or permission edit prevents rollback.",
                ));
            }
            match &entry.before {
                Some(_) => {
                    let backup = Snapshot::read(&directory.join(&entry.backup))?;
                    atomic(
                        &entry.path,
                        backup.bytes.as_deref().ok_or_else(io_error)?,
                        entry
                            .permissions
                            .restore(backup.permissions.as_ref())
                            .as_ref(),
                    )?;
                }
                None => fs::remove_file(&entry.path).map_err(|_| io_error())?,
            }
        }
        Ok(())
    }
    pub fn rollback(&self, id: &str) -> Result<Applied, Diagnostic> {
        self.rollback_retaining(id, &[]).map(|(applied, _)| applied)
    }
    /// Roll back a transaction but keep the current content of `retain` paths,
    /// such as worktree-shared files still used by another worktree.
    /// Returns the retained paths that the journal would otherwise have restored.
    pub fn rollback_retaining(
        &self,
        id: &str,
        retain: &[PathBuf],
    ) -> Result<(Applied, Vec<PathBuf>), Diagnostic> {
        if !id.starts_with("tx-") || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
            return Err(Diagnostic::input("Use an exact reported transaction id."));
        }
        let directory = self.root.join("transactions").join(id);
        let bytes = Snapshot::read(&directory.join("journal.json"))?
            .bytes
            .ok_or_else(io_error)?;
        if bytes.len() > JOURNAL_LIMIT {
            return Err(error(
                Code::InputLimit,
                "Transaction journal exceeds its size allowance.",
            ));
        }
        let mut journal: Journal = serde_json::from_slice(&bytes).map_err(|_| io_error())?;
        if journal.version != 2 || journal.entries.len() > 100 {
            return Err(Diagnostic::input("Unsupported transaction journal."));
        }
        let (retained, restored): (Vec<_>, Vec<_>) = journal
            .entries
            .iter()
            .partition(|entry| retain.contains(&entry.path));
        let restored: Vec<Entry> = restored.into_iter().cloned().collect();
        let retained: Vec<PathBuf> = retained.into_iter().map(|e| e.path.clone()).collect();
        self.restore(&directory, &restored)?;
        journal.state = "rolled_back".into();
        self.save_journal(&directory, &journal)?;
        Ok((
            Applied {
                transaction: id.into(),
                changes: restored.len(),
            },
            retained,
        ))
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u32,
    state: String,
    entries: Vec<Entry>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    path: PathBuf,
    before: Option<String>,
    after: Option<String>,
    backup: String,
    permissions: PermissionRecord,
    #[serde(default)]
    after_permissions: Option<PermissionRecord>,
}
impl Entry {
    fn matches(&self, snapshot: &Snapshot, after: bool) -> bool {
        let (digest, permissions) = if after {
            (&self.after, self.after_permissions.as_ref())
        } else {
            (&self.before, Some(&self.permissions))
        };
        snapshot.digest() == *digest
            && permissions == Some(&PermissionRecord::capture(snapshot.permissions.as_ref()))
    }
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
struct PermissionRecord {
    readonly: Option<bool>,
    unix_mode: Option<u32>,
}
impl PermissionRecord {
    fn description(&self) -> String {
        let readonly = self
            .readonly
            .map_or_else(|| "unknown".into(), |value| value.to_string());
        match self.unix_mode {
            Some(mode) => format!("unix_mode={mode:04o}, readonly={readonly}"),
            None => format!("readonly={readonly}"),
        }
    }
    fn after(present: bool, permissions: Option<&Permissions>) -> Self {
        if !present {
            return Self::capture(None);
        }
        if let Some(p) = permissions {
            return Self::capture(Some(p));
        }
        Self {
            readonly: Some(false),
            unix_mode: if cfg!(unix) { Some(0o600) } else { None },
        }
    }
    fn capture(p: Option<&Permissions>) -> Self {
        #[cfg(unix)]
        let unix_mode = {
            use std::os::unix::fs::PermissionsExt;
            p.map(|p| p.mode() & 0o7777)
        };
        #[cfg(not(unix))]
        let unix_mode = None;
        Self {
            readonly: p.map(Permissions::readonly),
            unix_mode,
        }
    }
    fn restore(&self, fallback: Option<&Permissions>) -> Option<Permissions> {
        let _ = fallback;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            self.unix_mode.map(Permissions::from_mode)
        }
        #[cfg(not(unix))]
        {
            fallback.map(|permissions| {
                let mut p = permissions.clone();
                if let Some(readonly) = self.readonly {
                    p.set_readonly(readonly);
                }
                p
            })
        }
    }
}
fn private_directory(path: &Path) -> Result<(), Diagnostic> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, Permissions::from_mode(0o700)).map_err(|_| io_error())?;
    }
    let _ = path;
    Ok(())
}
fn atomic(path: &Path, bytes: &[u8], permissions: Option<&Permissions>) -> Result<(), Diagnostic> {
    let parent = path.parent().ok_or_else(io_error)?;
    ensure_directory(parent)?;
    safe_path(path)?;
    #[cfg(windows)]
    let expected = Snapshot::read(path)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| filesystem_error("temporary_create", &e))?;
    temp.write_all(bytes)
        .map_err(|e| filesystem_error("temporary_write", &e))?;
    #[cfg(unix)]
    if permissions.is_none() {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(Permissions::from_mode(0o600))
            .map_err(|e| filesystem_error("temporary_private_permissions", &e))?;
    }
    if let Some(permissions) = permissions {
        temp.as_file()
            .set_permissions(permissions.clone())
            .map_err(|e| filesystem_error("temporary_permissions", &e))?;
    }
    temp.as_file()
        .sync_all()
        .map_err(|e| filesystem_error("temporary_sync", &e))?;
    safe_path(path)?;
    #[cfg(not(windows))]
    temp.persist(path)
        .map_err(|e| filesystem_error("atomic_replace", &e.error))?;
    #[cfg(windows)]
    persist_windows(temp, path, &expected)?;
    #[cfg(unix)]
    File::open(parent)
        .and_then(|f| f.sync_all())
        .map_err(|e| filesystem_error("directory_sync", &e))?;
    Ok(())
}

#[cfg(windows)]
fn persist_windows(
    mut temp: tempfile::NamedTempFile,
    path: &Path,
    expected: &Snapshot,
) -> Result<(), Diagnostic> {
    let started = Instant::now();
    loop {
        match temp.persist(path) {
            Ok(_) => return Ok(()),
            Err(failure) => {
                // Windows can refuse replacement while another handle is open.
                // Retain the same synced staging file and preserve the target.
                if !matches!(failure.error.raw_os_error(), Some(5 | 32 | 33))
                    || started.elapsed() >= Duration::from_secs(1)
                {
                    return Err(filesystem_error("atomic_replace", &failure.error));
                }
                temp = failure.file;
                std::thread::sleep(Duration::from_millis(20));
                let actual = Snapshot::read(path)?;
                if actual.bytes != expected.bytes
                    || PermissionRecord::capture(actual.permissions.as_ref())
                        != PermissionRecord::capture(expected.permissions.as_ref())
                {
                    return Err(error(
                        Code::ConcurrentEdit,
                        "The destination changed while its atomic replacement was blocked.",
                    ));
                }
            }
        }
    }
}
