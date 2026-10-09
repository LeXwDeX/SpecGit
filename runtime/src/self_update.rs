//! Verified replacement of the running shared CLI from signed GitHub Releases.
//! The authenticated `gh` CLI is the only transport. Cosign, the signed manifest
//! and a version smoke check gate every byte before the running executable is
//! replaced; there is no skip path and no project-local installation.
use crate::{
    diagnostic::{Code, Diagnostic, classify_failure},
    process::{Limits, Process, Request, resolve_executable},
    report::{Effects, Report},
};
use clap::Args;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    cmp::Ordering,
    ffi::OsString,
    fmt, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

pub const REPOSITORY: &str = "LeXwDeX/SpecGit";
pub const API_HOST: &str = "github.com";
pub const CERTIFICATE_IDENTITY: &str =
    "https://github.com/LeXwDeX/SpecGit/.github/workflows/release-prepare.yml@refs/heads/main";
pub const CERTIFICATE_OIDC_ISSUER: &str = "https://token.actions.githubusercontent.com";
pub const MANIFEST: &str = "SHA256SUMS";
pub const SIGNATURE_BUNDLE: &str = "SHA256SUMS.sigstore.json";
/// Largest release archive accepted from the transport.
pub const MAX_ARCHIVE_BYTES: usize = 32 * 1024 * 1024;
/// Largest executable accepted after decompression.
pub const MAX_EXECUTABLE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SIDECAR_BYTES: usize = 1024 * 1024;
const MAX_METADATA_BYTES: usize = 4 * 1024 * 1024;
const MAX_RELEASE_ASSETS: usize = 100;
const METADATA_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(180);
const COSIGN_TIMEOUT: Duration = Duration::from_secs(120);
const SMOKE_TIMEOUT: Duration = Duration::from_secs(20);
const OPERATION: &str = "update";

#[derive(Clone, Args, Default)]
pub struct Options {
    /// Read-only: compare the running version with the target release; nothing is downloaded or written.
    #[arg(long, conflicts_with = "dry_run")]
    pub check: bool,
    /// Download and fully verify the release in a temporary directory without replacing the executable.
    #[arg(long)]
    pub dry_run: bool,
    /// Select an exact release (x.y.z) instead of the latest stable one; an older version is a downgrade.
    #[arg(long = "version", value_name = "X.Y.Z", value_parser = version_argument)]
    pub target_version: Option<String>,
}

fn version_argument(value: &str) -> Result<String, String> {
    Version::parse(value)
        .map(|version| version.to_string())
        .ok_or_else(|| "expected a stable release version x.y.z".into())
}

/// A stable release version. Pre-release and build suffixes are not accepted.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version(u64, u64, u64);
impl Version {
    pub fn parse(text: &str) -> Option<Self> {
        let mut parts = text.split('.');
        let mut next = || {
            let part = parts.next()?;
            if part.is_empty()
                || part.len() > 9
                || !part.bytes().all(|b| b.is_ascii_digit())
                || (part.len() > 1 && part.starts_with('0'))
            {
                return None;
            }
            part.parse().ok()
        };
        let version = Self(next()?, next()?, next()?);
        parts.next().is_none().then_some(version)
    }
}
impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.0, self.1, self.2)
    }
}

/// Map a compile-time target to its release asset platform.
pub fn platform_for(os: &str, arch: &str, env: &str) -> Option<&'static str> {
    match (os, arch, env) {
        ("macos", "aarch64", _) => Some("darwin-arm64"),
        ("linux", "x86_64", "gnu") => Some("linux-x64-gnu"),
        ("windows", "x86_64", _) => Some("win32-x64"),
        _ => None,
    }
}

pub fn current_platform() -> Option<&'static str> {
    let env = if cfg!(target_env = "gnu") {
        "gnu"
    } else if cfg!(target_env = "musl") {
        "musl"
    } else if cfg!(target_env = "msvc") {
        "msvc"
    } else {
        ""
    };
    platform_for(std::env::consts::OS, std::env::consts::ARCH, env)
}

pub fn archive_name(version: Version, platform: &str) -> String {
    format!("specgit-{version}-{platform}.zip")
}

pub fn executable_name(platform: &str) -> &'static str {
    if platform.starts_with("win32") {
        "specgit.exe"
    } else {
        "specgit"
    }
}

fn rejected(operation: &str, message: &str, remedy: &str) -> Diagnostic {
    Diagnostic::new(Code::EvidenceRejected, operation, message, remedy)
}

