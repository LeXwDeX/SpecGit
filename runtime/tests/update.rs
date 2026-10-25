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

struct Running(Option<std::process::Child>);
impl Running {
    #[cfg(unix)]
    fn id(&self) -> u32 {
        self.0.as_ref().unwrap().id()
    }
    fn finish(mut self) -> std::process::Output {
        self.0.take().unwrap().wait_with_output().unwrap()
    }
    #[cfg(unix)]
    fn finish_within(mut self, duration: std::time::Duration) -> Option<std::process::Output> {
        let child = self.0.as_mut()?;
        let deadline = std::time::Instant::now() + duration;
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        Some(self.finish())
    }
    fn kill(mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn wait_for(path: &Path) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while !path.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting for {}",
            path.display()
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

struct Fixture {
    _temp: tempfile::TempDir,
    base: PathBuf,
    root: PathBuf,
    bin: PathBuf,
    target: PathBuf,
    home: PathBuf,
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
        for name in ["gh", "cosign", "specgit"] {
            fs::copy(FIXTURE, bin.join(executable_file(name))).unwrap();
        }
        let install = base.join("install");
        fs::create_dir(&install).unwrap();
        let target = install.join(executable_file("specgit"));
        fs::write(&target, OLD_BINARY).unwrap();
        let home = base.join("home");
        fs::create_dir(&home).unwrap();
        let fixture = Self {
            _temp: temp,
            base: base.clone(),
            root,
            bin,
            target,
            home,
            platform: self_update::current_platform()
                .expect("update tests run on a published release platform"),
        };
        fixture
            .write_state(&json!({"latest":null,"releases":{},"binary_version":NEXT,"next_id":100}));
        fixture
    }

    // Linux debug fixtures embed debug info beyond the release size bound, so Unix
    // archives carry a small launcher for the `specgit` role copy instead. The
    // launcher pins its release version so concurrent releases stay distinct.
    fn release_executable(&self, version: &str) -> Vec<u8> {
        let fixture = self.bin.join(executable_file("specgit"));
        if cfg!(unix) {
            format!(
                "#!/bin/sh\n: \"${{SPECGIT_FIXTURE_BINARY_VERSION:={version}}}\"\nexport SPECGIT_FIXTURE_BINARY_VERSION\nexec '{}' \"$@\"\n",
                fixture.display()
            )
            .into_bytes()
        } else {
            fs::read(fixture).unwrap()
        }
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
            &self.release_executable(version),
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
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home);
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
        self.run_with_env(program, args, &[])
    }

    fn run_with_env(&self, program: &Path, args: &[&str], envs: &[(&str, &str)]) -> Value {
        let output = self
            .command(program)
            .args(args)
            .arg("--json")
            .envs(envs.iter().copied())
            .output()
            .unwrap();
        self.report(output)
    }

