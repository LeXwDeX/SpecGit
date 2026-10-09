#![cfg(feature = "test-fixtures")]
//! `specgit update` against fixture `gh`/`cosign` executables and locally built
//! signed release assets. Every install goes to a temporary target; the shared
//! PATH executable is never replaced.
#[path = "support/executable.rs"]
mod executable;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use specgit::self_update;
use std::{
    fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
    process::Command,
};
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

const FIXTURE: &str = env!("CARGO_BIN_EXE_specgit-process-fixture");
const CURRENT: &str = env!("CARGO_PKG_VERSION");
const NEXT: &str = "9.0.0";
const OLD_BINARY: &[u8] = b"previous specgit executable";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Tamper {
    None,
    ManifestAfterSigning,
    WrongHash,
    MalformedManifest,
    MissingArchive,
    Oversize,
}

fn executable_file(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.into()
    }
}

fn hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn zip_bytes(entry: &str, bytes: &[u8]) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file(
            entry,
            SimpleFileOptions::default()
                .compression_method(CompressionMethod::Deflated)
                .unix_permissions(0o755),
        )
        .unwrap();
    writer.write_all(bytes).unwrap();
    writer.finish().unwrap().into_inner()
}

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    bin: PathBuf,
    target: PathBuf,
    platform: &'static str,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let root = base.join("release");
        fs::create_dir_all(root.join("assets")).unwrap();
        let bin = base.join("bin");
        fs::create_dir(&bin).unwrap();
        for name in ["gh", "cosign"] {
            fs::copy(FIXTURE, bin.join(executable_file(name))).unwrap();
        }
        let install = base.join("install");
        fs::create_dir(&install).unwrap();
        let target = install.join(executable_file("specgit"));
        fs::write(&target, OLD_BINARY).unwrap();
        let fixture = Self {
            _temp: temp,
            root,
            bin,
            target,
            platform: self_update::current_platform()
                .expect("update tests run on a published release platform"),
        };
        fixture
            .write_state(&json!({"latest":null,"releases":{},"binary_version":NEXT,"next_id":100}));
        fixture
    }

    fn state(&self) -> Value {
        serde_json::from_slice(&fs::read(self.root.join("state.json")).unwrap()).unwrap()
    }

    fn write_state(&self, state: &Value) {
        fs::write(self.root.join("state.json"), state.to_string()).unwrap();
    }

    fn publish(&self, version: &str, tamper: Tamper) {
        let mut state = self.state();
        let archive_name = format!("specgit-{version}-{}.zip", self.platform);
        let archive = zip_bytes(
            self_update::executable_name(self.platform),
            &fs::read(FIXTURE).unwrap(),
        );
        let digest = if tamper == Tamper::WrongHash {
            "0".repeat(64)
        } else {
            hex(&archive)
        };
        let mut manifest = String::new();
        for platform in ["linux-x64-gnu", "darwin-arm64", "win32-x64"] {
            let name = format!("specgit-{version}-{platform}.zip");
            let row = if name == archive_name {
                digest.clone()
            } else {
                "1".repeat(64)
            };
            manifest.push_str(&format!("{row}  {name}\n"));
        }
        if tamper == Tamper::MalformedManifest {
            manifest.push_str("not a manifest row\n");
        }
        let bundle = format!("fixture-signature:{}", hex(manifest.as_bytes()));
        if tamper == Tamper::ManifestAfterSigning {
            manifest = manifest.replacen(&"1".repeat(64), &"2".repeat(64), 1);
        }
        let mut assets = vec![];
        for (name, bytes) in [
            (archive_name.clone(), archive),
            ("SHA256SUMS".into(), manifest.into_bytes()),
            ("SHA256SUMS.sigstore.json".into(), bundle.into_bytes()),
        ] {
            let id = state["next_id"].as_u64().unwrap();
            state["next_id"] = json!(id + 1);
            if tamper == Tamper::MissingArchive && name == archive_name {
                continue;
            }
            if tamper == Tamper::Oversize && name == archive_name {
                state["oversize_asset"] = json!(id.to_string());
            }
            fs::write(self.root.join("assets").join(id.to_string()), &bytes).unwrap();
            assets.push(json!({"id":id,"name":name,"size":bytes.len(),"state":"uploaded","content_type":"application/octet-stream"}));
        }
        let tag = format!("v{version}");
        state["releases"][&tag] =
            json!({"tag_name":tag,"draft":false,"prerelease":false,"assets":assets});
        state["latest"] = json!(tag);
        self.write_state(&state);
    }

    fn command(&self, program: &Path) -> Command {
        let mut command = Command::new(program);
        command
            .env("PATH", &self.bin)
            .env("SPECGIT_FIXTURE_UPDATE_DIR", &self.root)
            .env("SPECGIT_TEST_UPDATE_TARGET", &self.target);
        command
    }

    /// Install-capable runs need the feature-gated target override.
    fn run(&self, args: &[&str]) -> Value {
        self.run_with(Path::new(env!("CARGO_BIN_EXE_specgit")), args)
    }

    /// Read-only runs also qualify a separately installed executable.
    fn run_installed(&self, args: &[&str]) -> Value {
        self.run_with(&executable::binary(), args)
    }

    fn run_with(&self, program: &Path, args: &[&str]) -> Value {
        let output = self
            .command(program)
            .args(args)
            .arg("--json")
            .output()
            .unwrap();
        let report: Value = serde_json::from_slice(&output.stdout)
            .unwrap_or_else(|_| panic!("stdout={:?} stderr={:?}", output.stdout, output.stderr));
        assert_eq!(report["exit"].as_i64(), output.status.code().map(i64::from));
        let schema: Value =
            serde_json::from_str(include_str!("../schemas/report.schema.json")).unwrap();
        jsonschema::draft202012::validate(&schema, &report).unwrap_or_else(|error| {
            panic!("report violates report.schema.json: {error}\n{report}")
        });
        report
    }

    fn calls(&self) -> Vec<Value> {
        fs::read_to_string(self.root.join("calls.log"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn roles(&self) -> Vec<String> {
        self.calls()
            .iter()
            .map(|call| call["role"].as_str().unwrap().to_owned())
            .collect()
    }

    fn assert_unchanged(&self) {
        assert_eq!(fs::read(&self.target).unwrap(), OLD_BINARY);
        let entries: Vec<_> = fs::read_dir(self.target.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(entries.len(), 1, "no backup or staged file: {entries:?}");
    }

    fn assert_rejected(&self, report: &Value, exit: i64, code: &str, operation: &str) {
        assert_eq!(report["exit"], exit, "{report}");
        assert_eq!(report["ok"], false);
        assert_eq!(report["diagnostics"][0]["code"], code, "{report}");
        assert_eq!(report["diagnostics"][0]["operation"], operation, "{report}");
        assert!(report.get("effects").is_none(), "{report}");
        self.assert_unchanged();
    }
}

#[test]
fn check_reports_available_update_with_reads_only() {
    let fixture = Fixture::new();
    fixture.publish(NEXT, Tamper::None);
    let report = fixture.run_installed(&["update", "--check"]);
    assert_eq!(report["exit"], 0, "{report}");
    assert_eq!(report["status"], "update_available");
    let evidence = &report["evidence"];
    assert_eq!(evidence["current_version"], CURRENT);
    assert_eq!(evidence["target_version"], NEXT);
    assert_eq!(evidence["target_source"], "latest");
    assert_eq!(evidence["update_available"], true);
    assert_eq!(
        evidence["asset"],
        format!("specgit-{NEXT}-{}.zip", fixture.platform)
    );
    assert_eq!(fixture.roles(), ["gh"], "only release metadata is read");
    assert_eq!(
        fixture.calls()[0]["args"]
            .as_array()
            .unwrap()
            .last()
            .unwrap(),
        "repos/LeXwDeX/SpecGit/releases/latest"
    );
    fixture.assert_unchanged();
}

#[test]
fn explicit_json_request_selects_a_version_and_older_releases_are_downgrades() {
    let fixture = Fixture::new();
    fixture.publish("1.0.0", Tamper::None);
    let request = fixture.root.join("request.json");
    fs::write(
        &request,
        json!({"command":"update","options":{"check":true,"version":"1.0.0"}}).to_string(),
    )
    .unwrap();
    let report = fixture.run_installed(&["--input-file", request.to_str().unwrap()]);
    assert_eq!(report["status"], "downgrade_available", "{report}");
    assert_eq!(report["evidence"]["direction"], "downgrade");
    assert_eq!(report["evidence"]["target_source"], "requested");
    let latest = fixture.run_installed(&["update", "--check"]);
    assert_eq!(latest["status"], "current_newer", "{latest}");
    assert_eq!(latest["evidence"]["update_available"], false);
    let missing = fixture.run_installed(&["update", "--check", "--version", "7.7.7"]);
    assert_eq!(missing["exit"], 3, "{missing}");
    assert_eq!(missing["diagnostics"][0]["code"], "ambiguous_not_found");
    let invalid = fixture.run_installed(&["update", "--version", "1.2"]);
    assert_eq!(invalid["exit"], 2, "{invalid}");
    assert!(
        fixture
            .calls()
            .iter()
            .all(|call| !call["args"].to_string().contains("assets/"))
    );
    fixture.assert_unchanged();
}

#[test]
fn same_version_apply_is_a_no_op() {
    let fixture = Fixture::new();
    fixture.publish(CURRENT, Tamper::None);
    let report = fixture.run(&["update"]);
    assert_eq!(report["exit"], 0, "{report}");
    assert_eq!(report["status"], "up_to_date");
    assert_eq!(report["evidence"]["update_available"], false);
    assert!(report.get("effects").is_none());
    assert_eq!(fixture.roles(), ["gh"]);
    fixture.assert_unchanged();
}

#[test]
fn dry_run_verifies_everything_without_replacing() {
    let fixture = Fixture::new();
    fixture.publish(NEXT, Tamper::None);
    let report = fixture.run(&["update", "--dry-run"]);
    assert_eq!(report["exit"], 0, "{report}");
    assert_eq!(report["status"], "verified");
    let verification = &report["evidence"]["verification"];
    assert_eq!(verification["signature"], "verified");
    assert_eq!(verification["manifest_row"], "matched");
    assert_eq!(verification["extracted_version"], NEXT);
    assert_eq!(
        verification["executable_sha256"],
        hex(&fs::read(FIXTURE).unwrap())
    );
    assert_eq!(
        fixture.roles(),
        ["gh", "gh", "gh", "gh", "cosign", "specgit"]
    );
    fixture.assert_unchanged();
}

#[test]
fn apply_replaces_the_target_and_keeps_a_restorable_backup() {
    let fixture = Fixture::new();
    fixture.publish(NEXT, Tamper::None);
    let report = fixture.run(&["update"]);
    assert_eq!(report["exit"], 0, "{report}");
    assert_eq!(report["status"], "updated");
    let installation = &report["evidence"]["installation"];
    assert_eq!(installation["previous_version"], CURRENT);
    assert_eq!(installation["installed_version"], NEXT);
    let backup = PathBuf::from(installation["backup"].as_str().unwrap());
    assert_eq!(backup.parent(), fixture.target.parent());
    assert_eq!(fs::read(&backup).unwrap(), OLD_BINARY);
    assert_eq!(
        fs::read(&fixture.target).unwrap(),
        fs::read(FIXTURE).unwrap()
    );
    assert_eq!(report["effects"]["outcome"], "applied");
    assert_eq!(
        report["effects"]["operations"][0]["action"],
        "replace_executable"
    );
    assert!(
        report["next_actions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|action| action["kind"] == "rollback_available")
    );
    let installed = fixture
        .command(&fixture.target)
        .args(["--human", "--version"])
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8(installed.stdout).unwrap().trim(),
        format!("specgit {NEXT}")
    );
    assert_eq!(
        fs::read_dir(fixture.target.parent().unwrap())
            .unwrap()
            .count(),
        2,
        "target and backup only"
    );
}

#[test]
fn tampered_manifest_signature_fails_closed() {
    let fixture = Fixture::new();
    fixture.publish(NEXT, Tamper::ManifestAfterSigning);
    let report = fixture.run(&["update"]);
    fixture.assert_rejected(&report, 1, "evidence_rejected", "cosign_verify");
    assert!(!fixture.roles().contains(&"specgit".to_owned()));
}

#[test]
fn missing_cosign_fails_closed() {
    let fixture = Fixture::new();
    fixture.publish(NEXT, Tamper::None);
    fs::remove_file(fixture.bin.join(executable_file("cosign"))).unwrap();
    let report = fixture.run(&["update", "--dry-run"]);
    fixture.assert_rejected(&report, 3, "missing_executable", "cosign_verify");
    assert!(
        report["diagnostics"][0]["remedy"]
            .as_str()
            .unwrap()
            .contains("Cosign")
    );
}

#[test]
fn archive_hash_mismatch_fails_closed() {
    let fixture = Fixture::new();
    fixture.publish(NEXT, Tamper::WrongHash);
    let report = fixture.run(&["update"]);
    fixture.assert_rejected(&report, 1, "evidence_rejected", "update_archive");
}

#[test]
fn malformed_signed_manifest_fails_closed() {
    let fixture = Fixture::new();
    fixture.publish(NEXT, Tamper::MalformedManifest);
    let report = fixture.run(&["update"]);
    fixture.assert_rejected(&report, 1, "evidence_rejected", "update_manifest");
}

#[test]
fn missing_platform_asset_fails_closed_before_download() {
    let fixture = Fixture::new();
    fixture.publish(NEXT, Tamper::MissingArchive);
    let report = fixture.run(&["update"]);
    fixture.assert_rejected(&report, 1, "evidence_rejected", "update_release");
    assert_eq!(fixture.roles(), ["gh"]);
}

#[test]
fn wrong_extracted_version_fails_closed() {
    let fixture = Fixture::new();
    fixture.publish(NEXT, Tamper::None);
    let mut state = fixture.state();
    state["binary_version"] = json!("8.8.8");
    fixture.write_state(&state);
    let report = fixture.run(&["update"]);
    fixture.assert_rejected(&report, 1, "evidence_rejected", "update_smoke");
}

#[test]
fn oversized_download_fails_closed() {
    let fixture = Fixture::new();
    fixture.publish(NEXT, Tamper::Oversize);
    let report = fixture.run(&["update"]);
    fixture.assert_rejected(&report, 1, "evidence_rejected", "github_release_download");
    assert!(!fixture.roles().contains(&"cosign".to_owned()));
}

#[cfg(unix)]
#[test]
fn unwritable_install_directory_fails_before_download() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    fixture.publish(NEXT, Tamper::None);
    let directory = fixture.target.parent().unwrap().to_owned();
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o555)).unwrap();
    let writable = fs::write(directory.join("probe"), b"").is_ok();
    if !writable {
        let report = fixture.run(&["update"]);
        assert_eq!(report["exit"], 3, "{report}");
        assert_eq!(report["diagnostics"][0]["code"], "permission_denied");
        assert_eq!(fixture.roles(), ["gh"]);
    }
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
    if writable {
        // Privileged users bypass directory permissions; nothing to prove.
        fs::remove_file(directory.join("probe")).unwrap();
    }
    fixture.assert_unchanged();
}