const DO_NOT_INSTALL: &str =
    "Do not install this release; report the failed verification. Nothing was replaced.";

fn io_failed(operation: &str, message: &str) -> Diagnostic {
    Diagnostic::new(
        Code::IoFailed,
        operation,
        message,
        "Check the temporary directory and executable location, then retry.",
    )
}

fn not_writable(dir: &Path) -> Diagnostic {
    Diagnostic::new(
        Code::PermissionDenied,
        "update_install",
        &format!(
            "The executable directory {} is not writable by this user.",
            dir.display()
        ),
        "Rerun as the user that owns the shared executable, or follow the manual installation guide. Nothing was replaced.",
    )
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Return the digest from the single exact manifest row for `asset`.
pub fn manifest_digest(manifest: &[u8], asset: &str) -> Result<String, Diagnostic> {
    let malformed = || {
        rejected(
            "update_manifest",
            "The signed SHA256SUMS manifest is malformed.",
            DO_NOT_INSTALL,
        )
    };
    let text = std::str::from_utf8(manifest).map_err(|_| malformed())?;
    let body = text.strip_suffix('\n').unwrap_or(text);
    if body.is_empty() {
        return Err(malformed());
    }
    let mut rows = vec![];
    for line in body.split('\n') {
        let (digest, name) = line.split_once("  ").ok_or_else(malformed)?;
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            || name.is_empty()
            || name
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || c == '/' || c == '\\')
        {
            return Err(malformed());
        }
        if name == asset {
            rows.push(digest.to_owned());
        }
    }
    match rows.len() {
        1 => Ok(rows.remove(0)),
        0 => Err(rejected(
            "update_manifest",
            "The signed SHA256SUMS manifest has no row for the selected archive.",
            DO_NOT_INSTALL,
        )),
        _ => Err(rejected(
            "update_manifest",
            "The signed SHA256SUMS manifest has duplicate rows for the selected archive.",
            DO_NOT_INSTALL,
        )),
    }
}

/// Read exactly one regular `entry` from a ZIP archive within `limit` bytes.
pub fn extract_executable(archive: &[u8], entry: &str, limit: u64) -> Result<Vec<u8>, Diagnostic> {
    let invalid = |message: &str| rejected("update_archive", message, DO_NOT_INSTALL);
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive))
        .map_err(|_| invalid("The release archive is not a readable ZIP file."))?;
    if zip.len() != 1 {
        return Err(invalid(
            "The release archive must contain exactly one entry.",
        ));
    }
    let mut file = zip
        .by_index(0)
        .map_err(|_| invalid("The release archive entry is unreadable or unsupported."))?;
    if file.name() != entry
        || file.enclosed_name().as_deref() != Some(Path::new(entry))
        || !file.is_file()
        || file.encrypted()
    {
        return Err(invalid(
            "The release archive entry is not the expected regular executable.",
        ));
    }
    let declared = file.size();
    if declared == 0 || declared > limit {
        return Err(invalid(
            "The release executable is empty or exceeds its bounded size.",
        ));
    }
    let mut bytes = Vec::with_capacity(declared as usize);
    (&mut file)
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| invalid("The release archive entry could not be decompressed."))?;
    if bytes.len() as u64 != declared {
        return Err(invalid(
            "The release executable size differs from its archive entry.",
        ));
    }
    Ok(bytes)
}

#[derive(Deserialize)]
struct ReleaseDocument {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<AssetDocument>,
}
#[derive(Deserialize, Clone)]
struct AssetDocument {
    id: u64,
    name: String,
    size: u64,
    #[serde(default)]
    state: Option<String>,
}
struct Release {
    version: Version,
    tag: String,
    assets: Vec<AssetDocument>,
}

fn select_asset(
    assets: &[AssetDocument],
    name: &str,
    limit: usize,
) -> Result<AssetDocument, Diagnostic> {
    let mut matches = assets.iter().filter(|asset| asset.name == name);
    let (Some(asset), None) = (matches.next(), matches.next()) else {
        return Err(rejected(
            "update_release",
            &format!("The release does not contain exactly one {name} asset."),
            "Use a release that publishes the signed ZIP, SHA256SUMS and SHA256SUMS.sigstore.json, or install manually.",
        ));
    };
    if asset.id == 0
        || asset
            .state
            .as_deref()
            .is_some_and(|state| state != "uploaded")
        || asset.size == 0
        || asset.size > limit as u64
    {
        return Err(rejected(
            "update_release",
            &format!("The release asset {name} is incomplete or exceeds its bounded size."),
            DO_NOT_INSTALL,
        ));
    }
    Ok(asset.clone())
}

