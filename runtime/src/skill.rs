//! Explicit user Skill ownership. No hooks, receipts or user-level state store.
use crate::{
    assets::{self, Snapshot},
    diagnostic::{Code, Diagnostic},
    report::{Effects, Report},
};
use clap::Args;
use serde::Serialize;
use serde_json::json;
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const MARKER: &str = "<!-- specgit:managed sha256=";
pub(crate) const REMEDY: &str = "Run specgit skill --user to refresh the user Skill; preserve and inspect any reported backup or ownership conflict.";

#[derive(Clone, Args, Default)]
pub struct Options {
    /// Explicitly select the user Skill; there is no default scope.
    #[arg(long, required = true)]
    pub user: bool,
    /// Preview the action without creating directories, backups or files.
    #[arg(long)]
    pub dry_run: bool,
    /// Remove only a managed Skill whose body is unchanged.
    #[arg(long, conflicts_with = "refresh_only")]
    pub remove: bool,
    /// Refresh only an existing managed Skill; otherwise skip without writes.
    #[arg(long)]
    pub refresh_only: bool,
}

/// Single embedded Skill source shared by project setup and user installation.
pub(crate) fn bytes() -> Vec<u8> {
    include_str!("../assets/SKILL.md")
        .replace("{{version}}", env!("CARGO_PKG_VERSION"))
        .into_bytes()
}
fn managed_bytes() -> Vec<u8> {
    let mut body = bytes();
    if !body.ends_with(b"\n") {
        body.push(b'\n');
    }
    let marker = format!("{MARKER}{} -->\n", assets::hash(&body));
    body.extend_from_slice(marker.as_bytes());
    body
}