    fn report(&self, output: std::process::Output) -> Value {
        let report: Value = serde_json::from_slice(&output.stdout)
            .unwrap_or_else(|_| panic!("stdout={:?} stderr={:?}", output.stdout, output.stderr));
        assert_eq!(report["exit"].as_i64(), output.status.code().map(i64::from));
        let schema: Value =
            serde_json::from_str(include_str!("../schemas/report.schema.json")).unwrap();
        jsonschema::draft202012::validate(&schema, &report).unwrap_or_else(|error| {
            panic!("report violates report.schema.json: {error}\n{report}")
        });
        if report["evidence"]["installation"].is_null() {
            assert!(
                report["next_actions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|action| action["kind"] != "refresh_project_skills"),
                "no successful replacement means no skill refresh notice: {report}"
            );
        }
        report
    }

    fn spawn(&self, args: &[&str], envs: &[(&str, &str)]) -> Running {
        let child = self
            .command(Path::new(env!("CARGO_BIN_EXE_specgit")))
            .args(args)
            .arg("--json")
            .envs(envs.iter().copied())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        Running(Some(child))
    }

    fn finish(&self, running: Running) -> Value {
        self.report(running.finish())
    }

    fn gate(&self, name: &str) -> (PathBuf, PathBuf) {
        let directory = self.base.join("gates");
        fs::create_dir_all(&directory).unwrap();
        (
            directory.join(format!("{name}.parked")),
            directory.join(format!("{name}.release")),
        )
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
        hex(&fixture.release_executable(NEXT))
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
    assert!(backup.starts_with(fixture.target.parent().unwrap()));
    assert_eq!(fs::read(&backup).unwrap(), OLD_BINARY);
    assert!(
        fixture
            .target
            .parent()
            .unwrap()
            .join(".specgit-update.lock")
            .is_file(),
        "the persistent update lock remains beside the executable"
    );
    assert_eq!(
        fs::read(&fixture.target).unwrap(),
        fixture.release_executable(NEXT)
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
        3,
        "target, backup and persistent lock only"
    );
}

#[test]
fn update_refreshes_only_an_already_managed_user_skill_using_the_new_entrypoint() {
    let fixture = Fixture::new();
    fixture.publish(NEXT, Tamper::None);
    let skill = fixture.home.join(".agents/skills/specgit-native/SKILL.md");
    fs::create_dir_all(skill.parent().unwrap()).unwrap();
    let old = b"old skill\n";
    fs::write(
        &skill,
        format!("old skill\n<!-- specgit:managed sha256={} -->\n", hex(old)),
    )
    .unwrap();
    let report = fixture.run(&["update"]);
    assert_eq!(report["exit"], 0, "{report}");
    assert_eq!(
        report["evidence"]["user_skill"]["status"], "refreshed",
        "{report}"
    );
    assert!(
        fs::read_to_string(&skill)
            .unwrap()
            .contains("name: specgit-native")
    );
    assert!(
        fixture
            .calls()
            .iter()
            .any(|call| call["args"] == json!(["skill", "--user", "--refresh-only", "--json"]))
    );
    assert!(
        report["effects"]["operations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|op| op["action"] == "refresh_user_skill" && op["outcome"] == "applied")
    );
}

#[test]
fn update_skips_uninstalled_and_foreign_user_skill_without_spawning_refresh() {
    for foreign in [false, true] {
        let fixture = Fixture::new();
        fixture.publish(NEXT, Tamper::None);
        let skill = fixture.home.join(".agents/skills/specgit-native/SKILL.md");
        if foreign {
            fs::create_dir_all(skill.parent().unwrap()).unwrap();
            fs::write(&skill, b"foreign\n").unwrap();
        }
        let report = fixture.run(&["update"]);
        assert_eq!(report["exit"], 0, "{report}");
        assert_eq!(
            report["evidence"]["user_skill"]["status"], "skipped",
            "{report}"
        );
        assert!(
            !fixture
                .calls()
                .iter()
                .any(|call| call["args"][0] == "skill")
        );
        if foreign {
            assert_eq!(fs::read(&skill).unwrap(), b"foreign\n");
        } else {
            assert!(!fixture.home.join(".agents").exists());
        }
    }
}

#[test]
fn refresh_failure_never_rolls_back_a_successful_binary_install() {
    for failure in ["malformed", "exit", "timeout"] {
        let fixture = Fixture::new();
        fixture.publish(NEXT, Tamper::None);
        let skill = fixture.home.join(".agents/skills/specgit-native/SKILL.md");
        fs::create_dir_all(skill.parent().unwrap()).unwrap();
        let bytes = format!(
            "old skill\n<!-- specgit:managed sha256={} -->\n",
            hex(b"old skill\n")
        );
        fs::write(&skill, &bytes).unwrap();
        let mut state = fixture.state();
        state["skill_failure"] = json!(failure);
        fixture.write_state(&state);
        let report = fixture.run(&["update"]);
        assert_eq!(report["exit"], 0, "{report}");
        assert_eq!(report["status"], "updated");
        assert_eq!(report["evidence"]["user_skill"]["status"], "failed");
        assert_eq!(
            report["diagnostics"][0]["operation"],
            "update_skill_refresh"
        );
        assert!(
            report["diagnostics"][0]["remedy"]
                .as_str()
                .unwrap()
                .contains("specgit skill --user")
        );
        assert_eq!(
            fs::read(&fixture.target).unwrap(),
            fixture.release_executable(NEXT)
        );
        assert_eq!(fs::read_to_string(&skill).unwrap(), bytes);
        assert_eq!(report["effects"]["operations"][0]["outcome"], "applied");
        assert!(
            report["effects"]["operations"]
                .as_array()
                .unwrap()
                .iter()
                .all(|op| op["action"] != "restore_executable")
        );
    }
}

#[test]
fn update_preview_and_noop_never_refresh_even_when_user_skill_is_managed() {
    for args in [
        &["update", "--check"][..],
        &["update", "--dry-run"],
        &["update", "--version", CURRENT],
    ] {
        let fixture = Fixture::new();
        fixture.publish(NEXT, Tamper::None);
        fixture.publish(CURRENT, Tamper::None);
        let mut state = fixture.state();
        state["latest"] = json!(format!("v{NEXT}"));
        fixture.write_state(&state);
        let skill = fixture.home.join(".agents/skills/specgit-native/SKILL.md");
        fs::create_dir_all(skill.parent().unwrap()).unwrap();
        let bytes = format!(
            "old skill\n<!-- specgit:managed sha256={} -->\n",
            hex(b"old skill\n")
        );
        fs::write(&skill, &bytes).unwrap();
        let report = fixture.run(args);
        assert_eq!(report["exit"], 0, "{report}");
        assert!(report["evidence"]["user_skill"].is_null());
        assert!(
            !fixture
                .calls()
                .iter()
                .any(|call| call["args"][0] == "skill")
        );
        assert_eq!(fs::read_to_string(&skill).unwrap(), bytes);
    }
}

#[test]
fn successful_replacement_reminds_each_project_in_json_and_human_output() {
    for version in [NEXT, "1.0.0"] {
        for machine in [true, false] {
            let fixture = Fixture::new();
            fixture.publish(version, Tamper::None);
            let mut state = fixture.state();
            state["binary_version"] = json!(version);
            fixture.write_state(&state);
            let project = fixture._temp.path().join("project");
            fs::create_dir_all(project.join(".agents/skills/specgit-native")).unwrap();
            let files = [
                ("AGENTS.md", "User project guidance\n"),
                (
                    ".specgit.yaml",
                    "version: 2\nprovider: github\nremote: origin\ntarget: main\n",
                ),
                (
                    ".agents/skills/specgit-native/SKILL.md",
                    "Manually edited Skill\n",
                ),
            ];
            for (path, content) in files {
                fs::write(project.join(path), content).unwrap();
            }
            let output = fixture
                .command(Path::new(env!("CARGO_BIN_EXE_specgit")))
                .current_dir(&project)
                .args([
                    "update",
                    "--version",
                    version,
                    if machine { "--json" } else { "--human" },
                ])
                .output()
                .unwrap();
            assert!(output.status.success(), "{output:?}");
            let stdout = String::from_utf8(output.stdout).unwrap();
            let notice = if machine {
                let report: Value = serde_json::from_str(&stdout).unwrap();
                let schema: Value =
                    serde_json::from_str(include_str!("../schemas/report.schema.json")).unwrap();
                jsonschema::draft202012::validate(&schema, &report).unwrap();
                assert_eq!(
                    report["status"],
                    if version == NEXT {
                        "updated"
                    } else {
                        "downgraded"
                    }
                );
                let actions = report["next_actions"].as_array().unwrap();
                let action = actions
                    .iter()
                    .find(|action| action["kind"] == "refresh_project_skills")
                    .expect("successful replacement must suggest refreshing project Skills");
                assert_eq!(action["command"], "specgit setup");
                assert_eq!(report["effects"]["operations"].as_array().unwrap().len(), 1);
                action["remedy"].as_str().unwrap().to_owned()
            } else {
                stdout
            };
            assert!(notice.contains("specgit setup"), "{notice}");
            assert!(notice.contains("may need"), "not confirmed stale: {notice}");
            for (path, content) in files {
                assert_eq!(fs::read_to_string(project.join(path)).unwrap(), content);
            }
            assert_eq!(fs::read_dir(&project).unwrap().count(), 3);
            assert_eq!(fs::read_dir(project.join(".agents")).unwrap().count(), 1);
            assert_eq!(
                fs::read_dir(project.join(".agents/skills"))
                    .unwrap()
                    .count(),
                1
            );
            assert_eq!(
                fs::read_dir(project.join(".agents/skills/specgit-native"))
                    .unwrap()
                    .count(),
                1
            );
            assert_eq!(
                fixture.roles(),
                ["gh", "gh", "gh", "gh", "cosign", "specgit", "specgit"],
                "only release reads, signature verification, smoke and readback"
            );
        }
    }
}

#[test]
fn human_output_does_not_suggest_skill_refresh_without_replacement() {
    for (args, version, tamper) in [
        (&["update", "--check"][..], NEXT, Tamper::None),
        (&["update", "--dry-run"][..], NEXT, Tamper::None),
        (&["update"][..], CURRENT, Tamper::None),
        (&["update"][..], "1.0.0", Tamper::None),
        (&["update"][..], NEXT, Tamper::ManifestAfterSigning),
    ] {
        let fixture = Fixture::new();
        fixture.publish(version, tamper);
        let output = fixture
            .command(Path::new(env!("CARGO_BIN_EXE_specgit")))
            .args(args)
            .arg("--human")
            .output()
            .unwrap();
        assert_eq!(
            output.status.success(),
            tamper == Tamper::None,
            "{output:?}"
        );
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert!(!stdout.contains("specgit setup"), "{stdout}");
        assert!(!stdout.contains("The CLI was replaced"), "{stdout}");
        fixture.assert_unchanged();
    }
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
    #[cfg(unix)]
    let report = fixture.run_with_env(
        Path::new(env!("CARGO_BIN_EXE_specgit")),
        &["update"],
        &[("SPECGIT_FIXTURE_BINARY_VERSION", "8.8.8")],
    );
    #[cfg(windows)]
    let report = {
        let mut state = fixture.state();
        state["binary_version"] = json!("8.8.8");
        fixture.write_state(&state);
        fixture.run(&["update"])
    };
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

fn backup_name(target: &Path, previous: &str, suffix: usize) -> PathBuf {
    let name = target.file_name().unwrap().to_string_lossy();
    let (stem, extension) = name
        .rsplit_once('.')
        .filter(|(stem, extension)| extension.eq_ignore_ascii_case("exe") && !stem.is_empty())
        .map(|(stem, extension)| (stem.to_owned(), format!(".{extension}")))
        .unwrap_or_else(|| (name.into_owned(), String::new()));
    let suffix = if suffix == 0 {
        String::new()
    } else {
        format!("-{suffix}")
    };
    target
        .parent()
        .unwrap()
        .join(format!("{stem}.backup-{previous}{suffix}{extension}"))
}

#[test]
fn backup_create_race_preserves_the_winner() {
    let fixture = Fixture::new();
    fixture.publish(NEXT, Tamper::None);
    let (parked, release) = fixture.gate("backup-race");
    let winner = backup_name(&fixture.target, CURRENT, 0);
    let running = fixture.spawn(
        &["update"],
        &[
            ("SPECGIT_TEST_UPDATE_STRATEGY", "atomic_replace"),
            ("SPECGIT_TEST_UPDATE_PAUSE", "backup-selected"),
            ("SPECGIT_TEST_UPDATE_PAUSE_PARKED", parked.to_str().unwrap()),
            (
                "SPECGIT_TEST_UPDATE_PAUSE_RELEASE",
                release.to_str().unwrap(),
            ),
        ],
    );
    wait_for(&parked);
    fs::write(&winner, b"winner").unwrap();
    fs::write(&release, b"").unwrap();
    let report = fixture.finish(running);
    assert_eq!(report["exit"], 3, "{report}");
    assert_eq!(report["diagnostics"][0]["code"], "concurrent_edit");
    assert_eq!(report["diagnostics"][0]["operation"], "update_install");
    assert_eq!(fs::read(&winner).unwrap(), b"winner");
    assert_eq!(fs::read(&fixture.target).unwrap(), OLD_BINARY);
    assert!(report["evidence"]["installation"].is_null());
    assert_eq!(report["effects"]["outcome"], "not_applied", "{report}");
    assert!(
        report["effects"]["operations"]
            .as_array()
            .unwrap()
            .is_empty(),
        "{report}"
    );
    assert!(
        fixture
            .target
            .parent()
            .unwrap()
            .join(".specgit-update.lock")
            .is_file()
    );
    assert!(
        fs::read_dir(fixture.target.parent().unwrap())
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".specgit-update-"))
    );
}

#[test]
fn rename_aside_publish_failure_never_overwrites_a_recreated_target() {
    let fixture = Fixture::new();
    fixture.publish(NEXT, Tamper::None);
    let (parked, release) = fixture.gate("target-aside");
    let running = fixture.spawn(
        &["update"],
        &[
            ("SPECGIT_TEST_UPDATE_STRATEGY", "rename_aside"),
            ("SPECGIT_TEST_UPDATE_PAUSE", "target-aside"),
            ("SPECGIT_TEST_UPDATE_PAUSE_PARKED", parked.to_str().unwrap()),
            (
                "SPECGIT_TEST_UPDATE_PAUSE_RELEASE",
                release.to_str().unwrap(),
            ),
        ],
    );
    wait_for(&parked);
    fs::write(&fixture.target, b"INTRUDER").unwrap();
    fs::write(&release, b"").unwrap();
    let report = fixture.finish(running);
    assert_eq!(report["exit"], 3, "{report}");
    assert_eq!(report["diagnostics"][0]["code"], "rollback_conflict");
    assert_eq!(report["diagnostics"][0]["operation"], "update_install");
    assert!(
        report["diagnostics"][0]["message"]
            .as_str()
            .unwrap()
            .contains("No automatic restore"),
        "{report}"
    );
    assert_eq!(fs::read(&fixture.target).unwrap(), b"INTRUDER");
    assert_eq!(
        report["effects"]["operations"][0]["recovery"]["backup_complete"],
        true
    );
    let backup = PathBuf::from(
        report["effects"]["operations"][0]["recovery"]["backup"]
            .as_str()
            .unwrap(),
    );
    assert_eq!(fs::read(&backup).unwrap(), OLD_BINARY);
    assert!(
        backup
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(".specgit-backup-")
    );
    assert!(report["evidence"]["installation"].is_null());
    assert!(
        report["effects"]["operations"]
            .as_array()
            .unwrap()
            .iter()
            .all(|operation| operation["action"] != "restore_executable")
    );
}

#[test]
fn failed_readback_preserves_target_and_backup_for_manual_recovery() {
    for strategy in ["atomic_replace", "rename_aside"] {
        let fixture = Fixture::new();
        fixture.publish(NEXT, Tamper::None);
        let report = fixture.run_with_env(
            Path::new(env!("CARGO_BIN_EXE_specgit")),
            &["update"],
            &[
                ("SPECGIT_TEST_UPDATE_STRATEGY", strategy),
                ("SPECGIT_TEST_UPDATE_READBACK_VERSION", "8.8.8"),
            ],
        );
        assert_eq!(report["exit"], 3, "{strategy}: {report}");
        assert_eq!(report["diagnostics"][0]["code"], "rollback_conflict");
        assert_eq!(report["diagnostics"][0]["operation"], "update_readback");
        assert_eq!(
            fs::read(&fixture.target).unwrap(),
            fixture.release_executable(NEXT)
        );
        assert!(report["evidence"]["installation"].is_null());
        assert_eq!(report["effects"]["outcome"], "applied");
        let operations = report["effects"]["operations"].as_array().unwrap();
        assert_eq!(operations.len(), 1, "{strategy}: {report}");
        assert_eq!(operations[0]["action"], "replace_executable");
        assert_eq!(operations[0]["outcome"], "applied");
        let backup = PathBuf::from(operations[0]["recovery"]["backup"].as_str().unwrap());
        assert_eq!(fs::read(&backup).unwrap(), OLD_BINARY);
        let expected = hex(&fixture.release_executable(NEXT));
        let previous = hex(OLD_BINARY);
        assert_eq!(operations[0]["recovery"]["expected_sha256"], expected);
        assert_eq!(operations[0]["recovery"]["previous_sha256"], previous);
        assert_eq!(operations[0]["recovery"]["backup_complete"], true);
        assert_eq!(operations[0]["recovery"]["target_sha256"], expected);
        assert_eq!(operations[0]["recovery"]["backup_sha256"], previous);
        let remedy = report["diagnostics"][0]["remedy"].as_str().unwrap();
        assert!(remedy.contains(&fixture.target.display().to_string()));
        assert!(remedy.contains(&backup.display().to_string()));
        assert!(remedy.contains(&expected));
        assert!(remedy.contains(&previous));
        assert!(
            fixture
                .target
                .parent()
                .unwrap()
                .join(".specgit-update.lock")
                .is_file()
        );
    }
}

#[test]
fn cancelled_readback_preserves_target_and_backup() {
    for strategy in ["atomic_replace", "rename_aside"] {
        let fixture = Fixture::new();
        fixture.publish(NEXT, Tamper::None);
        let report = fixture.run_with_env(
            Path::new(env!("CARGO_BIN_EXE_specgit")),
            &["update"],
            &[
                ("SPECGIT_TEST_UPDATE_STRATEGY", strategy),
                ("SPECGIT_TEST_UPDATE_READBACK_CANCELLED", "1"),
            ],
        );
        assert_eq!(report["exit"], 130, "{strategy}: {report}");
        assert_eq!(report["diagnostics"][0]["code"], "cancelled");
        assert_eq!(report["diagnostics"][0]["operation"], "update_readback");
        assert_eq!(
            fs::read(&fixture.target).unwrap(),
            fixture.release_executable(NEXT)
        );
        assert!(report["evidence"]["installation"].is_null());
        let operations = report["effects"]["operations"].as_array().unwrap();
        assert_eq!(operations.len(), 1, "{strategy}: {report}");
        assert_eq!(operations[0]["action"], "replace_executable");
        assert_eq!(operations[0]["outcome"], "applied");
        let backup = PathBuf::from(operations[0]["recovery"]["backup"].as_str().unwrap());
        assert_eq!(fs::read(&backup).unwrap(), OLD_BINARY);
        assert_eq!(
            operations[0]["recovery"]["target_sha256"],
            hex(&fixture.release_executable(NEXT))
        );
        assert_eq!(operations[0]["recovery"]["backup_sha256"], hex(OLD_BINARY));
        let remedy = report["diagnostics"][0]["remedy"].as_str().unwrap();
        assert!(remedy.contains(&fixture.target.display().to_string()));
        assert!(remedy.contains(&backup.display().to_string()));
    }
}

#[test]
fn failed_readback_preserves_a_newer_target_and_the_backup() {
    for strategy in ["atomic_replace", "rename_aside"] {
        let fixture = Fixture::new();
        fixture.publish(NEXT, Tamper::None);
        let (parked, release) = fixture.gate(strategy);
        let running = fixture.spawn(
            &["update"],
            &[
                ("SPECGIT_TEST_UPDATE_STRATEGY", strategy),
                ("SPECGIT_TEST_UPDATE_READBACK_VERSION", "8.8.8"),
                ("SPECGIT_TEST_UPDATE_PAUSE", "readback-failed"),
                ("SPECGIT_TEST_UPDATE_PAUSE_PARKED", parked.to_str().unwrap()),
                (
                    "SPECGIT_TEST_UPDATE_PAUSE_RELEASE",
                    release.to_str().unwrap(),
                ),
            ],
        );
        wait_for(&parked);
        fs::write(&fixture.target, b"NEWER").unwrap();
        fs::write(&release, b"").unwrap();
        let report = fixture.finish(running);
        assert_eq!(report["exit"], 3, "{strategy}: {report}");
        assert_eq!(report["diagnostics"][0]["code"], "rollback_conflict");
        assert_eq!(report["diagnostics"][0]["operation"], "update_readback");
        assert_eq!(fs::read(&fixture.target).unwrap(), b"NEWER");
        assert_eq!(
            report["effects"]["operations"][0]["recovery"]["target_sha256"],
            hex(b"NEWER")
        );
        let backup = PathBuf::from(
            report["effects"]["operations"][0]["recovery"]["backup"]
                .as_str()
                .unwrap(),
        );
        assert_eq!(fs::read(&backup).unwrap(), OLD_BINARY);
        assert!(report["evidence"]["installation"].is_null());
        assert!(
            report["effects"]["operations"]
                .as_array()
                .unwrap()
                .iter()
                .all(|operation| operation["action"] != "restore_executable")
        );
    }
}

#[test]
fn failed_readback_never_restores_a_replaced_backup() {
    for strategy in ["atomic_replace", "rename_aside"] {
        let fixture = Fixture::new();
        fixture.publish(NEXT, Tamper::None);
        let (parked, release) = fixture.gate(&format!("backup-{strategy}"));
        let running = fixture.spawn(
            &["update"],
            &[
                ("SPECGIT_TEST_UPDATE_STRATEGY", strategy),
                ("SPECGIT_TEST_UPDATE_READBACK_VERSION", "8.8.8"),
                ("SPECGIT_TEST_UPDATE_PAUSE", "readback-failed"),
                ("SPECGIT_TEST_UPDATE_PAUSE_PARKED", parked.to_str().unwrap()),
                (
                    "SPECGIT_TEST_UPDATE_PAUSE_RELEASE",
                    release.to_str().unwrap(),
                ),
            ],
        );
        wait_for(&parked);
        let backup = if strategy == "atomic_replace" {
            backup_name(&fixture.target, CURRENT, 0)
        } else {
            let transaction = fs::read_dir(fixture.target.parent().unwrap())
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .find(|path| {
                    path.is_dir()
                        && path
                            .file_name()
                            .unwrap()
                            .to_string_lossy()
                            .starts_with(".specgit-backup-")
                })
                .expect("rename-aside transaction directory");
            transaction.join(
                backup_name(&fixture.target, CURRENT, 0)
                    .file_name()
                    .unwrap(),
            )
        };
        assert_eq!(fs::read(&backup).unwrap(), OLD_BINARY);
        fs::write(&backup, b"REPLACED_BACKUP").unwrap();
        fs::write(&release, b"").unwrap();
        let report = fixture.finish(running);
        assert_eq!(report["exit"], 3, "{strategy}: {report}");
        assert_eq!(report["diagnostics"][0]["code"], "rollback_conflict");
        assert!(
            report["diagnostics"][0]["message"]
                .as_str()
                .unwrap()
                .contains("No automatic restore was attempted"),
            "{strategy}: {report}"
        );
        assert_eq!(
            fs::read(&fixture.target).unwrap(),
            fixture.release_executable(NEXT)
        );
        assert_eq!(fs::read(&backup).unwrap(), b"REPLACED_BACKUP");
        assert_eq!(
            report["effects"]["operations"][0]["recovery"]["target_sha256"],
            hex(&fixture.release_executable(NEXT))
        );
        assert_eq!(
            report["effects"]["operations"][0]["recovery"]["backup_sha256"],
            hex(b"REPLACED_BACKUP")
        );
        assert!(report["evidence"]["installation"].is_null());
        assert!(
            report["effects"]["operations"]
                .as_array()
                .unwrap()
                .iter()
                .all(|operation| operation["action"] != "restore_executable")
        );
    }
}

#[test]
fn concurrent_same_version_update_fails_closed_without_replacing_the_winner() {
    for strategy in ["atomic_replace", "rename_aside"] {
        let fixture = Fixture::new();
        fixture.publish(NEXT, Tamper::None);
        let (a_parked, a_release) = fixture.gate(&format!("winner-{strategy}"));
        let (b_parked, b_release) = fixture.gate(&format!("loser-{strategy}"));
        let a = fixture.spawn(
            &["update"],
            &[
                ("SPECGIT_TEST_UPDATE_STRATEGY", strategy),
                ("SPECGIT_TEST_UPDATE_PAUSE", "backup-selected"),
                (
                    "SPECGIT_TEST_UPDATE_PAUSE_PARKED",
                    a_parked.to_str().unwrap(),
                ),
                (
                    "SPECGIT_TEST_UPDATE_PAUSE_RELEASE",
                    a_release.to_str().unwrap(),
                ),
            ],
        );
        wait_for(&a_parked);
        let b = fixture.spawn(
            &["update"],
            &[
                ("SPECGIT_TEST_UPDATE_STRATEGY", strategy),
                ("SPECGIT_TEST_UPDATE_PAUSE", "before-lock"),
                (
                    "SPECGIT_TEST_UPDATE_PAUSE_PARKED",
                    b_parked.to_str().unwrap(),
                ),
                (
                    "SPECGIT_TEST_UPDATE_PAUSE_RELEASE",
                    b_release.to_str().unwrap(),
                ),
            ],
        );
        wait_for(&b_parked);
        fs::write(&a_release, b"").unwrap();
        let a_report = fixture.finish(a);
        assert_eq!(a_report["exit"], 0, "{strategy}: {a_report}");
        assert_eq!(a_report["status"], "updated");
        fs::write(&b_release, b"").unwrap();
        let b_report = fixture.finish(b);
        assert_eq!(b_report["exit"], 3, "{strategy}: {b_report}");
        assert_eq!(b_report["diagnostics"][0]["code"], "concurrent_edit");
        assert_eq!(b_report["diagnostics"][0]["operation"], "update_install");
        assert!(b_report.get("effects").is_none(), "{strategy}: {b_report}");
        assert_eq!(
            fs::read(&fixture.target).unwrap(),
            fixture.release_executable(NEXT)
        );
        let backup = PathBuf::from(
            a_report["evidence"]["installation"]["backup"]
                .as_str()
                .unwrap(),
        );
        assert_eq!(fs::read(&backup).unwrap(), OLD_BINARY);
    }
}

#[cfg(unix)]
#[test]
fn concurrent_different_versions_fail_closed_and_rerun_installs_latest_choice() {
    for strategy in ["atomic_replace", "rename_aside"] {
        let fixture = Fixture::new();
        fixture.publish("9.0.0", Tamper::None);
        fixture.publish("10.0.0", Tamper::None);
        let (a_parked, a_release) = fixture.gate(&format!("version-9-{strategy}"));
        let (b_parked, b_release) = fixture.gate(&format!("version-10-{strategy}"));
        let a = fixture.spawn(
            &["update", "--version", "9.0.0"],
            &[
                ("SPECGIT_TEST_UPDATE_STRATEGY", strategy),
                ("SPECGIT_TEST_UPDATE_PAUSE", "backup-selected"),
                (
                    "SPECGIT_TEST_UPDATE_PAUSE_PARKED",
                    a_parked.to_str().unwrap(),
                ),
                (
                    "SPECGIT_TEST_UPDATE_PAUSE_RELEASE",
                    a_release.to_str().unwrap(),
                ),
            ],
        );
        wait_for(&a_parked);
        let b = fixture.spawn(
            &["update", "--version", "10.0.0"],
            &[
                ("SPECGIT_TEST_UPDATE_STRATEGY", strategy),
                ("SPECGIT_TEST_UPDATE_PAUSE", "before-lock"),
                (
                    "SPECGIT_TEST_UPDATE_PAUSE_PARKED",
                    b_parked.to_str().unwrap(),
                ),
                (
                    "SPECGIT_TEST_UPDATE_PAUSE_RELEASE",
                    b_release.to_str().unwrap(),
                ),
            ],
        );
        wait_for(&b_parked);
        fs::write(&a_release, b"").unwrap();
        let a_report = fixture.finish(a);
        assert_eq!(a_report["exit"], 0, "{strategy}: {a_report}");
        assert_eq!(
            fs::read(&fixture.target).unwrap(),
            fixture.release_executable("9.0.0")
        );
        fs::write(&b_release, b"").unwrap();
        let b_report = fixture.finish(b);
        assert_eq!(b_report["exit"], 3, "{strategy}: {b_report}");
        assert_eq!(b_report["diagnostics"][0]["code"], "concurrent_edit");
        assert_eq!(
            fs::read(&fixture.target).unwrap(),
            fixture.release_executable("9.0.0")
        );
        let rerun = fixture.run(&["update", "--version", "10.0.0"]);
        assert_eq!(rerun["exit"], 0, "{strategy}: {rerun}");
        assert_eq!(rerun["status"], "updated");
        assert_eq!(
            fs::read(&fixture.target).unwrap(),
            fixture.release_executable("10.0.0")
        );
        let backup = PathBuf::from(
            rerun["evidence"]["installation"]["backup"]
                .as_str()
                .unwrap(),
        );
        assert_eq!(
            fs::read(&backup).unwrap(),
            fixture.release_executable("9.0.0")
        );
    }
}

#[test]
fn lock_timeout_and_process_exit_release_the_installation_lock() {
    let fixture = Fixture::new();
    fixture.publish(NEXT, Tamper::None);
    let (parked, release) = fixture.gate("lock");
    let running = fixture.spawn(
        &["update"],
        &[
            ("SPECGIT_TEST_UPDATE_PAUSE", "readback"),
            ("SPECGIT_TEST_UPDATE_PAUSE_PARKED", parked.to_str().unwrap()),
            (
                "SPECGIT_TEST_UPDATE_PAUSE_RELEASE",
                release.to_str().unwrap(),
            ),
        ],
    );
    wait_for(&parked);
    assert_eq!(
        fs::read(&fixture.target).unwrap(),
        fixture.release_executable(NEXT)
    );
    let blocked = fixture.run_with_env(
        Path::new(env!("CARGO_BIN_EXE_specgit")),
        &["update"],
        &[("SPECGIT_TEST_UPDATE_LOCK_TIMEOUT_MS", "150")],
    );
    assert_eq!(blocked["exit"], 3, "{blocked}");
    assert_eq!(blocked["diagnostics"][0]["code"], "lock_busy");
    assert_eq!(blocked["diagnostics"][0]["operation"], "update_install");
    assert!(blocked.get("effects").is_none(), "{blocked}");
    running.kill();
    let report = fixture.run(&["update"]);
    assert_eq!(report["exit"], 0, "{report}");
    assert_eq!(report["status"], "updated");
    let backup = PathBuf::from(
        report["evidence"]["installation"]["backup"]
            .as_str()
            .unwrap(),
    );
    assert_eq!(fs::read(&backup).unwrap(), fixture.release_executable(NEXT));
}

#[cfg(unix)]
#[test]
fn real_interrupt_during_readback_preserves_update_effects() {
    for (name, signal) in [("int", libc::SIGINT), ("term", libc::SIGTERM)] {
        let fixture = Fixture::new();
        fixture.publish(NEXT, Tamper::None);
        let (parked, release) = fixture.gate(&format!("readback-signal-{name}"));
        let running = fixture.spawn(
            &["update"],
            &[
                ("SPECGIT_TEST_UPDATE_PAUSE", "readback"),
                ("SPECGIT_TEST_UPDATE_PAUSE_PARKED", parked.to_str().unwrap()),
                (
                    "SPECGIT_TEST_UPDATE_PAUSE_RELEASE",
                    release.to_str().unwrap(),
                ),
            ],
        );
        wait_for(&parked);
        // SAFETY: this is the exact child spawned and still owned by this test.
        assert_eq!(unsafe { libc::kill(running.id() as i32, signal) }, 0);
        let output = running
            .finish_within(std::time::Duration::from_secs(5))
            .unwrap_or_else(|| panic!("{name}: update did not respond to the signal"));
        let report = fixture.report(output);
        assert_eq!(report["exit"], 130, "{name}: {report}");
        assert!(
            report["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| diagnostic["code"] == "cancelled"),
            "{name}: {report}"
        );
        assert_eq!(report["evidence"]["installation"], Value::Null);
        let operations = report["effects"]["operations"].as_array().unwrap();
        assert_eq!(operations.len(), 1, "{name}: {report}");
        assert_eq!(operations[0]["action"], "replace_executable");
        assert_eq!(operations[0]["outcome"], "applied");
        assert_eq!(operations[0]["recovery"]["backup_complete"], true);
        let expected = fixture.release_executable(NEXT);
        assert_eq!(operations[0]["recovery"]["target_sha256"], hex(&expected));
        assert_eq!(fs::read(&fixture.target).unwrap(), expected);
        let backup = PathBuf::from(operations[0]["recovery"]["backup"].as_str().unwrap());
        assert_eq!(fs::read(&backup).unwrap(), OLD_BINARY);
        assert!(
            operations
                .iter()
                .all(|operation| operation["action"] != "restore_executable")
        );
    }
}

#[cfg(unix)]
#[test]
fn real_interrupt_while_waiting_for_lock_finishes_without_effects() {
    let fixture = Fixture::new();
    fixture.publish(NEXT, Tamper::None);
    let (parked, release) = fixture.gate("lock-signal-readback");
    let (lock_parked, lock_release) = fixture.gate("lock-signal-wait");
    let running = fixture.spawn(
        &["update"],
        &[
            ("SPECGIT_TEST_UPDATE_PAUSE", "readback"),
            ("SPECGIT_TEST_UPDATE_PAUSE_PARKED", parked.to_str().unwrap()),
            (
                "SPECGIT_TEST_UPDATE_PAUSE_RELEASE",
                release.to_str().unwrap(),
            ),
        ],
    );
    wait_for(&parked);
    let blocked = fixture.spawn(
        &["update"],
        &[
            ("SPECGIT_TEST_UPDATE_LOCK_TIMEOUT_MS", "60000"),
            ("SPECGIT_TEST_UPDATE_PAUSE", "lock-wait"),
            (
                "SPECGIT_TEST_UPDATE_PAUSE_PARKED",
                lock_parked.to_str().unwrap(),
            ),
            (
                "SPECGIT_TEST_UPDATE_PAUSE_RELEASE",
                lock_release.to_str().unwrap(),
            ),
        ],
    );
    wait_for(&lock_parked);
    // SAFETY: this is the exact child spawned and still owned by this test.
    assert_eq!(unsafe { libc::kill(blocked.id() as i32, libc::SIGINT) }, 0);
    let output = blocked
        .finish_within(std::time::Duration::from_secs(5))
        .unwrap_or_else(|| panic!("lock wait did not respond to the signal"));
    let report = fixture.report(output);
    assert_eq!(report["exit"], 130, "{report}");
    assert!(
        report["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "cancelled"),
        "{report}"
    );
    assert!(report.get("effects").is_none(), "{report}");
    assert_eq!(report["evidence"]["installation"], Value::Null);
    assert_eq!(
        fs::read(&fixture.target).unwrap(),
        fixture.release_executable(NEXT)
    );
    fs::write(&release, b"").unwrap();
    let first = fixture.finish(running);
    assert_eq!(first["exit"], 0, "{first}");
    let backup = PathBuf::from(
        first["evidence"]["installation"]["backup"]
            .as_str()
            .unwrap(),
    );
    assert_eq!(fs::read(&backup).unwrap(), OLD_BINARY);
}
