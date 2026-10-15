#![cfg(feature = "test-fixtures")]
#[path = "support/delivery.rs"]
#[allow(dead_code)]
mod delivery;
use delivery::executable;
use serde_json::{Value, json};
use std::{fs, path::PathBuf, process::Command};
struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    bin: PathBuf,
}
impl Fixture {
    fn new(version: &str, complete: bool) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let bin = root.join("bin");
        fs::create_dir(&bin).unwrap();
        for name in ["gh", "glab", "cosign"] {
            let name = if cfg!(windows) {
                format!("{name}.exe")
            } else {
                name.into()
            };
            fs::copy(
                env!("CARGO_BIN_EXE_specgit-process-fixture"),
                bin.join(name),
            )
            .unwrap();
        }
        let assets = if complete {
            [
                format!(
                    "specgit-{version}-{}.zip",
                    specgit::self_update::current_platform().unwrap()
                ),
                "SHA256SUMS".into(),
                "SHA256SUMS.sigstore.json".into(),
            ]
            .into_iter()
            .enumerate()
            .map(|(id, name)| json!({"id":id+1,"name":name,"size":10,"state":"uploaded"}))
            .collect::<Vec<_>>()
        } else {
            vec![]
        };
        let tag = format!("v{version}");
        fs::write(root.join("state.json"), json!({"latest":tag,"releases":{(tag.clone()):{"tag_name":tag,"draft":false,"prerelease":false,"assets":assets}}}).to_string()).unwrap();
        Self {
            _temp: temp,
            root,
            bin,
        }
    }
    fn command(&self) -> Command {
        let mut command = executable::command();
        let path = std::env::join_paths(std::iter::once(self.bin.clone()).chain(
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()),
        ))
        .unwrap();
        command
            .current_dir(&self.root)
            .env("PATH", path)
            .env("SPECGIT_FIXTURE_UPDATE_DIR", &self.root);
        command
    }
    fn run(&self, args: &[&str]) -> Value {
        let output = self.command().args(args).arg("--json").output().unwrap();
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["exit"].as_i64(), output.status.code().map(i64::from));
        let schema: Value =
            serde_json::from_str(include_str!("../schemas/report.schema.json")).unwrap();
        jsonschema::draft202012::validate(&schema, &report)
            .unwrap_or_else(|error| panic!("{error}: {report}"));
        report
    }
    fn calls(&self) -> String {
        fs::read_to_string(self.root.join("calls.log")).unwrap_or_default()
    }
}
#[test]
fn doctor_compares_latest_without_downloading_or_updating() {
    for (version, status) in [
        ("9.0.0", "update_available"),
        (env!("CARGO_PKG_VERSION"), "up_to_date"),
        ("1.0.0", "current_newer"),
    ] {
        let fixture = Fixture::new(version, true);
        let report = fixture.run(&[
            "doctor",
            "--account-only",
            "--provider",
            "gitlab",
            "--api-host",
            "gitlab.example.test",
        ]);
        assert_eq!(
            report["evidence"]["runtime_update"]["status"], status,
            "{report}"
        );
        assert_eq!(
            report["evidence"]["runtime_update"]["latest_version"],
            version
        );
        let calls = fixture.calls();
        assert!(
            calls.contains("repos/LeXwDeX/SpecGit/releases/latest"),
            "{calls}"
        );
        assert!(!calls.contains("application/octet-stream"));
        assert!(!calls.contains("cosign"));
        assert_eq!(
            report["next_actions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|a| a["kind"] == "consider_runtime_update"),
            status == "update_available"
        );
    }
}
#[test]
fn doctor_offline_skips_release_check_and_writes_nothing() {
    let fixture = Fixture::new("9.0.0", true);
    let before = fs::read(fixture.root.join("state.json")).unwrap();
    let report = fixture.run(&["doctor", "--offline"]);
    assert_eq!(
        report["evidence"]["runtime_update"]["status"],
        "not_checked"
    );
    assert!(fixture.calls().is_empty());
    assert_eq!(fs::read(fixture.root.join("state.json")).unwrap(), before);
}
#[test]
fn incomplete_release_is_unknown_without_changing_doctor_health() {
    let good =
        Fixture::new("9.0.0", true).run(&["doctor", "--account-only", "--provider", "github"]);
    let fixture = Fixture::new("9.0.0", false);
    let report = fixture.run(&["doctor", "--account-only", "--provider", "github"]);
    assert_eq!(report["evidence"]["runtime_update"]["status"], "unknown");
    assert!(report["evidence"]["runtime_update"]["diagnostic"].is_object());
    assert_eq!(report["exit"], good["exit"]);
    assert_eq!(report["status"], good["status"]);
    assert_eq!(report["evidence"]["health"], good["evidence"]["health"]);
}

#[test]
fn doctor_fix_never_downloads_and_human_output_explains_the_choice() {
    let fixture = Fixture::new("9.0.0", true);
    let report = fixture.run(&["doctor", "--fix"]);
    assert_eq!(
        report["evidence"]["runtime_update"]["status"],
        "update_available"
    );
    let output = fixture
        .command()
        .args([
            "--human",
            "doctor",
            "--account-only",
            "--provider",
            "github",
        ])
        .output()
        .unwrap();
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(text.contains("9.0.0"), "{text}");
    assert!(text.contains("specgit update"), "{text}");
    assert!(!fixture.calls().contains("application/octet-stream"));
    assert!(!fixture.calls().contains("cosign"));
}

#[test]
fn failed_metadata_stays_unknown_and_does_not_change_doctor_conclusion() {
    let args = ["doctor", "--account-only", "--provider", "github"];
    let baseline = Fixture::new("9.0.0", true).run(&args);
    for error in [
        "HTTP 401: Bad credentials",
        "error connecting to api.github.com",
        "HTTP 404: Not Found",
        "malformed",
    ] {
        let fixture = Fixture::new("9.0.0", true);
        let path = fixture.root.join("state.json");
        let mut state: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        if error == "malformed" {
            state["metadata_malformed"] = json!(true);
        } else {
            state["metadata_error"] = json!(error);
        }
        fs::write(&path, state.to_string()).unwrap();
        let report = fixture.run(&args);
        assert_eq!(
            report["evidence"]["runtime_update"]["status"], "unknown",
            "{report}"
        );
        assert!(report["evidence"]["runtime_update"]["latest_version"].is_null());
        assert!(
            report["evidence"]["runtime_update"]["diagnostic"]["remedy"]
                .as_str()
                .unwrap()
                .contains("specgit update --check")
        );
        assert_eq!(report["exit"], baseline["exit"]);
        assert_eq!(report["status"], baseline["status"]);
        assert_eq!(report["diagnostics"], baseline["diagnostics"]);
        assert!(!fixture.calls().contains("application/octet-stream"));
    }
}

#[test]
fn incomplete_same_version_and_missing_release_flags_are_not_up_to_date() {
    for complete in [false, true] {
        let fixture = Fixture::new(env!("CARGO_PKG_VERSION"), complete);
        if complete {
            let path = fixture.root.join("state.json");
            let mut state: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            let tag = state["latest"].as_str().unwrap().to_owned();
            state["releases"][&tag]
                .as_object_mut()
                .unwrap()
                .remove("draft");
            fs::write(path, state.to_string()).unwrap();
        }
        let report = fixture.run(&["doctor", "--account-only", "--provider", "github"]);
        assert_eq!(
            report["evidence"]["runtime_update"]["status"], "unknown",
            "{report}"
        );
    }
}

const RELEASE_ROUTE: &str = "repos/LeXwDeX/SpecGit/releases/latest";

fn official_release() -> Value {
    let source = Fixture::new("9.0.0", true);
    let state: Value =
        serde_json::from_slice(&fs::read(source.root.join("state.json")).unwrap()).unwrap();
    state["releases"]["v9.0.0"].clone()
}

fn platform_fixture() -> delivery::Fixture {
    let fixture = delivery::Fixture::new("github");
    fixture.edit(|state| {
        state["read_routes"] = json!({
            "user":{"id":1,"login":"fixture"},
            (RELEASE_ROUTE):official_release(),
            "repos/fixture/repo":state["project"].clone()
        });
    });
    fixture
}

#[test]
fn advisory_failures_preserve_successful_online_doctor() {
    let fixture = platform_fixture();
    let args = ["doctor", "--account-only", "--provider", "github"];
    let baseline = fixture.run(&args);
    assert_eq!(baseline["exit"], 0, "{baseline}");
    assert_eq!(baseline["status"], "ready", "{baseline}");
    for failure in [
        json!({"__fixture_error":"HTTP 401: Bad credentials"}),
        json!({"__fixture_error":"error connecting to api.github.com"}),
        json!({"tag_name":"v9.0.0"}),
        json!("not a release document"),
    ] {
        fixture.edit(|state| state["read_routes"][RELEASE_ROUTE] = failure);
        let report = fixture.run(&args);
        assert_eq!(report["exit"], 0, "{report}");
        assert_eq!(report["status"], "ready", "{report}");
        assert_eq!(report["evidence"]["health"], baseline["evidence"]["health"]);
        assert_eq!(report["diagnostics"], baseline["diagnostics"]);
        assert_eq!(report["evidence"]["runtime_update"]["status"], "unknown");
        let human = fixture.run_human(&args);
        let text = String::from_utf8(human.stdout).unwrap();
        assert!(text.contains("Runtime update: unknown."), "{text}");
        assert!(text.contains("specgit update --check"), "{text}");
    }
}

fn files(root: &std::path::Path) -> std::collections::BTreeMap<PathBuf, Option<Vec<u8>>> {
    let mut result = std::collections::BTreeMap::new();
    for entry in fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            result.insert(path.clone(), None);
            result.extend(files(&path));
        } else {
            result.insert(path.clone(), Some(fs::read(path).unwrap()));
        }
    }
    result
}