fn bounded(process: &Process, timeout: Duration, output_bytes: usize) -> Process {
    let mut process = process.clone();
    process.limits = Limits {
        timeout,
        output_bytes,
        ..Limits::default()
    };
    process
}

struct Transport<'a> {
    process: &'a Process,
    gh: PathBuf,
    cwd: &'a Path,
}
impl Transport<'_> {
    async fn release(&self, requested: Option<Version>) -> Result<Release, Diagnostic> {
        let route = match requested {
            Some(version) => format!("repos/{REPOSITORY}/releases/tags/v{version}"),
            None => format!("repos/{REPOSITORY}/releases/latest"),
        };
        let operation = "github_release_read";
        let output = bounded(self.process, METADATA_TIMEOUT, MAX_METADATA_BYTES)
            .run(Request::new(&self.gh, self.cwd, operation).args([
                "api",
                "--hostname",
                API_HOST,
                "--method",
                "GET",
                &route,
            ]))
            .await?;
        if output.code != 0 {
            return Err(classify_failure(operation, &output.stderr));
        }
        let document: ReleaseDocument = serde_json::from_slice(&output.stdout).map_err(|_| {
            Diagnostic::new(
                Code::MalformedResponse,
                operation,
                "The release API returned malformed JSON.",
                "Check the gh version and GitHub availability, then retry.",
            )
        })?;
        let version = document
            .tag_name
            .strip_prefix('v')
            .and_then(Version::parse)
            .filter(|version| requested.is_none_or(|requested| requested == *version))
            .ok_or_else(|| {
                rejected(
                    operation,
                    "The release tag is not the expected v<x.y.z> tag.",
                    DO_NOT_INSTALL,
                )
            })?;
        if document.draft || (requested.is_none() && document.prerelease) {
            return Err(rejected(
                operation,
                "The selected release is a draft or pre-release, not a stable published release.",
                "Select a published stable release with --version, or wait for publication.",
            ));
        }
        if document.assets.len() > MAX_RELEASE_ASSETS {
            return Err(rejected(
                operation,
                "The release lists more assets than this command accepts.",
                DO_NOT_INSTALL,
            ));
        }
        Ok(Release {
            version,
            tag: format!("v{version}"),
            assets: document.assets,
        })
    }

    async fn download(&self, asset: &AssetDocument, limit: usize) -> Result<Vec<u8>, Diagnostic> {
        let route = format!("repos/{REPOSITORY}/releases/assets/{}", asset.id);
        let operation = "github_release_download";
        let result = bounded(self.process, DOWNLOAD_TIMEOUT, limit)
            .run(Request::new(&self.gh, self.cwd, operation).args([
                "api",
                "--hostname",
                API_HOST,
                "--method",
                "GET",
                "-H",
                "Accept: application/octet-stream",
                &route,
            ]))
            .await;
        let output = match result {
            Err(diagnostic) if diagnostic.code == Code::OutputLimit => {
                return Err(rejected(
                    operation,
                    "A release asset exceeded its bounded download size.",
                    DO_NOT_INSTALL,
                ));
            }
            other => other?,
        };
        if output.code != 0 {
            return Err(classify_failure(operation, &output.stderr));
        }
        if output.stdout.len() as u64 != asset.size {
            return Err(rejected(
                operation,
                "A downloaded release asset size differs from the release metadata.",
                DO_NOT_INSTALL,
            ));
        }
        Ok(output.stdout)
    }
}

async fn verify_signature(
    process: &Process,
    cwd: &Path,
    bundle: &Path,
    manifest: &Path,
) -> Result<(), Diagnostic> {
    let operation = "cosign_verify";
    let cosign = resolve_executable("cosign").map_err(|_| {
        Diagnostic::new(
            Code::MissingExecutable,
            operation,
            "Cosign is required to verify the signed release manifest.",
            "Install Cosign 3.1.3 or a compatible newer release (https://docs.sigstore.dev/cosign/system_config/installation/), then retry. Verification cannot be skipped.",
        )
    })?;
    let args: Vec<OsString> = vec![
        "verify-blob".into(),
        "--bundle".into(),
        bundle.into(),
        "--certificate-identity".into(),
        CERTIFICATE_IDENTITY.into(),
        "--certificate-oidc-issuer".into(),
        CERTIFICATE_OIDC_ISSUER.into(),
        manifest.into(),
    ];
    let output = bounded(process, COSIGN_TIMEOUT, MAX_METADATA_BYTES)
        .run(Request::new(cosign, cwd, operation).args(args))
        .await?;
    if output.code != 0 {
        return Err(rejected(
            operation,
            "The release manifest signature did not verify against the SpecGit release workflow identity.",
            DO_NOT_INSTALL,
        ));
    }
    Ok(())
}

