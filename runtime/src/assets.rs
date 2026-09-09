//! Expected-content transactions for explicitly selected owned assets.
//! The journal retains recoverable preimages; an edit after planning is a conflict.
use crate::diagnostic::{Code, Diagnostic};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions, Permissions, TryLockError},
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};

const FILE_LIMIT: u64 = 134_217_728;
const JOURNAL_LIMIT: usize = 1_048_576;
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
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
                    "A symbolic-link boundary prevents this asset operation.",
                ));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(io_error()),
        }
    }
    Ok(())
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
    fs::create_dir_all(path).map_err(|_| io_error())?;
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
            Err(_) => return Err(io_error()),
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
            .map_err(|_| io_error())?
            .take(FILE_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| io_error())?;
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
                    .map_err(|_| io_error())?;
                file.sync_all().map_err(|_| io_error())?;
                file
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => OpenOptions::new()
                .read(true)
                .write(true)
                .open(&lock_path)
                .map_err(|_| io_error())?,
            Err(_) => return Err(io_error()),
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
                Err(TryLockError::Error(_)) => return Err(io_error()),
            }
        }
        safe_path(&lock_path)?;
        // Windows byte-range locks are mandatory: inspect through the owning
        // handle only after acquisition, never via a second unlocked reader.
        file.seek(SeekFrom::Start(0)).map_err(|_| io_error())?;
        let mut marker = Vec::new();
        (&mut file)
            .take(64)
            .read_to_end(&mut marker)
            .map_err(|_| io_error())?;
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
        let directory = self.root.join("transactions");
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
        let changes: Vec<_> = changes.into_iter().filter(|c| !c.unchanged()).collect();
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
                before_write(i)?;
                self.validate(&change.path)?;
                self.expected_snapshot(&change.path, &change.before)?;
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
        self.restore(&directory, &journal.entries)?;
        journal.state = "rolled_back".into();
        self.save_journal(&directory, &journal)?;
        Ok(Applied {
            transaction: id.into(),
            changes: journal.entries.len(),
        })
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u32,
    state: String,
    entries: Vec<Entry>,
}
#[derive(Serialize, Deserialize)]
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
#[derive(Serialize, Deserialize, PartialEq, Eq)]
struct PermissionRecord {
    readonly: Option<bool>,
    unix_mode: Option<u32>,
}
impl PermissionRecord {
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
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|_| io_error())?;
    temp.write_all(bytes).map_err(|_| io_error())?;
    #[cfg(unix)]
    if permissions.is_none() {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(Permissions::from_mode(0o600))
            .map_err(|_| io_error())?;
    }
    if let Some(permissions) = permissions {
        temp.as_file()
            .set_permissions(permissions.clone())
            .map_err(|_| io_error())?;
    }
    temp.as_file().sync_all().map_err(|_| io_error())?;
    safe_path(path)?;
    temp.persist(path).map_err(|_| io_error())?;
    #[cfg(unix)]
    File::open(parent)
        .and_then(|f| f.sync_all())
        .map_err(|_| io_error())?;
    Ok(())
}