/// An exact marker line establishes ownership. Malformed markers are foreign.
/// The body may be arbitrary bytes after user editing; backups preserve them exactly.
fn marker(bytes: &[u8]) -> Option<(&[u8], &str, bool)> {
    let mut offset = 0;
    let mut found = None;
    for raw in bytes.split_inclusive(|b| *b == b'\n') {
        let line = raw.strip_suffix(b"\n").unwrap_or(raw);
        if let Some(digest) = std::str::from_utf8(line)
            .ok()
            .and_then(|line| line.strip_prefix(MARKER))
            .and_then(|line| line.strip_suffix(" -->"))
            .filter(|digest| {
                digest.len() == 64
                    && digest
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
        {
            found = Some((&bytes[..offset], digest, offset + raw.len() < bytes.len()));
        }
        offset += raw.len();
    }
    found
}
fn diagnostic(code: Code, message: &str) -> Diagnostic {
    Diagnostic::new(code, "skill", message, REMEDY)
}
fn io_error(_: std::io::Error) -> Diagnostic {
    diagnostic(
        Code::IoFailed,
        "The user Skill filesystem operation failed; existing content and any completed backup are retained.",
    )
}

pub(crate) fn user_path() -> Result<PathBuf, Diagnostic> {
    let variable = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    let home = std::env::var_os(variable)
        .map(PathBuf::from)
        .ok_or_else(|| {
            diagnostic(
                Code::InvalidInput,
                "The home environment variable is missing.",
            )
        })?;
    if !home.is_absolute()
        || home
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err(diagnostic(
            Code::InvalidInput,
            "The home directory must be an absolute path without traversal.",
        ));
    }
    // Home itself may be an OS alias (e.g. /var on macOS). Boundaries below it may not.
    let home = home
        .canonicalize()
        .map_err(|_| diagnostic(Code::InvalidInput, "The home directory is unavailable."))?;
    if !home.is_dir() {
        return Err(diagnostic(
            Code::InvalidInput,
            "The home path is not a directory.",
        ));
    }
    let path = home.join(".agents/skills/specgit-native/SKILL.md");
    assets::safe_path(&path)?;
    Ok(path)
}

/// Cheap bounded ownership probe in the old update binary. It never hashes a body
/// or creates anything; the new binary rechecks ownership before refreshing.
pub(crate) fn installed() -> Result<bool, Diagnostic> {
    let path = user_path()?;
    // Reuse the bounded regular-file read. Do not hash the body in the old binary.
    Ok(Snapshot::read(&path)?
        .bytes
        .as_deref()
        .and_then(marker)
        .is_some())
}

#[derive(Serialize)]
struct Evidence {
    scope: &'static str,
    path: Option<PathBuf>,
    action: &'static str,
    dry_run: bool,
    edited: bool,
    backup: Option<PathBuf>,
}

pub fn run(options: Options) -> Report {
    let mut evidence = Evidence {
        scope: "user",
        path: None,
        action: "skip",
        dry_run: options.dry_run,
        edited: false,
        backup: None,
    };
    let mut effects = Effects::default();
    let result = apply(&options, &mut evidence, &mut effects);
    let mut report = match result {
        Ok(status) => Report::success("skill", status, &evidence),
        Err(mut error) => {
            error.operation = "skill".into();
            let mut report = Report::failure("skill", error);
            report.evidence = serde_json::to_value(evidence).unwrap_or_default();
            report
        }
    };
    report.effects = Some(effects);
    report
}

fn recheck(path: &Path, before: &Snapshot, lock: Option<&fs::File>) -> Result<(), Diagnostic> {
    let actual = if let Some(file) = lock {
        // Windows byte-range locks prevent reads through a separately opened
        // handle, including our own. Read through the exact locked handle.
        assets::safe_path(path)?;
        let metadata = file.metadata().map_err(io_error)?;
        let current = fs::symlink_metadata(path).map_err(io_error)?;
        let same = metadata.len() == current.len()
            && metadata.modified().ok() == current.modified().ok()
            && metadata.created().ok() == current.created().ok();
        #[cfg(unix)]
        let same = {
            use std::os::unix::fs::MetadataExt;
            same && metadata.dev() == current.dev() && metadata.ino() == current.ino()
        };
        if !current.is_file() || !same {
            return Err(diagnostic(
                Code::ConcurrentEdit,
                "The Skill path no longer identifies the locked asset.",
            ));
        }
        let mut handle = file;
        handle.seek(SeekFrom::Start(0)).map_err(io_error)?;
        let mut bytes = vec![];
        // A changed/growing file must not defeat the existing Snapshot bound.
        handle
            .take(134_217_729)
            .read_to_end(&mut bytes)
            .map_err(io_error)?;
        Snapshot {
            bytes: Some(bytes),
            permissions: Some(current.permissions()),
        }
    } else {
        Snapshot::read(path)?
    };
    if actual.bytes != before.bytes || actual.permissions != before.permissions {
        return Err(diagnostic(
            Code::ConcurrentEdit,
            "The user Skill changed after inspection; no replacement or removal was attempted.",
        ));
    }
    Ok(())
}

fn apply(
    options: &Options,
    evidence: &mut Evidence,
    effects: &mut Effects,
) -> Result<&'static str, Diagnostic> {
    if !options.user || (options.remove && options.refresh_only) {
        return Err(diagnostic(
            Code::InvalidInput,
            "Select --user explicitly; --remove and --refresh-only cannot be combined.",
        ));
    }
    let path = user_path()?;
    evidence.path = Some(path.clone());
    let before = Snapshot::read(&path)?;
    let ownership = before.bytes.as_deref().and_then(marker);
    if options.refresh_only && ownership.is_none() || options.remove && before.bytes.is_none() {
        return Ok("skipped");
    }
    if before.bytes.is_some() && ownership.is_none() {
        return Err(diagnostic(
            Code::OwnershipConflict,
            "The existing Skill has no valid managed marker; it is not owned by SpecGit.",
        ));
    }
    evidence.edited = ownership.is_some_and(|(body, digest, trailing_content)| {
        trailing_content || assets::hash(body) != digest
    });
    if options.remove && evidence.edited {
        return Err(diagnostic(
            Code::OwnershipConflict,
            "The managed Skill was edited; removal would discard user content.",
        ));
    }
    evidence.action = if options.remove {
        "remove"
    } else if before.bytes.is_some() {
        "refresh"
    } else {
        "install"
    };
    if options.dry_run {
        return Ok("prepared");
    }

    // Lock the existing asset itself, not a global lock/receipt. Recheck after
    // locking because another installer can have replaced the inode while waiting.
    let lock = if before.bytes.is_some() {
        let file = assets::open_regular(&path).map_err(io_error)?;
        file.try_lock().map_err(|_| {
            diagnostic(
                Code::LockBusy,
                "The user Skill is busy; retry after the other operation finishes.",
            )
        })?;
        Some(file)
    } else {
        None
    };
    recheck(&path, &before, lock.as_ref())?;
    if options.remove {
        let index = effects.begin("local", "remove_user_skill", json!({"path":path}));
        fs::remove_file(&path).map_err(io_error)?;
        effects.applied(index);
        drop(lock);
        // Remove only the empty leaf directory. Never delete unrelated parent assets.
        match fs::remove_dir(path.parent().expect("fixed Skill parent")) {
            Ok(()) => {}
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::DirectoryNotEmpty | std::io::ErrorKind::NotFound
                ) => {}
            Err(e) => return Err(io_error(e)),
        }
        return Ok("removed");
    }
    let after = managed_bytes();
    if before.bytes.as_deref() == Some(after.as_slice()) {
        return Ok("refreshed");
    }
    let parent = path.parent().expect("fixed Skill parent");
    assets::safe_path(parent)?;
    fs::create_dir_all(parent).map_err(io_error)?;
    assets::safe_path(&path)?;
    if evidence.edited {
        let seconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| diagnostic(Code::IoFailed, "The backup clock is unavailable."))?
            .as_secs();
        // create-new publication prevents overwriting a previous backup, including
        // same-second refreshes and dangling links with the same name.
        for suffix in 0..1000 {
            let name = if suffix == 0 {
                format!("SKILL.md.specgit-backup-{seconds}")
            } else {
                format!("SKILL.md.specgit-backup-{seconds}-{suffix}")
            };
            let backup = parent.join(name);
            if fs::symlink_metadata(&backup).is_ok() {
                continue;
            }
            assets::safe_path(&backup)?;
            let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(io_error)?;
            staged
                .write_all(before.bytes.as_deref().expect("edited file exists"))
                .map_err(io_error)?;
            if let Some(permissions) = &before.permissions {
                staged
                    .as_file()
                    .set_permissions(permissions.clone())
                    .map_err(io_error)?;
            }
            staged.as_file().sync_all().map_err(io_error)?;
            recheck(&path, &before, lock.as_ref())?;
            let index = effects.begin("local", "backup_user_skill", json!({"path":backup}));
            match staged.persist_noclobber(&backup) {
                Ok(_) => {
                    effects.applied(index);
                    evidence.backup = Some(backup);
                    #[cfg(unix)]
                    fs::File::open(parent)
                        .and_then(|file| file.sync_all())
                        .map_err(io_error)?;
                    break;
                }
                Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {
                    effects.operations[index].outcome = "not_applied";
                }
                Err(e) => return Err(io_error(e.error)),
            }
        }
        if evidence.backup.is_none() {
            return Err(diagnostic(
                Code::OwnershipConflict,
                "No unused backup name is available; the edited Skill is retained.",
            ));
        }
    }
    recheck(&path, &before, lock.as_ref())?;
    let index = effects.begin(
        "local",
        "write_user_skill",
        json!({"path":path,"backup":evidence.backup}),
    );
    let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(io_error)?;
    staged.write_all(&after).map_err(io_error)?;
    if let Some(permissions) = &before.permissions {
        staged
            .as_file()
            .set_permissions(permissions.clone())
            .map_err(io_error)?;
    }
    staged.as_file().sync_all().map_err(io_error)?;
    recheck(&path, &before, lock.as_ref())?;
    // Windows refuses to replace a file while any handle to it is open,
    // including our own lock handle. Release it and recheck through a fresh
    // read immediately before the replacement.
    #[cfg(windows)]
    {
        drop(lock);
        recheck(&path, &before, None)?;
    }
    if before.bytes.is_none() {
        staged.persist_noclobber(&path).map_err(|e| {
            if e.error.kind() == std::io::ErrorKind::AlreadyExists {
                diagnostic(
                    Code::ConcurrentEdit,
                    "A Skill appeared during installation; it was not overwritten.",
                )
            } else {
                io_error(e.error)
            }
        })?;
    } else {
        staged.persist(&path).map_err(|e| io_error(e.error))?;
    }
    effects.applied(index);
    #[cfg(not(windows))]
    drop(lock);
    #[cfg(unix)]
    fs::File::open(parent)
        .and_then(|file| file.sync_all())
        .map_err(io_error)?;
    Ok(if evidence.action == "install" {
        "installed"
    } else {
        "refreshed"
    })
}