/// Run `<executable> --human --version` and parse `specgit <x.y.z>`.
async fn reported_version(
    process: &Process,
    executable: &Path,
    cwd: &Path,
    operation: &str,
) -> Result<Option<Version>, Diagnostic> {
    let result = bounded(process, SMOKE_TIMEOUT, 64 * 1024)
        .run(Request::new(executable, cwd, operation).args(["--human", "--version"]))
        .await;
    let output = match result {
        Err(diagnostic) if diagnostic.code == Code::Cancelled => return Err(diagnostic),
        Err(_) => return Ok(None),
        Ok(output) => output,
    };
    if output.code != 0 {
        return Ok(None);
    }
    Ok(std::str::from_utf8(&output.stdout)
        .ok()
        .and_then(|text| text.trim().strip_prefix("specgit "))
        .and_then(Version::parse))
}

fn install_target() -> Result<PathBuf, Diagnostic> {
    // Tests install into a temporary location; release builds always replace
    // only the executable that is running.
    #[cfg(feature = "test-fixtures")]
    if let Some(path) = std::env::var_os("SPECGIT_TEST_UPDATE_TARGET") {
        return regular_file(PathBuf::from(path));
    }
    regular_file(std::env::current_exe().unwrap_or_default())
}

fn regular_file(path: PathBuf) -> Result<PathBuf, Diagnostic> {
    path.canonicalize()
        .ok()
        .filter(|path| path.is_file())
        .ok_or_else(|| {
            Diagnostic::new(
                Code::IoFailed,
                OPERATION,
                "The running executable path is unavailable.",
                "Run the shared specgit executable directly, or follow the manual installation guide.",
            )
        })
}

fn set_executable(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn write_new(path: &Path, bytes: &[u8], executable: bool) -> Result<(), Diagnostic> {
    let write = || -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        if executable {
            set_executable(path)?;
        }
        Ok(())
    };
    write().map_err(|_| io_failed(OPERATION, "A verified release file could not be staged."))
}

/// Replacement strategy for the running executable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Strategy {
    /// Copy a backup, then atomically rename the new file over the executable.
    AtomicReplace,
    /// Rename the running executable aside as the backup, then move the new file in.
    /// Windows cannot replace a running executable but can rename it.
    RenameAside,
}
impl Strategy {
    pub fn native() -> Self {
        if cfg!(windows) {
            Self::RenameAside
        } else {
            Self::AtomicReplace
        }
    }
}

/// Choose an unused backup path beside `target`, labelled with the previous version.
pub fn backup_path(target: &Path, previous: &str) -> Result<PathBuf, Diagnostic> {
    let dir = target.parent().ok_or_else(|| not_writable(target))?;
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "specgit".into());
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if extension.eq_ignore_ascii_case("exe") && !stem.is_empty() => {
            (stem.to_owned(), format!(".{extension}"))
        }
        _ => (name, String::new()),
    };
    (0..100)
        .map(|n| {
            let suffix = if n == 0 {
                String::new()
            } else {
                format!("-{n}")
            };
            dir.join(format!("{stem}.backup-{previous}{suffix}{extension}"))
        })
        .find(|candidate| fs::symlink_metadata(candidate).is_err())
        .ok_or_else(|| {
            Diagnostic::new(
                Code::OwnershipConflict,
                "update_install",
                "Too many previous backups exist beside the executable.",
                "Review and remove old specgit.backup-* files you no longer need, then retry.",
            )
        })
}

fn copy_new(source: &Path, destination: &Path) -> std::io::Result<()> {
    let copy = || -> std::io::Result<()> {
        let mut input = fs::File::open(source)?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)?;
        std::io::copy(&mut input, &mut output)?;
        output.set_permissions(input.metadata()?.permissions())?;
        output.sync_all()
    };
    copy().inspect_err(|_| {
        let _ = fs::remove_file(destination);
    })
}