#[test]
fn offline_real_project_preserves_every_file_and_never_launches_provider() {
    let fixture = platform_fixture();
    let before = files(&fixture.root);
    let state = fixture.state();
    let report = fixture.run(&["doctor", "--offline"]);
    assert_eq!(report["exit"], 0, "{report}");
    assert_eq!(
        report["evidence"]["runtime_update"]["status"],
        "not_checked"
    );
    assert_eq!(files(&fixture.root), before);
    assert_eq!(fixture.state(), state);
}

#[test]
fn fix_repairs_real_owned_project_assets_without_upgrading_runtime() {
    use specgit::setup::{Agent, project};
    let fixture = platform_fixture();
    let git_dir = fixture.root.join(".git");
    let private = git_dir.join("specgit-v2");
    project::install(
        &project::Options {
            agents: vec![Agent::Generic],
            opencode_claude_hooks: false,
            uninstall: false,
            dry_run: false,
            rollback: None,
        },
        &fixture.root,
        &private.join("agent-assets"),
        &executable::binary(),
    )
    .unwrap();
    let declaration = specgit::config::read(&fixture.root).unwrap().unwrap();
    let changes =
        specgit::guidance::changes(&fixture.root, &private, &declaration, &declaration, false)
            .unwrap();
    specgit::assets::AssetStore::lock(
        &private.join("assets"),
        &[fixture.root.clone(), private.clone()],
        std::time::Duration::from_secs(2),
    )
    .unwrap()
    .apply(changes)
    .unwrap();
    let skill = fixture.root.join(".agents/skills/specgit-native/SKILL.md");
    assert!(skill.is_file());
    fs::remove_file(&skill).unwrap();
    let before = fs::read(executable::binary()).unwrap();
    let report = fixture.run(&["doctor", "--fix"]);
    assert_eq!(report["exit"], 0, "{report}");
    assert_eq!(
        report["evidence"]["runtime_update"]["status"], "update_available",
        "{report}"
    );
    assert!(
        report["evidence"]["repair"]["results"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["status"] == "applied"),
        "{report}"
    );
    assert!(skill.is_file());
    assert_eq!(fs::read(executable::binary()).unwrap(), before);
    let state = fixture.state();
    let calls = state["calls"].as_array().unwrap();
    assert_eq!(
        calls
            .iter()
            .filter(|c| c["endpoint"] == RELEASE_ROUTE)
            .count(),
        1,
        "{state}"
    );
    assert!(calls.iter().all(|c| c["method"] == "GET"), "{state}");
    assert!(
        !calls.iter().any(|c| c["endpoint"]
            .as_str()
            .unwrap_or("")
            .contains("releases/assets/")),
        "{state}"
    );
}