/// Replace `target` with `bytes`, keeping the previous executable at the
/// returned backup path. On failure the target is unchanged or restored.
pub fn install(
    target: &Path,
    bytes: &[u8],
    previous: &str,
    strategy: Strategy,
) -> Result<PathBuf, Diagnostic> {
    let operation = "update_install";
    let dir = target.parent().ok_or_else(|| not_writable(target))?;
    let mut staged = tempfile::Builder::new()
        .prefix(".specgit-update-")
        .tempfile_in(dir)
        .map_err(|_| not_writable(dir))?;
    staged
        .write_all(bytes)
        .and_then(|()| staged.as_file().sync_all())
        .and_then(|()| set_executable(staged.path()))
        .map_err(|_| io_failed(operation, "The new executable could not be staged."))?;
    let backup = backup_path(target, previous)?;
    match strategy {
        Strategy::AtomicReplace => {
            copy_new(target, &backup).map_err(|_| not_writable(dir))?;
            if staged.persist(target).is_err() {
                let _ = fs::remove_file(&backup);
                return Err(io_failed(
                    operation,
                    "The new executable could not be moved into place; the executable is unchanged.",
                ));
            }
        }
        Strategy::RenameAside => {
            fs::rename(target, &backup).map_err(|_| not_writable(dir))?;
            if staged.persist(target).is_err() {
                if fs::rename(&backup, target).is_err() {
                    return Err(Diagnostic::new(
                        Code::RollbackConflict,
                        operation,
                        &format!(
                            "The new executable could not be moved into place and the previous executable remains at {}.",
                            backup.display()
                        ),
                        &format!(
                            "Move {} back to {} before running specgit again.",
                            backup.display(),
                            target.display()
                        ),
                    ));
                }
                return Err(io_failed(
                    operation,
                    "The new executable could not be moved into place; the previous executable was restored.",
                ));
            }
        }
    }
    #[cfg(unix)]
    if let Ok(directory) = fs::File::open(dir) {
        let _ = directory.sync_all();
    }
    Ok(backup)
}

#[derive(Serialize)]
struct Verification {
    signature: &'static str,
    certificate_identity: &'static str,
    certificate_oidc_issuer: &'static str,
    manifest_row: &'static str,
    archive_sha256: String,
    executable_sha256: String,
    extracted_version: String,
}

#[derive(Serialize)]
struct Installation {
    executable: String,
    backup: String,
    previous_version: String,
    installed_version: String,
    executable_sha256: String,
}

#[derive(Serialize)]
struct Evidence {
    mode: &'static str,
    repository: &'static str,
    platform: Option<&'static str>,
    executable: Option<String>,
    current_version: &'static str,
    target_source: &'static str,
    target_version: Option<String>,
    release_tag: Option<String>,
    direction: Option<&'static str>,
    update_available: bool,
    asset: Option<String>,
    verification: Option<Verification>,
    installation: Option<Installation>,
}

pub async fn run(options: Options, process: Process) -> Report {
    let mut evidence = Evidence {
        mode: if options.check {
            "check"
        } else if options.dry_run {
            "dry_run"
        } else {
            "apply"
        },
        repository: REPOSITORY,
        platform: None,
        executable: None,
        current_version: env!("CARGO_PKG_VERSION"),
        target_source: if options.target_version.is_some() {
            "requested"
        } else {
            "latest"
        },
        target_version: None,
        release_tag: None,
        direction: None,
        update_available: false,
        asset: None,
        verification: None,
        installation: None,
    };
    let mut effects = None;
    let result = update(&options, &process, &mut evidence, &mut effects).await;
    let mut report = match result {
        Ok(status) => Report::success(OPERATION, status, &evidence),
        Err(diagnostic) => {
            let mut report = Report::failure(OPERATION, diagnostic);
            report.evidence = serde_json::to_value(&evidence).unwrap_or_default();
            report
        }
    };
    if let Some(installation) = &evidence.installation {
        report.next_actions.push(json!({"kind":"rollback_available","executable":installation.executable,"backup":installation.backup,"remedy":"To roll back, stop running specgit processes and move the backup over the executable path. Project configuration is unchanged."}));
    } else if report.exit == 0 && evidence.update_available {
        report.next_actions.push(json!({"kind":"apply_update","remedy":"Preview with specgit update --dry-run, then apply with specgit update (add the same --version selection)."}));
    }
    report.effects = effects;
    report
}

async fn update(
    options: &Options,
    process: &Process,
    evidence: &mut Evidence,
    effects: &mut Option<Effects>,
) -> Result<&'static str, Diagnostic> {
    let platform = current_platform().ok_or_else(|| {
        Diagnostic::new(
            Code::UnsupportedOperation,
            OPERATION,
            "No signed SpecGit release is published for this platform.",
            "Use macOS arm64, Linux x64 glibc or Windows x64, or build from source.",
        )
    })?;
    evidence.platform = Some(platform);
    let current = Version::parse(env!("CARGO_PKG_VERSION")).ok_or_else(|| {
        Diagnostic::new(
            Code::UnsupportedOperation,
            OPERATION,
            "This build does not carry a stable release version.",
            "Install a released SpecGit executable from GitHub Releases.",
        )
    })?;
    let requested = match options.target_version.as_deref() {
        Some(text) => Some(Version::parse(text).ok_or_else(|| {
            Diagnostic::input("--version must be a stable release version x.y.z.")
        })?),
        None => None,
    };
    let target = install_target()?;
    evidence.executable = Some(target.display().to_string());
    let gh = resolve_executable("gh").map_err(|_| {
        Diagnostic::new(
            Code::MissingExecutable,
            "github_release_read",
            "The authenticated GitHub CLI (gh) is required to read SpecGit releases.",
            "Install gh and run gh auth login for github.com, then retry.",
        )
    })?;
    let workspace = tempfile::Builder::new()
        .prefix("specgit-update-")
        .tempdir()
        .map_err(|_| io_failed(OPERATION, "A temporary directory could not be created."))?;
    let cwd = workspace
        .path()
        .canonicalize()
        .map_err(|_| io_failed(OPERATION, "The temporary directory is unavailable."))?;
    let transport = Transport {
        process,
        gh,
        cwd: &cwd,
    };

    let release = transport.release(requested).await?;
    evidence.target_version = Some(release.version.to_string());
    evidence.release_tag = Some(release.tag.clone());
    let direction = match release.version.cmp(&current) {
        Ordering::Equal => "same",
        Ordering::Greater => "upgrade",
        Ordering::Less if requested.is_some() => "downgrade",
        Ordering::Less => "current_newer",
    };
    evidence.direction = Some(direction);
    evidence.update_available = matches!(direction, "upgrade" | "downgrade");
    if !evidence.update_available {
        return Ok(if direction == "same" {
            "up_to_date"
        } else {
            "current_newer"
        });
    }

    let archive = archive_name(release.version, platform);
    evidence.asset = Some(archive.clone());
    let archive_asset = select_asset(&release.assets, &archive, MAX_ARCHIVE_BYTES)?;
    let manifest_asset = select_asset(&release.assets, MANIFEST, MAX_SIDECAR_BYTES)?;
    let bundle_asset = select_asset(&release.assets, SIGNATURE_BUNDLE, MAX_SIDECAR_BYTES)?;
    if options.check {
        return Ok(if direction == "upgrade" {
            "update_available"
        } else {
            "downgrade_available"
        });
    }
    let apply = !options.dry_run;
    let directory = target.parent().ok_or_else(|| not_writable(&target))?;
    if apply {
        // Fail before any download when the executable cannot be replaced.
        tempfile::Builder::new()
            .prefix(".specgit-update-")
            .tempfile_in(directory)
            .map_err(|_| not_writable(directory))?;
    }

    let manifest = transport
        .download(&manifest_asset, MAX_SIDECAR_BYTES)
        .await?;
    let bundle = transport.download(&bundle_asset, MAX_SIDECAR_BYTES).await?;
    let archive_bytes = transport
        .download(&archive_asset, MAX_ARCHIVE_BYTES)
        .await?;
    let manifest_path = cwd.join(MANIFEST);
    let bundle_path = cwd.join(SIGNATURE_BUNDLE);
    write_new(&manifest_path, &manifest, false)?;
    write_new(&bundle_path, &bundle, false)?;
    verify_signature(process, &cwd, &bundle_path, &manifest_path).await?;
    let expected = manifest_digest(&manifest, &archive)?;
    let archive_sha256 = sha256_hex(&archive_bytes);
    if expected != archive_sha256 {
        return Err(rejected(
            "update_archive",
            "The release archive SHA-256 does not match its signed manifest row.",
            DO_NOT_INSTALL,
        ));
    }
    let name = executable_name(platform);
    let executable = extract_executable(&archive_bytes, name, MAX_EXECUTABLE_BYTES)?;
    let executable_sha256 = sha256_hex(&executable);
    let extracted_dir = cwd.join("extracted");
    fs::create_dir(&extracted_dir)
        .map_err(|_| io_failed(OPERATION, "The extraction directory could not be created."))?;
    let extracted = extracted_dir.join(name);
    write_new(&extracted, &executable, true)?;
    if reported_version(process, &extracted, &cwd, "update_smoke").await? != Some(release.version) {
        return Err(rejected(
            "update_smoke",
            "The extracted executable does not report the release version.",
            DO_NOT_INSTALL,
        ));
    }
    evidence.verification = Some(Verification {
        signature: "verified",
        certificate_identity: CERTIFICATE_IDENTITY,
        certificate_oidc_issuer: CERTIFICATE_OIDC_ISSUER,
        manifest_row: "matched",
        archive_sha256,
        executable_sha256: executable_sha256.clone(),
        extracted_version: release.version.to_string(),
    });
    if !apply {
        return Ok("verified");
    }

    let backup = install(
        &target,
        &executable,
        &current.to_string(),
        Strategy::native(),
    )?;
    let mut journal = Effects::default();
    let replaced = journal.begin(
        "local",
        "replace_executable",
        json!({"executable":target.display().to_string(),"backup":backup.display().to_string(),"restore":"Move the backup over the executable path to roll back."}),
    );
    journal.applied(replaced);
    *effects = Some(journal);
    let installed_matches = fs::read(&target)
        .map(|bytes| sha256_hex(&bytes) == executable_sha256)
        .unwrap_or(false)
        && reported_version(process, &target, &cwd, "update_readback").await?
            == Some(release.version);
    if !installed_matches {
        let restored = fs::rename(&backup, &target).is_ok();
        if let Some(journal) = effects.as_mut()
            && restored
        {
            let index = journal.begin(
                "local",
                "restore_executable",
                json!({"executable":target.display().to_string()}),
            );
            journal.applied(index);
        }
        return Err(Diagnostic::new(
            if restored {
                Code::EvidenceRejected
            } else {
                Code::RollbackConflict
            },
            "update_readback",
            if restored {
                "The installed executable failed readback; the previous executable was restored."
            } else {
                "The installed executable failed readback and the backup could not be restored."
            },
            &format!(
                "Move {} over {} if it is still present, then reinstall manually.",
                backup.display(),
                target.display()
            ),
        ));
    }
    evidence.installation = Some(Installation {
        executable: target.display().to_string(),
        backup: backup.display().to_string(),
        previous_version: current.to_string(),
        installed_version: release.version.to_string(),
        executable_sha256,
    });
    Ok(if direction == "upgrade" {
        "updated"
    } else {
        "downgraded"
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

    fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in entries {
            let options = SimpleFileOptions::default()
                .compression_method(CompressionMethod::Deflated)
                .unix_permissions(0o755);
            if name.ends_with('/') {
                writer.add_directory(*name, options).unwrap();
            } else {
                writer.start_file(*name, options).unwrap();
                writer.write_all(bytes).unwrap();
            }
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn platform_mapping_covers_release_targets_only() {
        assert_eq!(platform_for("macos", "aarch64", ""), Some("darwin-arm64"));
        assert_eq!(
            platform_for("linux", "x86_64", "gnu"),
            Some("linux-x64-gnu")
        );
        assert_eq!(platform_for("windows", "x86_64", "msvc"), Some("win32-x64"));
        for (os, arch, env) in [
            ("linux", "x86_64", "musl"),
            ("linux", "aarch64", "gnu"),
            ("macos", "x86_64", ""),
            ("windows", "aarch64", "msvc"),
            ("freebsd", "x86_64", ""),
        ] {
            assert_eq!(platform_for(os, arch, env), None, "{os} {arch} {env}");
        }
        assert_eq!(executable_name("win32-x64"), "specgit.exe");
        assert_eq!(executable_name("linux-x64-gnu"), "specgit");
        assert_eq!(
            archive_name(Version(2, 6, 0), "darwin-arm64"),
            "specgit-2.6.0-darwin-arm64.zip"
        );
    }

    #[test]
    fn versions_are_strict_stable_triples() {
        assert_eq!(Version::parse("2.10.0"), Some(Version(2, 10, 0)));
        assert!(Version::parse("2.10.0") > Version::parse("2.9.9"));
        for invalid in [
            "",
            "2",
            "2.6",
            "2.6.0.1",
            "v2.6.0",
            "2.6.0-rc1",
            "02.6.0",
            "2..0",
            "2.6.x",
            " 2.6.0",
        ] {
            assert_eq!(Version::parse(invalid), None, "{invalid}");
        }
        assert!(version_argument("1.2").is_err());
        assert_eq!(version_argument("1.2.3").unwrap(), "1.2.3");
    }

    #[test]
    fn manifest_requires_one_exact_well_formed_row() {
        let digest = "a".repeat(64);
        let other = "b".repeat(64);
        let good = format!(
            "{other}  specgit-1.0.0-linux-x64-gnu.zip\n{digest}  specgit-1.0.0-darwin-arm64.zip\n"
        );
        assert_eq!(
            manifest_digest(good.as_bytes(), "specgit-1.0.0-darwin-arm64.zip").unwrap(),
            digest
        );
        for (manifest, asset) in [
            (good.clone(), "specgit-1.0.0-win32-x64.zip"),
            (format!("{digest}  x.zip\n{other}  x.zip\n"), "x.zip"),
            (format!("{digest} x.zip\n"), "x.zip"),
            (format!("{}  x.zip\n", "A".repeat(64)), "x.zip"),
            (format!("{}  x.zip\n", "a".repeat(63)), "x.zip"),
            (format!("{digest}  x.zip\r\n"), "x.zip"),
            (format!("{digest}  x.zip\n\n"), "x.zip"),
            (format!("{digest}  dir/x.zip\n"), "dir/x.zip"),
            (String::new(), "x.zip"),
        ] {
            let error = manifest_digest(manifest.as_bytes(), asset).unwrap_err();
            assert_eq!(error.code, Code::EvidenceRejected, "{manifest:?}");
        }
        assert!(manifest_digest(&[0xff, 0xfe], "x.zip").is_err());
    }

    #[test]
    fn archive_extraction_accepts_only_one_bounded_regular_entry() {
        let good = archive(&[("specgit", b"binary")]);
        assert_eq!(extract_executable(&good, "specgit", 64).unwrap(), b"binary");
        for (bytes, limit) in [
            (archive(&[("specgit.exe", b"binary")]), 64),
            (archive(&[("specgit", b"a"), ("other", b"b")]), 64),
            (archive(&[("../specgit", b"binary")]), 64),
            (archive(&[("bin/specgit", b"binary")]), 64),
            (archive(&[("specgit/", b"")]), 64),
            (archive(&[("specgit", b"")]), 64),
            (archive(&[("specgit", &[0u8; 4096])]), 1024),
            (archive(&[]), 64),
            (b"not a zip".to_vec(), 64),
        ] {
            let error = extract_executable(&bytes, "specgit", limit).unwrap_err();
            assert_eq!(error.code, Code::EvidenceRejected);
        }
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .add_symlink("specgit", "/bin/sh", SimpleFileOptions::default())
            .unwrap();
        let link = writer.finish().unwrap().into_inner();
        assert!(extract_executable(&link, "specgit", 64).is_err());
    }

    #[test]
    fn both_install_strategies_keep_a_restorable_backup() {
        for strategy in [Strategy::AtomicReplace, Strategy::RenameAside] {
            let temp = tempfile::tempdir().unwrap();
            let target = temp.path().join("specgit.exe");
            fs::write(&target, b"old").unwrap();
            let backup = install(&target, b"new", "1.0.0", strategy).unwrap();
            assert_eq!(backup, temp.path().join("specgit.backup-1.0.0.exe"));
            assert_eq!(fs::read(&target).unwrap(), b"new");
            assert_eq!(fs::read(&backup).unwrap(), b"old");
            let second = install(&target, b"newer", "1.0.0", strategy).unwrap();
            assert_eq!(second, temp.path().join("specgit.backup-1.0.0-1.exe"));
            assert_eq!(fs::read(&second).unwrap(), b"new");
            let names: Vec<_> = fs::read_dir(temp.path())
                .unwrap()
                .map(|entry| entry.unwrap().file_name().into_string().unwrap())
                .collect();
            assert_eq!(names.len(), 3, "no staged files remain: {names:?}");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = fs::metadata(&target).unwrap().permissions().mode();
                assert_eq!(mode & 0o777, 0o755);
            }
        }
        assert_eq!(
            backup_path(Path::new("/opt/bin/specgit"), "2.5.0").unwrap(),
            Path::new("/opt/bin/specgit.backup-2.5.0")
        );
    }

    #[cfg(unix)]
    #[test]
    fn unwritable_directory_fails_closed_without_changes() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("specgit");
        fs::write(&target, b"old").unwrap();
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o555)).unwrap();
        let probe = temp.path().join("probe");
        if fs::write(&probe, b"").is_ok() {
            // Privileged users bypass directory permissions; nothing to prove.
            let _ = fs::remove_file(probe);
        } else {
            let error = install(&target, b"new", "1.0.0", Strategy::native()).unwrap_err();
            assert_eq!(error.code, Code::PermissionDenied);
            assert_eq!(fs::read(&target).unwrap(), b"old");
            assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
        }
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o755)).unwrap();
    }
}
