#![cfg(feature = "test-fixtures")]
#[path = "support/executable.rs"]
mod executable;
use serde_json::{Value, json};
use std::{fs, path::PathBuf, process::Command, time::Instant};
struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    state: PathBuf,
    bin: PathBuf,
}

fn report_schema() -> Value {
    serde_json::from_str(include_str!("../schemas/report.schema.json")).unwrap()
}

fn init_evidence_schema(report_schema: &Value) -> Value {
    json!({
        "$schema": report_schema["$schema"],
        "$defs": report_schema["$defs"],
        "type": "object",
        "additionalProperties": true,
        "required": ["checks", "operation_assessments", "availability"],
        "properties": {
            "checks": {"type":"array","items":{"$ref":"#/$defs/init_check"}},
            "operation_assessments": {"$ref":"#/$defs/init_operation_assessments"},
            "availability": {"$ref":"#/$defs/init_availability"}
        }
    })
}

fn assert_report_matches_schema(report: &Value) {
    let schema = report_schema();
    jsonschema::draft202012::validate(&schema, report)
        .unwrap_or_else(|error| panic!("report violates report.schema.json: {error}"));
}

fn assert_init_evidence_matches_schema(evidence: &Value) {
    let schema = init_evidence_schema(&report_schema());
    jsonschema::draft202012::validate(&schema, evidence)
        .unwrap_or_else(|error| panic!("init evidence violates report.schema.json: {error}"));
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let root = base.join("project");
        fs::create_dir_all(&root).unwrap();
        for args in [
            vec!["init", "-b", "feature"],
            vec!["config", "user.name", "Fixture"],
            vec!["config", "user.email", "fixture@example.invalid"],
            vec!["commit", "--allow-empty", "-m", "fixture"],
            vec![
                "remote",
                "add",
                "origin",
                "https://forge.example/fixture/repo.git",
            ],
        ] {
            assert!(
                Command::new("git")
                    .current_dir(&root)
                    .args(args)
                    .output()
                    .unwrap()
                    .status
                    .success()
            );
        }
        let state = base.join("api.json");
        fs::write(&state,json!({"calls":[],"project":{"id":7,"full_name":"fixture/repo","path_with_namespace":"fixture/repo","default_branch":"preview","delete_branch_on_merge":false,"remove_source_branch_after_merge":false,"autoclose_referenced_issues":true,"unrelated":"keep"}}).to_string()).unwrap();
        let bin = base.join("bin");
        fs::create_dir(&bin).unwrap();
        for name in ["gh", "glab"] {
            fs::copy(
                env!("CARGO_BIN_EXE_specgit-process-fixture"),
                bin.join(if cfg!(windows) {
                    format!("{name}.exe")
                } else {
                    name.into()
                }),
            )
            .unwrap();
        }
        Self {
            _temp: temp,
            root,
            state,
            bin,
        }
    }
    fn run(&self, args: &[&str]) -> Value {
        let mut selected = args.to_vec();
        if args.first() == Some(&"init") && !args.contains(&"--rollback") {
            selected.push("--manual-observe");
        }
        self.run_raw(&selected)
    }
    fn run_raw(&self, args: &[&str]) -> Value {
        let mut paths = vec![self.bin.clone()];
        paths.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        self.run_raw_with_paths(args, paths)
    }
    fn run_raw_with_paths(&self, args: &[&str], paths: Vec<PathBuf>) -> Value {
        let out = executable::command()
            .current_dir(&self.root)
            .env("PATH", std::env::join_paths(paths).unwrap())
            .env("SPECGIT_FIXTURE_API_FILE", &self.state)
            .env(
                "SPECGIT_FIXTURE_FORWARD_GIT",
                specgit::process::resolve_executable("git").unwrap(),
            )
            .args(args)
            .arg("--json")
            .output()
            .unwrap();
        let v: Value = serde_json::from_slice(&out.stdout)
            .unwrap_or_else(|_| panic!("stdout={:?}, stderr={:?}", out.stdout, out.stderr));
        assert_eq!(v["exit"].as_i64(), out.status.code().map(i64::from));
        v
    }
    fn run_without_forge_cli(&self, args: &[&str]) -> Value {
        let git = self.bin.join(if cfg!(windows) { "git.exe" } else { "git" });
        if !git.exists() {
            // Only the forge CLI is missing; keep real Git without an extra Unix proxy process.
            #[cfg(unix)]
            std::os::unix::fs::symlink(specgit::process::resolve_executable("git").unwrap(), &git)
                .unwrap();
            #[cfg(windows)]
            fs::copy(env!("CARGO_BIN_EXE_specgit-process-fixture"), &git).unwrap();
        }
        self.run_raw_with_paths(args, vec![self.bin.clone()])
    }
    fn run_raw_with_budget(&self, args: &[&str], budget_ms: u64) -> Value {
        let out = self.command_with_budget(args, budget_ms).output().unwrap();
        let value: Value = serde_json::from_slice(&out.stdout)
            .unwrap_or_else(|_| panic!("stdout={:?}, stderr={:?}", out.stdout, out.stderr));
        assert_eq!(value["exit"].as_i64(), out.status.code().map(i64::from));
        value
    }
    fn command_with_budget(&self, args: &[&str], budget_ms: u64) -> Command {
        let mut paths = vec![self.bin.clone()];
        paths.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        // Short budgets require the feature-enabled fixture binary, not the installed release.
        let mut command = Command::new(env!("CARGO_BIN_EXE_specgit"));
        command
            .current_dir(&self.root)
            .env("PATH", std::env::join_paths(paths).unwrap())
            .env("SPECGIT_FIXTURE_API_FILE", &self.state)
            .env("SPECGIT_TEST_INSPECTION_BUDGET_MS", budget_ms.to_string())
            .args(args)
            .arg("--json");
        command
    }
    fn run_human(&self, args: &[&str]) -> Value {
        let mut paths = vec![self.bin.clone()];
        paths.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        let out = executable::command()
            .current_dir(&self.root)
            .env("PATH", std::env::join_paths(paths).unwrap())
            .env("SPECGIT_FIXTURE_API_FILE", &self.state)
            .args(args)
            .arg("--human")
            .output()
            .unwrap();
        assert!(out.status.code().is_some(), "human command should exit");
        let text = String::from_utf8(out.stdout).unwrap();
        let json_start = text.find('{').expect("human report contains evidence JSON");
        serde_json::from_str(&text[json_start..]).unwrap()
    }
    fn state(&self) -> Value {
        serde_json::from_slice(&fs::read(&self.state).unwrap()).unwrap()
    }
}

// Keep the advisory release request separate from project/account capability reads.
fn doctor_platform_calls(calls: &[Value]) -> Vec<&Value> {
    const RELEASE: &str = "repos/LeXwDeX/SpecGit/releases/latest";
    let releases: Vec<_> = calls
        .iter()
        .filter(|call| call["endpoint"] == RELEASE)
        .collect();
    assert_eq!(releases.len(), 1, "{calls:?}");
    assert_eq!(releases[0]["method"], "GET");
    assert_eq!(releases[0]["hostname"], "github.com");
    assert_eq!(releases[0]["executable"], "gh");
    assert!(releases[0]["body"].is_null());
    let platform: Vec<_> = calls
        .iter()
        .filter(|call| call["endpoint"] != RELEASE)
        .collect();
    assert!(platform.iter().all(|call| call["method"] == "GET"));
    platform
}

fn project_files(root: &std::path::Path) -> std::collections::BTreeMap<PathBuf, Option<Vec<u8>>> {
    let mut result = std::collections::BTreeMap::new();
    for entry in fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            result.insert(path.clone(), None);
            result.extend(project_files(&path));
        } else {
            result.insert(path.clone(), Some(fs::read(path).unwrap()));
        }
    }
    result
}

#[test]
fn environment_does_not_add_reads_to_github_or_normal_init() {
    for (provider, command) in [("github", "doctor"), ("github", "init"), ("gitlab", "init")] {
        let f = Fixture::new();
        let report = f.run(&[command, "--provider", provider]);
        assert_eq!(report["exit"], 0, "{report}");
        assert!(report["evidence"]["environment"].is_null());
        assert!(
            !f.state()["calls"]
                .as_array()
                .unwrap()
                .iter()
                .any(|call| call["endpoint"] == "metadata")
        );
    }
    let f = Fixture::new();
    let report = f.run(&["init", "--provider", "github", "--check"]);
    assert_eq!(report["exit"], 0, "{report}");
    assert!(report["evidence"]["environment"].is_null());
    assert!(
        !f.state()["calls"]
            .as_array()
            .unwrap()
            .iter()
            .any(|call| call["endpoint"] == "metadata")
    );
}

#[test]
fn optional_gitlab_environment_is_read_only_and_does_not_gate_core_readiness() {
    for metadata in [
        json!({"version":"18.4.0-ee","enterprise":true}),
        json!({}),
        json!({"__fixture_error":"403 Forbidden secret"}),
        json!({"__fixture_error":"404 Not Found secret"}),
        json!([]),
    ] {
        let f = Fixture::new();
        let mut state = f.state();
        state["read_routes"] = json!({
            "metadata": metadata,
            "user": {"id":1,"username":"fixture"},
            "projects/fixture%2Frepo": state["project"],
            "projects/7/merge_requests?state=opened&scope=all&source_branch=feature&per_page=100&page=1": [],
            "projects/7/protected_branches/preview": {"name":"preview"}
        });
        fs::write(&f.state, state.to_string()).unwrap();
        let doctor = f.run_raw(&["doctor", "--provider", "gitlab"]);
        assert_eq!(doctor["exit"], 0, "{doctor}");
        // Optional metadata still does not gate successful observation; this fresh
        // fixture now explicitly reports that project initialization is pending.
        assert_eq!(doctor["status"], "attention_required");
        assert!(
            doctor["evidence"]["health"]["checks"]
                .as_array()
                .unwrap()
                .iter()
                .any(|check| check["id"] == "declaration"
                    && check["status"] == "needs_initialization")
        );
        let environment = &doctor["evidence"]["environment"];
        assert_eq!(environment["host"], "forge.example");
        assert_eq!(environment["deployment"]["status"], "unknown");
        assert_eq!(environment["subscription"]["status"], "unknown");
        assert_report_matches_schema(&doctor);
        let mut invalid = doctor.clone();
        invalid["evidence"]["environment"]["raw"] = json!("forbidden");
        assert!(jsonschema::draft202012::validate(&report_schema(), &invalid).is_err());
        let report = f.run(&["init", "--provider", "gitlab", "--check"]);
        assert_eq!(report["exit"], 0, "{report}");
        assert_eq!(report["evidence"]["environment"], *environment);
        assert_eq!(report["evidence"]["written"], false);
        assert_report_matches_schema(&report);
        let check_calls = f.state()["calls"].as_array().unwrap().clone();
        assert_eq!(check_calls.last().unwrap()["endpoint"], "metadata");
        let human = f.run_human(&[
            "init",
            "--provider",
            "gitlab",
            "--check",
            "--manual-observe",
        ]);
        assert_eq!(human["environment"], *environment);
        if metadata.get("version").is_none() {
            assert_eq!(environment["metadata_status"], "unknown");
            assert_eq!(report["evidence"]["inspection"]["complete"], false);
            assert_eq!(human["inspection"]["complete"], false);
        }
        assert!(!environment.to_string().contains("secret"));
        let state = f.state();
        let calls = state["calls"].as_array().unwrap();
        assert!(calls.iter().all(|call| call["method"] == "GET"));
        assert_eq!(
            calls
                .iter()
                .filter(|call| call["endpoint"] == "metadata")
                .count(),
            3
        );
        assert!(!f.root.join(".specgit.yaml").exists());
        let account = f.run_raw(&[
            "doctor",
            "--provider",
            "gitlab",
            "--account-only",
            "--api-host",
            "gitlab.com",
        ]);
        assert_eq!(account["exit"], 0, "{account}");
        assert_eq!(
            account["evidence"]["environment"]["deployment"]["value"],
            "official_hosted"
        );
        assert_eq!(account["evidence"]["write_permissions"], "not_checked");
        assert_report_matches_schema(&account);
    }
}

#[cfg(unix)]
fn hanging_metadata_fixture() -> Fixture {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let executable = f.bin.join("glab");
    fs::rename(&executable, f.bin.join("native-fixture")).unwrap();
    // Only metadata hangs. All required reads still use the real fixture protocol.
    fs::write(
        &executable,
        "#!/bin/sh\nfor arg do\n  if [ \"$arg\" = metadata ]; then\n    printf '%s' \"$$\" > \"$(dirname \"$0\")/metadata.pid\"\n    exec sleep 30\n  fi\ndone\nexec \"$(dirname \"$0\")/native-fixture\" \"$@\"\n",
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
    f
}

#[cfg(unix)]
fn assert_metadata_reaped(f: &Fixture) {
    let pid = fs::read_to_string(f.bin.join("metadata.pid")).unwrap();
    assert!(
        !Command::new("kill")
            .args(["-0", &pid])
            .output()
            .unwrap()
            .status
            .success()
    );
}

#[cfg(unix)]
#[test]
fn optional_metadata_timeout_preserves_core_inspection_and_deadline() {
    let f = hanging_metadata_fixture();
    let started = Instant::now();
    let report = f.run_raw_with_budget(
        &[
            "init",
            "--provider",
            "gitlab",
            "--check",
            "--manual-observe",
        ],
        2000,
    );
    assert_eq!(report["exit"], 0, "{report}");
    assert_eq!(report["status"], "inspected");
    assert_eq!(report["evidence"]["request_read"], "verified");
    assert_eq!(report["evidence"]["written"], false);
    let environment = &report["evidence"]["environment"];
    assert_eq!(environment["metadata_status"], "unknown");
    assert_eq!(environment["diagnostic"]["code"], "timeout");
    let inspection = &report["evidence"]["inspection"];
    assert_eq!(inspection["complete"], false);
    assert_eq!(inspection["budget_exhausted"], true);
    assert_eq!(inspection["budget_ms"], 2000);
    assert!(inspection["requests_executed"].as_u64().unwrap() > 1);
    assert_eq!(
        inspection["activities"].as_array().unwrap().last().unwrap()["outcome"],
        "timed_out"
    );
    assert!(started.elapsed().as_secs_f64() < 6.0, "{report}");
    assert_report_matches_schema(&report);
    assert!(!f.root.join(".specgit.yaml").exists());
    assert_metadata_reaped(&f);
}

#[cfg(unix)]
#[test]
fn optional_metadata_cancellation_remains_failure_and_reaps_child() {
    use std::{process::Stdio, time::Duration};
    let f = hanging_metadata_fixture();
    let mut child = f
        .command_with_budget(
            &[
                "init",
                "--provider",
                "gitlab",
                "--check",
                "--manual-observe",
            ],
            5000,
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let started = Instant::now();
    while !f.bin.join("metadata.pid").exists() && started.elapsed() < Duration::from_secs(4) {
        std::thread::sleep(Duration::from_millis(10));
    }
    if !f.bin.join("metadata.pid").exists() {
        let _ = child.kill();
        let _ = child.wait();
        panic!("metadata did not start within the test deadline");
    }
    assert!(
        Command::new("kill")
            .args(["-INT", &child.id().to_string()])
            .status()
            .unwrap()
            .success()
    );
    let output = child.wait_with_output().unwrap();
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(!output.status.success(), "{report}");
    assert_eq!(report["diagnostics"][0]["code"], "cancelled", "{report}");
    // The CLI intentionally replaces interrupted command evidence with its
    // top-level cancellation report, even after the command has cleaned up.
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_metadata_reaped(&f);
    assert_report_matches_schema(&report);
}

#[test]
fn init_inspection_emits_typed_check_contract_in_json_and_human_output() {
    let f = Fixture::new();
    let json_report = f.run_raw(&["init", "--provider", "github", "--inspect"]);
    let human_evidence = f.run_human(&["init", "--provider", "github", "--inspect"]);
    assert_report_matches_schema(&json_report);
    assert_init_evidence_matches_schema(&human_evidence);
    let checks = json_report["evidence"]["checks"].as_array().unwrap();
    assert_eq!(checks.len(), 10);
    assert_eq!(
        checks
            .iter()
            .map(|check| check["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        specgit::config::INIT_CHECK_IDS
    );
    let by_id = |id: &str| checks.iter().find(|check| check["id"] == id).unwrap();
    let context = &json_report["evidence"]["context"];
    let expected_repository = json!({
        "provider": context["repository"]["provider"],
        "host": context["repository"]["host"],
        "path": context["repository"]["path"],
    });
    for check in checks {
        assert_eq!(
            check["scope"],
            json!({
                "repository":expected_repository,
                "branch":context["branch"],
                "commit":context["head"],
            })
        );
    }
    let mut invalid_report = json_report.clone();
    invalid_report["evidence"]["checks"][0]["scope"]["unexpected"] = json!(true);
    let schema = report_schema();
    assert!(jsonschema::draft202012::validate(&schema, &invalid_report).is_err());
    assert_eq!(by_id("forge.read_access")["status"], "verified");
    assert_eq!(by_id("forge.read_access")["requirement"], "required");
    assert_eq!(by_id("forge.read_access")["diagnostic"], Value::Null);
    assert_eq!(by_id("issue.duplicate_read")["status"], "not_checked");
    assert_eq!(by_id("issue.duplicate_read")["presentation"], "blocking");
    assert_eq!(by_id("issue.write_permission")["status"], "unknown");
    assert_eq!(by_id("request.write_permission")["status"], "unknown");
    assert_eq!(by_id("target.protection")["status"], "unknown");
    assert_eq!(by_id("target.protection")["presentation"], "warning");
    assert_eq!(by_id("request.eligibility")["requirement"], "optional");
    assert_eq!(by_id("request.eligibility")["status"], "not_applicable");
    for json_check in checks {
        let human_check = human_evidence["checks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|check| check["id"] == json_check["id"])
            .unwrap();
        for field in [
            "id",
            "status",
            "requirement",
            "requirement_source",
            "presentation",
            "applies_to",
            "scope",
            "diagnostic",
        ] {
            assert_eq!(human_check[field], json_check[field], "field {field}");
        }
    }
    assert_eq!(
        human_evidence["operation_assessments"],
        json_report["evidence"]["operation_assessments"]
    );
    let operations = json_report["evidence"]["operation_assessments"]["operations"]
        .as_array()
        .unwrap();
    let operation = |id: &str| {
        operations
            .iter()
            .find(|entry| entry["operation"] == id)
            .unwrap()
    };
    assert_eq!(
        operation("local_diagnostics")["assessment"],
        "no_reported_blocker"
    );
    assert_eq!(operation("issue_creation")["assessment"], "blocked");
    assert!(
        operation("issue_creation")["blocked_by"]
            .as_array()
            .unwrap()
            .contains(&json!("issue.duplicate_read"))
    );
    assert!(
        operation("issue_creation")["unverified_by"]
            .as_array()
            .unwrap()
            .contains(&json!("issue.write_permission"))
    );
    assert_eq!(
        operation("protected_delivery")["assessment"],
        "no_reported_blocker"
    );
    assert_eq!(
        operation("protected_delivery")["warnings"],
        json!(["target.protection"])
    );
    assert_eq!(operation("request_delivery")["assessment"], "unverified");
    assert!(
        operation("request_delivery")["unverified_by"]
            .as_array()
            .unwrap()
            .contains(&json!("request.write_permission"))
    );
    assert_eq!(
        json_report["evidence"]["operation_assessments"]["scope"],
        "reported_checks_only"
    );
    assert_eq!(json_report["exit"], 2);
    assert_eq!(json_report["status"], "confirmation_required");
    assert_eq!(json_report["evidence"]["written"], false);
    assert!(!f.root.join(".specgit.yaml").exists());
    assert!(!f.root.join(".git/specgit-v2").exists());
    assert_eq!(
        f.state()["calls"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|call| call["method"] == "POST" || call["method"] == "PUT")
            .count(),
        0,
        "inspection must not probe native write permissions"
    );
}

#[test]
fn init_and_doctor_derive_write_permissions_without_extra_api_routes() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/write-permissions.json")).unwrap();
    for case in cases {
        let provider = case["provider"].as_str().unwrap();
        let f = Fixture::new();
        let mut state = f.state();
        state["project"]
            .as_object_mut()
            .unwrap()
            .extend(case["fields"].as_object().unwrap().clone());
        fs::write(&f.state, state.to_string()).unwrap();
        let report = f.run_raw(&[
            "init",
            "--provider",
            provider,
            "--inspect",
            "--manual-observe",
        ]);
        assert_report_matches_schema(&report);
        assert_eq!(report["status"], "inspected", "{case}: {report}");
        assert_eq!(report["exit"], 0);
        let checks = report["evidence"]["checks"].as_array().unwrap();
        let account = report["evidence"]["probes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|probe| probe["operation"] == "account_api")
            .unwrap();
        let permissions = &account["evidence"]["write_permissions"];
        for (kind, id) in [
            ("issue", "issue.write_permission"),
            ("request", "request.write_permission"),
        ] {
            let check = checks.iter().find(|check| check["id"] == id).unwrap();
            let (status, presentation) = match case[kind].as_str().unwrap() {
                "supported" => ("verified", "pass"),
                "unsupported" => ("not_configured", "blocking"),
                _ => ("unknown", "hint"),
            };
            assert_eq!(permissions[kind]["status"], case[kind], "{case}: {report}");
            assert_eq!(check["status"], status, "{case}: {check}");
            assert_eq!(check["presentation"], presentation);
            assert_eq!(check["source"], permissions[kind]["source"]);
            assert!(check["source"].as_str().unwrap().contains("permissions"));
            let reason = check["reason"].as_str().unwrap();
            assert!(reason.contains("role"));
            assert!(reason.contains("fine-grained token"));
            assert!(reason.contains("branch protection"));
            assert!(!check["next_step"].as_str().unwrap().is_empty());
        }
        if provider == "github" {
            assert!(
                permissions["issue"]["reason"]
                    .as_str()
                    .unwrap()
                    .contains("triage")
            );
        }
        let layers = report["evidence"]["availability"]["layers"]
            .as_array()
            .unwrap();
        assert_eq!(layers[0]["status"], "ready");
        assert_eq!(
            layers[1]["status"],
            if case["request"] == "unsupported" {
                "blocked"
            } else {
                "unverified"
            }
        );
        assert_eq!(layers[2]["status"], "unverified");
        let expected_routes = if provider == "github" {
            vec![
                "user",
                "repos/fixture/repo",
                "repos/fixture/repo/pulls?state=open&head=fixture%3Afeature&per_page=100&page=1",
                "repos/fixture/repo",
                "repos/fixture/repo/rules/branches/preview?per_page=100&page=1",
                "repos/fixture/repo/branches/preview/protection",
            ]
        } else {
            vec![
                "user",
                "projects/fixture%2Frepo",
                "projects/7/merge_requests?state=opened&scope=all&source_branch=feature&per_page=100&page=1",
                "projects/7/protected_branches/preview",
                "metadata",
            ]
        };
        let calls = f.state()["calls"].as_array().unwrap().clone();
        assert_eq!(
            calls
                .iter()
                .map(|call| call["endpoint"].as_str().unwrap())
                .collect::<Vec<_>>(),
            expected_routes,
            "{case}"
        );
        assert!(calls.iter().all(|call| call["method"] == "GET"));

        state = f.state();
        state["calls"] = json!([]);
        state["record_transport"] = json!(true);
        fs::write(&f.state, state.to_string()).unwrap();
        let before = project_files(&f.root);
        let doctor = f.run_raw(&["doctor", "--provider", provider]);
        assert_eq!(project_files(&f.root), before);
        assert_eq!(doctor["exit"], 0, "{case}: {doctor}");
        assert_eq!(doctor["evidence"]["write_permissions"], *permissions);
        let probes = doctor["evidence"]["probes"].as_array().unwrap();
        for operation in ["project_api", "account_api"] {
            assert_eq!(
                probes
                    .iter()
                    .find(|probe| probe["operation"] == operation)
                    .unwrap()["evidence"]["write_permissions"],
                *permissions
            );
        }
        let calls = f.state()["calls"].as_array().unwrap().clone();
        let calls = doctor_platform_calls(&calls);
        assert_eq!(calls.len(), if provider == "github" { 2 } else { 3 });
        assert!(calls.iter().all(|call| call["hostname"] == "forge.example"));
        assert!(
            calls
                .iter()
                .all(|call| call["executable"] == if provider == "github" { "gh" } else { "glab" })
        );
        if provider == "gitlab" {
            assert_eq!(calls[2]["endpoint"], "metadata");
        }
        assert_eq!(calls[0]["endpoint"], "user");
        assert_eq!(calls[1]["endpoint"], expected_routes[1]);
        assert!(calls.iter().all(|call| call["method"] == "GET"));
    }
}

#[test]
fn failed_native_identity_preserves_scope_without_claiming_verification() {
    for provider in ["github", "gitlab"] {
        let f = Fixture::new();
        let mut state = f.state();
        state["project"]["full_name"] = json!("other/repo");
        state["project"]["path_with_namespace"] = json!("other/repo");
        fs::write(&f.state, state.to_string()).unwrap();
        let report = f.run_raw(&["init", "--provider", provider, "--inspect"]);
        assert_init_evidence_matches_schema(&report["evidence"]);
        assert_eq!(report["diagnostics"][0]["code"], "identity_mismatch");
        assert_eq!(report["evidence"]["inspection"]["complete"], false);
        assert_eq!(report["evidence"]["inspection"]["status"], "incomplete");
        let identity = &report["evidence"]["checks"][0];
        assert_eq!(identity["status"], "unknown");
        assert_eq!(identity["presentation"], "blocking");
        assert_eq!(identity["diagnostic"]["code"], "identity_mismatch");
        assert_eq!(identity["scope"]["repository"]["path"], "fixture/repo");
        assert_eq!(
            report["evidence"]["availability"]["layers"][0]["status"],
            "blocked"
        );
        assert!(!f.root.join(".specgit.yaml").exists());
    }
}

#[test]
fn unknown_or_insufficient_roles_do_not_prevent_local_initialization() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/write-permissions.json")).unwrap();
    for case in cases.iter().filter(|case| {
        case["name"] == "missing" || case["name"] == "read_only" || case["name"] == "guest"
    }) {
        let f = Fixture::new();
        let mut state = f.state();
        state["project"]
            .as_object_mut()
            .unwrap()
            .extend(case["fields"].as_object().unwrap().clone());
        fs::write(&f.state, state.to_string()).unwrap();
        let report = f.run(&["init", "--provider", case["provider"].as_str().unwrap()]);
        assert_eq!(report["exit"], 0, "{case}: {report}");
        assert_eq!(report["evidence"]["written"], true);
        assert!(f.root.join(".specgit.yaml").exists());
        assert!(f.root.join("AGENTS.md").exists());
        let report = f.run(&["init", "--inspect"]);
        assert_eq!(report["exit"], 0, "{case}: {report}");
        let check = report["evidence"]["checks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|check| check["id"] == "request.write_permission")
            .unwrap();
        assert_eq!(
            check["status"],
            if case["request"] == "unknown" {
                "unknown"
            } else {
                "not_configured"
            }
        );
        assert!(
            f.state()["calls"]
                .as_array()
                .unwrap()
                .iter()
                .all(|call| call["method"] == "GET")
        );
    }
}

#[test]
fn role_permissions_survive_later_init_read_failures() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/write-permissions.json")).unwrap();
    for case in cases
        .iter()
        .filter(|case| case["name"] == "push" || case["name"] == "developer")
    {
        for invalid_branch in [false, true] {
            let f = Fixture::new();
            let provider = case["provider"].as_str().unwrap();
            let mut state = f.state();
            state["project"]
                .as_object_mut()
                .unwrap()
                .extend(case["fields"].as_object().unwrap().clone());
            if invalid_branch {
                state["project"]["default_branch"] = json!("invalid..branch");
            } else {
                let route = if provider == "github" {
                    "repos/fixture/repo/pulls?state=open&head=fixture%3Afeature&per_page=100&page=1"
                } else {
                    "projects/7/merge_requests?state=opened&scope=all&source_branch=feature&per_page=100&page=1"
                };
                state["request_fixture"] = json!(true);
                state["read_routes"] = json!({route: {"__fixture_error":"HTTP 403"}});
            }
            fs::write(&f.state, state.to_string()).unwrap();
            let report = f.run_raw(&["init", "--provider", provider, "--inspect"]);
            assert_report_matches_schema(&report);
            assert_eq!(report["exit"], 3);
            for check in report["evidence"]["checks"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|check| {
                    check["id"] == "issue.write_permission"
                        || check["id"] == "request.write_permission"
                })
            {
                assert_eq!(check["status"], "verified", "{case}: {report}");
                assert_eq!(check["presentation"], "pass");
            }
            assert!(!f.root.join(".specgit.yaml").exists());
        }
    }
}

#[test]
fn doctor_project_read_failure_reports_unknown_roles_and_optional_metadata_read() {
    for provider in ["github", "gitlab"] {
        let f = Fixture::new();
        let route = if provider == "github" {
            "repos/fixture/repo"
        } else {
            "projects/fixture%2Frepo"
        };
        let mut state = f.state();
        state["record_transport"] = json!(true);
        state["read_routes"] = json!({
            "user": {"id":1,"login":"fixture","username":"fixture"},
            route: {"__fixture_error":"HTTP 403"},
        });
        fs::write(&f.state, state.to_string()).unwrap();
        let before = project_files(&f.root);
        let report = f.run_raw(&["doctor", "--provider", provider]);
        assert_eq!(project_files(&f.root), before);
        assert_report_matches_schema(&report);
        assert_eq!(report["exit"], 3);
        for kind in ["issue", "request"] {
            assert_eq!(
                report["evidence"]["write_permissions"][kind]["status"],
                "unknown"
            );
        }
        let calls = f.state()["calls"].as_array().unwrap().clone();
        let calls = doctor_platform_calls(&calls);
        assert_eq!(calls.len(), if provider == "github" { 2 } else { 3 });
        assert_eq!(calls[0]["endpoint"], "user");
        assert_eq!(calls[1]["endpoint"], route);
        assert!(calls.iter().all(|call| call["hostname"] == "forge.example"));
        assert!(
            calls
                .iter()
                .all(|call| call["executable"] == if provider == "github" { "gh" } else { "glab" })
        );
        if provider == "gitlab" {
            assert_eq!(calls[2]["endpoint"], "metadata");
        }
        assert!(calls.iter().all(|call| call["method"] == "GET"));
    }
}

#[test]
fn account_only_failures_keep_inspection_incomplete() {
    for provider in ["github", "gitlab"] {
        for error in ["HTTP 403", "network connection failed"] {
            let f = Fixture::new();
            let mut state = f.state();
            state["account_failure"] = json!(error);
            fs::write(&f.state, state.to_string()).unwrap();
            let report = f.run_raw(&["init", "--provider", provider, "--inspect"]);
            assert_report_matches_schema(&report);
            assert_eq!(report["exit"], 3);
            assert_eq!(
                report["evidence"]["inspection"]["complete"], false,
                "{report}"
            );
            assert_eq!(report["evidence"]["inspection"]["status"], "incomplete");
            assert_eq!(report["evidence"]["project"]["id"], 7);
            let account = report["evidence"]["probes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|probe| probe["operation"] == "account_api")
                .unwrap();
            assert_eq!(
                account["diagnostic"]["code"],
                if error == "HTTP 403" {
                    "permission_denied"
                } else {
                    "network_failed"
                }
            );
            assert!(!f.root.join(".specgit.yaml").exists());
        }
    }
}

#[test]
fn protection_read_failures_keep_inspection_incomplete_with_manual_observation() {
    for provider in ["github", "gitlab"] {
        for error in ["network connection failed", "HTTP 403"] {
            let f = Fixture::new();
            let mut state = f.state();
            state["project"]["default_branch"] = json!("main");
            let endpoint = if provider == "github" {
                "repos/fixture/repo/branches/main/protection"
            } else {
                "projects/7/protected_branches/main"
            };
            state["read_routes"] = json!({
                "user": {"id":1,"login":"fixture","username":"fixture"},
                "repos/fixture/repo": state["project"].clone(),
                "projects/fixture%2Frepo": state["project"].clone(),
                "repos/fixture/repo/pulls?state=open&head=fixture%3Afeature&per_page=100&page=1": [],
                "projects/7/merge_requests?state=opened&scope=all&source_branch=feature&per_page=100&page=1": [],
                "repos/fixture/repo/rules/branches/main?per_page=100&page=1": [],
                endpoint: {"__fixture_error": error}
            });
            fs::write(&f.state, state.to_string()).unwrap();
            let args = [
                "init",
                "--provider",
                provider,
                "--inspect",
                "--manual-observe",
            ];
            let report = f.run_raw(&args);
            assert_report_matches_schema(&report);
            assert_eq!(report["status"], "inspected", "{report}");
            assert!(
                report["evidence"]["probes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|probe| probe["status"] == "available")
            );
            let evidence = &report["evidence"];
            let protection = &evidence["capabilities"]["target_protection"];
            assert_eq!(protection["status"], "unknown");
            assert_eq!(
                protection["diagnostic"]["code"],
                if error == "HTTP 403" {
                    "permission_denied"
                } else {
                    "network_failed"
                }
            );
            assert_eq!(evidence["inspection"]["complete"], false, "{report}");
            assert_eq!(evidence["inspection"]["status"], "incomplete");
            assert_eq!(evidence["written"], false);
            let human = f.run_human(&args);
            assert_init_evidence_matches_schema(&human);
            assert_eq!(human["capabilities"]["target_protection"], *protection);
            assert_eq!(human["inspection"]["complete"], false);
            assert_eq!(human["inspection"]["status"], "incomplete");
            assert!(
                f.state()["calls"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|call| call["method"] == "GET")
            );
            assert!(!f.root.join(".specgit.yaml").exists());
            assert!(!f.root.join(".git/specgit-v2").exists());
        }
    }
}

#[test]
fn invalid_native_default_branch_keeps_inspection_incomplete() {
    for provider in ["github", "gitlab"] {
        let f = Fixture::new();
        let mut state = f.state();
        state["project"]["default_branch"] = json!("invalid..branch");
        fs::write(&f.state, state.to_string()).unwrap();
        let report = f.run_raw(&["init", "--provider", provider, "--inspect"]);
        assert_report_matches_schema(&report);
        assert_eq!(report["diagnostics"][0]["code"], "malformed_response");
        assert_eq!(report["evidence"]["inspection"]["complete"], false);
        assert_eq!(report["evidence"]["inspection"]["status"], "incomplete");
        assert!(!f.root.join(".specgit.yaml").exists());
    }
}

#[test]
fn failed_request_read_keeps_required_eligibility_unknown_and_blocking() {
    for (provider, route) in [
        (
            "github",
            "repos/fixture/repo/pulls?state=open&head=fixture%3Afeature&per_page=100&page=1",
        ),
        (
            "gitlab",
            "projects/7/merge_requests?state=opened&scope=all&source_branch=feature&per_page=100&page=1",
        ),
    ] {
        let f = Fixture::new();
        fs::write(
            f.root.join(".specgit.yaml"),
            "version: 2\ninit_policy: {required_checks: [request.eligibility]}\n",
        )
        .unwrap();
        let mut state = f.state();
        state["request_fixture"] = json!(true);
        state["read_routes"] = json!({route: {"__fixture_error": "HTTP 403"}});
        fs::write(&f.state, state.to_string()).unwrap();
        let report = f.run_raw(&["init", "--provider", provider, "--inspect"]);
        assert_init_evidence_matches_schema(&report["evidence"]);
        assert_eq!(report["diagnostics"][0]["code"], "permission_denied");
        assert_eq!(report["evidence"]["inspection"]["complete"], false);
        assert_eq!(report["evidence"]["inspection"]["status"], "incomplete");
        let eligibility = report["evidence"]["checks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|check| check["id"] == "request.eligibility")
            .unwrap();
        assert_eq!(eligibility["status"], "unknown");
        assert_eq!(eligibility["presentation"], "blocking");
        assert_eq!(eligibility["diagnostic"]["code"], "permission_denied");
        let merge = report["evidence"]["operation_assessments"]["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|op| op["operation"] == "request_merge")
            .unwrap();
        assert_eq!(merge["assessment"], "blocked");
        assert!(!f.root.join("AGENTS.md").exists());
    }
}

#[test]
fn init_keeps_structured_diagnostics_when_native_cli_is_missing() {
    let f = Fixture::new();
    fs::remove_file(f.bin.join(if cfg!(windows) { "gh.exe" } else { "gh" })).unwrap();

    let report = f.run_without_forge_cli(&["init", "--provider", "github"]);
    assert_report_matches_schema(&report);
    assert_eq!(report["exit"], 3);
    assert_eq!(report["evidence"]["written"], false);
    assert_eq!(
        report["evidence"]["context"]["repository"]["path"],
        "fixture/repo"
    );
    assert_eq!(report["evidence"]["checks"].as_array().unwrap().len(), 10);
    let cli = report["evidence"]["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|check| check["id"] == "forge.cli")
        .unwrap();
    assert_eq!(cli["status"], "failed");
    assert_eq!(cli["presentation"], "blocking");
    assert_eq!(
        report["evidence"]["availability"]["layers"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    let report = f.run_without_forge_cli(&["init", "--provider", "github", "--inspect"]);
    assert_report_matches_schema(&report);
    assert_eq!(
        report["diagnostics"][0]["code"], "missing_executable",
        "{report}"
    );
    assert_eq!(report["evidence"]["inspection"]["complete"], false);
    assert_eq!(report["evidence"]["inspection"]["status"], "incomplete");
}

#[test]
fn init_inspection_reports_three_independent_availability_layers() {
    let f = Fixture::new();
    let json_report = f.run_raw(&["init", "--provider", "github", "--inspect"]);
    let human_evidence = f.run_human(&["init", "--provider", "github", "--inspect"]);
    let availability = json_report["evidence"]
        .get("availability")
        .expect("init inspection reports layered availability");
    let layers = availability["layers"].as_array().unwrap();
    assert_eq!(
        layers
            .iter()
            .map(|layer| layer["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "specification_development",
            "protected_delivery",
            "delivery_completion"
        ]
    );
    let layer = |id: &str| layers.iter().find(|entry| entry["id"] == id).unwrap();
    assert_eq!(availability["scope"], "reported_init_facts_only");
    assert_eq!(layer("specification_development")["status"], "ready");
    assert_eq!(
        layer("specification_development")["checks"],
        json!(["project.identity"])
    );
    assert_eq!(layer("specification_development")["blocked_by"], json!([]));
    assert_eq!(
        layer("specification_development")["unverified_by"],
        json!([])
    );
    assert_eq!(layer("protected_delivery")["status"], "unverified");
    assert!(
        layer("protected_delivery")["checks"]
            .as_array()
            .unwrap()
            .contains(&json!("target.protection"))
    );
    assert!(
        layer("protected_delivery")["warnings"]
            .as_array()
            .unwrap()
            .contains(&json!("target.protection"))
    );
    assert!(
        layer("protected_delivery")["unverified_by"]
            .as_array()
            .unwrap()
            .contains(&json!("request.write_permission"))
    );
    assert!(
        layer("protected_delivery")["unverified_by"]
            .as_array()
            .unwrap()
            .contains(&json!("ci.required_verification"))
    );
    assert!(
        layer("protected_delivery")["next_step"]
            .as_str()
            .is_some_and(|step| !step.is_empty())
    );
    assert_eq!(
        layer("delivery_completion")["status"],
        "unverified",
        "init's capability checks do not establish merge or delivery completion"
    );
    assert_eq!(layer("delivery_completion")["checks"], json!([]));
    assert_eq!(layer("delivery_completion")["facts"], json!([]));
    for unknown in ["native.merge_readback", "native.issue_closure_readback"] {
        assert!(
            layer("delivery_completion")["unverified_by"]
                .as_array()
                .unwrap()
                .contains(&json!(unknown)),
            "missing lifecycle evidence {unknown} must remain visible"
        );
    }
    assert!(
        !availability
            .to_string()
            .contains("main.installed_acceptance")
    );
    assert!(
        availability["note"]
            .as_str()
            .unwrap()
            .contains("init_policy.required_checks")
    );
    assert!(availability.get("overall").is_none());
    assert_eq!(
        json_report["evidence"]["operation_assessments"]["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["operation"] == "protected_delivery")
            .unwrap()["assessment"],
        "no_reported_blocker",
        "the layer conclusion must not promote the narrower operation assessment"
    );
    assert_eq!(&human_evidence["availability"], availability);
    assert_report_matches_schema(&json_report);
    assert_init_evidence_matches_schema(&human_evidence);

    let mut contradictory = json_report.clone();
    contradictory["evidence"]["availability"]["layers"][1]["status"] = json!("ready");
    assert!(jsonschema::draft202012::validate(&report_schema(), &contradictory).is_err());

    let mut missing_reason = json_report.clone();
    missing_reason["evidence"]["availability"]["layers"][1]["unverified_by"] = json!([]);
    missing_reason["evidence"]["availability"]["layers"][1]["warnings"] = json!([]);
    assert!(jsonschema::draft202012::validate(&report_schema(), &missing_reason).is_err());

    let mut wrong_order = json_report.clone();
    wrong_order["evidence"]["availability"]["layers"][0]["id"] = json!("protected_delivery");
    assert!(jsonschema::draft202012::validate(&report_schema(), &wrong_order).is_err());
}

#[test]
fn init_inspection_reports_monotonic_activity_and_total_timing() {
    let f = Fixture::new();
    let mut state = f.state();
    state["api_delay_ms"] = json!(35);
    state["read_routes"] = json!({
        "user": {"id":1,"login":"fixture"},
        "repos/fixture/repo": state["project"].clone(),
        "repos/fixture/repo/pulls?state=open&head=fixture%3Afeature&per_page=100&page=1": [],
        "repos/fixture/repo/rules/branches/preview?per_page=100&page=1": [],
        "repos/fixture/repo/branches/preview/protection": {}
    });
    fs::write(&f.state, serde_json::to_vec(&state).unwrap()).unwrap();

    let wall_started = Instant::now();
    let report = f.run_raw(&["init", "--provider", "github", "--inspect"]);
    let wall_ms = wall_started.elapsed().as_millis() as u64;
    let human = f.run_human(&["init", "--provider", "github", "--inspect"]);
    let timing = &report["evidence"]["inspection"];
    assert_eq!(timing["budget_ms"], 120_000, "{report}");
    assert!(
        timing["elapsed_ms"]
            .as_u64()
            .is_some_and(|elapsed| (30..=wall_ms).contains(&elapsed)),
        "reported monotonic elapsed time must include the delayed native response: {report}"
    );
    assert!(
        timing["requests_executed"].as_u64().unwrap_or_default() > 0,
        "{report}"
    );
    assert_eq!(timing["complete"], true, "{report}");
    assert_eq!(
        report["evidence"]["capabilities"]["target_protection"]["status"],
        "unknown"
    );
    assert_eq!(
        report["evidence"]["capabilities"]["target_protection"]["diagnostic"],
        Value::Null
    );
    assert!(
        timing["activities"].as_array().is_some_and(|activities| {
            activities.iter().any(|activity| {
                activity["operation"] == "github_api_read"
                    && activity["elapsed_ms"]
                        .as_u64()
                        .is_some_and(|elapsed| elapsed >= 30)
            })
        }),
        "every executed native probe must include its measured duration: {report}"
    );
    let human_timing = &human["inspection"];
    assert_eq!(human_timing["budget_ms"], timing["budget_ms"]);
    assert_eq!(
        human_timing["requests_executed"],
        timing["requests_executed"]
    );
    assert_eq!(human_timing["complete"], timing["complete"]);
    assert!(human_timing["elapsed_ms"].as_u64().is_some());
    assert!(
        human_timing["activities"]
            .as_array()
            .is_some_and(|activities| {
                activities
                    .iter()
                    .all(|activity| activity["elapsed_ms"].as_u64().is_some())
            })
    );
}

#[test]
fn init_inspection_budget_exhaustion_keeps_elapsed_failure_evidence() {
    let f = Fixture::new();
    let mut state = f.state();
    state["api_delay_ms"] = json!(100);
    fs::write(&f.state, serde_json::to_vec(&state).unwrap()).unwrap();
    let report = f.run_raw_with_budget(&["init", "--provider", "github", "--inspect"], 20);
    let timing = &report["evidence"]["inspection"];
    assert_eq!(report["exit"], 3, "{report}");
    assert_eq!(report["diagnostics"][0]["code"], "timeout", "{report}");
    assert_eq!(timing["budget_ms"], 20, "{report}");
    assert_eq!(timing["complete"], false, "{report}");
    assert!(
        timing["elapsed_ms"].as_u64().unwrap_or_default() >= 20,
        "{report}"
    );
}

#[test]
fn required_unknown_target_protection_blocks_protected_delivery_not_local_development() {
    let f = Fixture::new();
    fs::write(
        f.root.join(".specgit.yaml"),
        b"version: 2\ninit_policy: {required_checks: [target.protection]}\n",
    )
    .unwrap();
    let report = f.run_raw(&["init", "--provider", "github", "--inspect"]);
    let availability = report["evidence"]
        .get("availability")
        .expect("init inspection reports layered availability");
    assert_report_matches_schema(&report);
    let layers = availability["layers"].as_array().unwrap();
    let layer = |id: &str| layers.iter().find(|entry| entry["id"] == id).unwrap();
    assert_eq!(layer("specification_development")["status"], "ready");
    assert_eq!(layer("protected_delivery")["status"], "blocked");
    assert!(
        layer("protected_delivery")["blocked_by"]
            .as_array()
            .unwrap()
            .contains(&json!("target.protection"))
    );
    assert_eq!(layer("delivery_completion")["status"], "unverified");
}

#[test]
fn init_inspection_does_not_treat_green_ci_on_an_open_request_as_delivery_completion() {
    let f = Fixture::new();
    let head = String::from_utf8(
        Command::new("git")
            .current_dir(&f.root)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_owned();
    let mut state = f.state();
    state["request_fixture"] = json!(true);
    state["requests"] = json!([{
        "number": 9,
        "state": "open",
        "merged": false,
        "head": {"repo": {"id": 7}, "ref": "feature"},
        "base": {"repo": {"id": 7}, "ref": "preview"}
    }]);
    let mut routes = serde_json::Map::new();
    routes.insert(
        format!("repos/fixture/repo/actions/runs?head_sha={head}&per_page=100&page=1"),
        json!({
            "total_count": 1,
            "workflow_runs": [{
                "id": 71,
                "head_sha": head,
                "status": "completed",
                "conclusion": "success"
            }]
        }),
    );
    state["read_routes"] = Value::Object(routes);
    fs::write(&f.state, state.to_string()).unwrap();

    let report = f.run_raw(&["init", "--provider", "github", "--inspect"]);
    assert_report_matches_schema(&report);
    assert!(!report["evidence"]["request"].is_null());
    let completion = report["evidence"]["availability"]["layers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|layer| layer["id"] == "delivery_completion")
        .unwrap();
    assert_eq!(completion["status"], "unverified");
    assert_eq!(completion["facts"], json!(["native.open_request"]));
    assert!(
        completion["unverified_by"]
            .as_array()
            .unwrap()
            .contains(&json!("native.merge_readback"))
    );
    let calls = f.state()["calls"].as_array().unwrap().clone();
    assert!(
        calls.iter().all(|call| !call["endpoint"]
            .as_str()
            .unwrap_or_default()
            .contains("actions/runs")),
        "init inspection must not claim CI readiness or add a CI probe"
    );
}

#[test]
fn init_inspection_keeps_merged_request_with_open_issue_unverified_without_lifecycle_readbacks() {
    let f = Fixture::new();
    let mut state = f.state();
    state["request_fixture"] = json!(true);
    state["requests"] = json!([]);
    state["read_routes"] = json!({
        "repos/fixture/repo/pulls?state=open&head=fixture%3Afeature&per_page=100&page=1": [],
        "repos/fixture/repo/pulls/9": {
            "number": 9,
            "state": "closed",
            "merged": true,
            "updated_at": "2026-09-10T00:00:00Z"
        },
        "repos/fixture/repo/issues/624": {
            "number": 624,
            "state": "open",
            "updated_at": "2026-09-10T00:00:00Z"
        }
    });
    state["stale_installed_acceptance"] = json!({
        "source_sha": "a".repeat(40),
        "observed_at": "2026-09-10T00:00:00Z",
        "result": "passed"
    });
    fs::write(&f.state, state.to_string()).unwrap();

    let report = f.run_raw(&["init", "--provider", "github", "--inspect"]);
    assert_report_matches_schema(&report);
    let completion = report["evidence"]["availability"]["layers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|layer| layer["id"] == "delivery_completion")
        .unwrap();
    assert_eq!(completion["status"], "unverified");
    assert_eq!(completion["facts"], json!([]));
    assert_eq!(
        completion["unverified_by"],
        json!(["native.merge_readback", "native.issue_closure_readback"])
    );
    let calls = f.state()["calls"].as_array().unwrap().clone();
    assert!(calls.iter().all(|call| {
        !call["endpoint"]
            .as_str()
            .unwrap_or_default()
            .contains("/pulls/9")
            && !call["endpoint"]
                .as_str()
                .unwrap_or_default()
                .contains("/issues/624")
    }));
}

#[test]
fn init_inspection_keeps_commit_scope_when_head_is_detached() {
    let f = Fixture::new();
    let detached = Command::new("git")
        .current_dir(&f.root)
        .args(["checkout", "--detach"])
        .output()
        .unwrap();
    assert!(detached.status.success(), "stderr={:?}", detached.stderr);
    let head = Command::new("git")
        .current_dir(&f.root)
        .args(["rev-parse", "--verify", "HEAD"])
        .output()
        .unwrap();
    assert!(head.status.success());
    let expected_head = String::from_utf8(head.stdout).unwrap().trim().to_owned();

    let report = f.run_raw(&["init", "--provider", "github", "--inspect"]);
    assert_report_matches_schema(&report);
    assert_eq!(report["evidence"]["context"]["branch"], Value::Null);
    for check in report["evidence"]["checks"].as_array().unwrap() {
        assert_eq!(check["scope"]["branch"], Value::Null);
        assert_eq!(check["scope"]["commit"], expected_head);
    }
}

#[test]
fn init_inspection_reports_null_scope_when_repository_context_cannot_be_resolved() {
    let f = Fixture::new();
    let removed = Command::new("git")
        .current_dir(&f.root)
        .args(["remote", "remove", "origin"])
        .output()
        .unwrap();
    assert!(removed.status.success());

    let report = f.run_raw(&["init", "--provider", "github", "--inspect"]);
    assert_report_matches_schema(&report);
    let checks = report["evidence"]["checks"].as_array().unwrap();
    assert_eq!(checks.len(), 10);
    assert_eq!(checks[0]["status"], "unknown");
    assert!(!report["diagnostics"].as_array().unwrap().is_empty());
    for check in checks {
        assert_eq!(
            check["scope"],
            json!({"repository":null,"branch":null,"commit":null})
        );
    }
    assert_eq!(report["evidence"]["written"], false);
    assert!(!f.root.join(".specgit.yaml").exists());
    assert!(!f.root.join(".git/specgit-v2").exists());
    assert_eq!(f.state()["calls"], json!([]));
}

#[test]
fn init_check_scope_schema_requires_all_keys_and_explicitly_allows_unknowns() {
    let schema: Value =
        serde_json::from_str(include_str!("../schemas/report.schema.json")).unwrap();
    let scope = &schema["$defs"]["init_check_scope"];
    let repository = &scope["properties"]["repository"]["oneOf"][1];
    assert_eq!(scope["additionalProperties"], false);
    assert_eq!(scope["required"], json!(["repository", "branch", "commit"]));
    assert_eq!(
        scope["properties"]["commit"]["pattern"],
        "^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$"
    );
    assert_eq!(
        scope["properties"]["repository"]["oneOf"][0]["type"],
        "null"
    );
    assert_eq!(
        scope["properties"]["branch"]["type"],
        json!(["string", "null"])
    );
    assert_eq!(
        scope["properties"]["commit"]["type"],
        json!(["string", "null"])
    );
    assert_eq!(repository["additionalProperties"], false);
    assert_eq!(repository["required"], json!(["provider", "host", "path"]));
    assert_eq!(
        repository["properties"]["provider"]["enum"],
        json!(["github", "gitlab"])
    );
    assert!(
        schema["$defs"]["init_check"]["required"]
            .as_array()
            .unwrap()
            .contains(&json!("scope"))
    );
}

#[test]
fn project_promotion_is_scoped_and_cannot_downgrade_built_in_requirements() {
    let f = Fixture::new();
    fs::write(f.root.join(".specgit.yaml"), b"version: 2\ninit_policy: {required_checks: [target.protection, project.identity, request.eligibility]}\n").unwrap();
    let report = f.run_raw(&["init", "--provider", "github", "--inspect"]);
    let checks = report["evidence"]["checks"].as_array().unwrap();
    let by_id = |id: &str| checks.iter().find(|check| check["id"] == id).unwrap();
    assert_eq!(by_id("target.protection")["requirement"], "required");
    assert_eq!(
        by_id("target.protection")["requirement_source"],
        "project_declaration"
    );
    assert_eq!(by_id("target.protection")["status"], "unknown");
    assert_eq!(by_id("target.protection")["presentation"], "blocking");
    assert_eq!(by_id("project.identity")["requirement"], "required");
    assert_eq!(by_id("project.identity")["requirement_source"], "builtin");
    assert_eq!(by_id("request.eligibility")["requirement"], "required");
    assert_eq!(by_id("request.eligibility")["status"], "not_applicable");
    assert_eq!(by_id("request.eligibility")["presentation"], "hint");
    let operations = report["evidence"]["operation_assessments"]["operations"]
        .as_array()
        .unwrap();
    let operation = |id: &str| {
        operations
            .iter()
            .find(|entry| entry["operation"] == id)
            .unwrap()
    };
    assert_eq!(operation("protected_delivery")["assessment"], "blocked");
    assert_eq!(
        operation("protected_delivery")["blocked_by"],
        json!(["target.protection"])
    );
    assert_eq!(operation("protected_delivery")["warnings"], json!([]));
    assert_eq!(
        operation("local_diagnostics")["assessment"],
        "no_reported_blocker"
    );
    assert_eq!(
        operation("request_merge")["assessment"],
        "no_reported_blocker"
    );
    assert_eq!(
        f.state()["calls"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|call| call["method"] == "POST" || call["method"] == "PUT")
            .count(),
        0
    );
}
#[test]
fn both_forges_init_refresh_reject_settings_writes_and_preserve_user_content() {
    for provider in ["github", "gitlab"] {
        let f = Fixture::new();
        fs::write(f.root.join("AGENTS.md"), b"User instructions\r\n").unwrap();
        fs::write(f.root.join("CLAUDE.md"), b"Host instructions\r\n").unwrap();
        let r = f.run(&[
            "init",
            "--provider",
            provider,
            "--language",
            "zh",
            "--mirror-claude",
        ]);
        assert_eq!(r["exit"], 0, "{r}");
        assert_eq!(r["evidence"]["flow"]["target"], "preview");
        assert_eq!(r["evidence"]["flow"]["targets_native_default"], true);
        assert!(
            fs::read(f.root.join("AGENTS.md"))
                .unwrap()
                .starts_with(b"User instructions\r\n")
        );
        let r = f.run(&["init", "--language", "en", "--native-delete-source", "true"]);
        assert_eq!(r["exit"], 2, "{r}");
        let r = f.run(&["init", "--language", "en"]);
        assert_eq!(r["exit"], 0, "{r}");
        assert!(
            fs::read_to_string(f.root.join("CLAUDE.md"))
                .unwrap()
                .contains(".agents/skills/specgit-native/SKILL.md")
        );
        let state = f.state();
        assert_eq!(state["project"]["unrelated"], "keep");
        assert_eq!(state["project"]["default_branch"], "preview");
        assert_eq!(
            state["calls"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|c| c["method"] != "GET")
                .count(),
            0
        );
        let r = f.run(&["init", "--target", "main", "--inspect"]);
        assert_eq!(r["evidence"]["flow"]["issue_closing"], "unsupported_target");
        assert_eq!(r["evidence"]["written"], false);
        let d = specgit::config::read(&f.root).unwrap().unwrap();
        assert_eq!(d.target, None);
    }
}
#[test]
fn api_failure_and_invalid_declaration_leave_project_files_untouched() {
    let f = Fixture::new();
    let mut state = f.state();
    state["deny"] = json!(true);
    fs::write(&f.state, state.to_string()).unwrap();
    let r = f.run(&["init", "--provider", "github"]);
    assert_report_matches_schema(&r);
    let head = Command::new("git")
        .current_dir(&f.root)
        .args(["rev-parse", "--verify", "HEAD"])
        .output()
        .unwrap();
    assert!(head.status.success());
    let expected_head = String::from_utf8(head.stdout).unwrap().trim().to_owned();
    assert_eq!(r["exit"], 3);
    for check in r["evidence"]["checks"].as_array().unwrap() {
        assert_eq!(
            check["scope"],
            json!({
                "repository":{"provider":"github","host":"forge.example","path":"fixture/repo"},
                "branch":"feature",
                "commit":expected_head,
            })
        );
    }
    let access = r["evidence"]["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|check| check["id"] == "forge.read_access")
        .unwrap();
    assert_eq!(access["status"], "failed");
    assert_eq!(access["presentation"], "blocking");
    assert_eq!(access["diagnostic"]["code"], "permission_denied");
    let issue_inspection = r["evidence"]["operation_assessments"]["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["operation"] == "issue_inspection")
        .unwrap();
    assert_eq!(issue_inspection["assessment"], "blocked");
    assert!(!f.root.join(".specgit.yaml").exists());
    assert!(!f.root.join("AGENTS.md").exists());
    fs::write(
        f.root.join(".specgit.yaml"),
        b"version: 2\nunknown: preserve\n",
    )
    .unwrap();
    let count = f.state()["calls"].as_array().unwrap().len();
    let r = f.run(&["init", "--provider", "github"]);
    assert_eq!(r["exit"], 2);
    assert_eq!(f.state()["calls"].as_array().unwrap().len(), count);
    assert_eq!(
        fs::read(f.root.join(".specgit.yaml")).unwrap(),
        b"version: 2\nunknown: preserve\n"
    );
}

#[test]
fn account_read_diagnostics_are_specific_safe_and_consistent_for_both_forges() {
    let cases = [
        (
            "unauthenticated",
            Some("HTTP 401 authentication failed"),
            None,
            "authentication_failed",
            "unknown",
            "登录所选主机",
        ),
        (
            "permission_denied",
            Some("HTTP 403 private https://sentinel:secret@example.invalid/?token=secret"),
            None,
            "permission_denied",
            "failed",
            "该操作的权限",
        ),
        (
            "rate_limited",
            Some("HTTP 429 rate limit exceeded"),
            None,
            "rate_limited",
            "unknown",
            "限流窗口",
        ),
        (
            "network_failed",
            Some("error connecting to host; tls handshake failed"),
            None,
            "network_failed",
            "unknown",
            "TLS 配置",
        ),
        (
            "ambiguous_not_found",
            Some("HTTP 404 not found"),
            None,
            "ambiguous_not_found",
            "unknown",
            "项目身份和访问权限",
        ),
        (
            "malformed_response",
            None,
            Some("{"),
            "malformed_response",
            "unknown",
            "原生平台响应",
        ),
        (
            "unclassified_failure",
            Some("HTTP 418 unexpected upstream response"),
            None,
            "process_failed",
            "unknown",
            "通过原生 CLI",
        ),
    ];
    for provider in ["github", "gitlab"] {
        for (name, failure, response, code, status, remedy_fragment) in cases {
            let f = Fixture::new();
            let mut state = f.state();
            if let Some(failure) = failure {
                state["account_failure"] = json!(failure);
            }
            if let Some(response) = response {
                state["account_response"] = json!(response);
            }
            fs::write(&f.state, state.to_string()).unwrap();
            let args = [
                "init",
                "--provider",
                provider,
                "--language",
                "zh",
                "--inspect",
            ];
            let report = f.run_raw(&args);
            let access = report["evidence"]["checks"]
                .as_array()
                .unwrap()
                .iter()
                .find(|check| check["id"] == "forge.read_access")
                .unwrap();
            let diagnostic = &access["diagnostic"];
            assert_eq!(diagnostic["code"], code, "{provider} {name}: {report}");
            assert_eq!(diagnostic["operation"], format!("{provider}_api_read"));
            assert_eq!(access["status"], status, "{provider} {name}: {report}");
            assert_eq!(access["presentation"], "blocking");
            assert_eq!(access["reason"], diagnostic["message"]);
            assert_eq!(access["next_step"], diagnostic["remedy"]);
            assert!(
                diagnostic["remedy"]
                    .as_str()
                    .unwrap()
                    .contains(remedy_fragment),
                "{provider} {name}: {diagnostic}"
            );
            assert_eq!(access["status"] == "failed", code == "permission_denied");
            let issue_inspection = report["evidence"]["operation_assessments"]["operations"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["operation"] == "issue_inspection")
                .unwrap();
            assert_eq!(issue_inspection["assessment"], "blocked");
            assert!(
                issue_inspection["blocked_by"]
                    .as_array()
                    .unwrap()
                    .contains(&json!("forge.read_access"))
            );
            let calls = f.state()["calls"].as_array().unwrap().clone();
            assert!(calls.iter().any(|call| call["endpoint"] == "user"));
            assert!(calls.iter().all(|call| call["method"] == "GET"));
            assert_eq!(report["evidence"]["written"], false);
            assert!(!f.root.join(".specgit.yaml").exists());
            assert!(!f.root.join("AGENTS.md").exists());
            assert!(!f.root.join(".git/specgit-v2").exists());
            if code == "permission_denied" {
                let serialized = report.to_string();
                assert!(!serialized.contains("sentinel"));
                assert!(!serialized.contains("secret"));
            }
            let human = f.run_human(&args);
            let human_access = human["checks"]
                .as_array()
                .unwrap()
                .iter()
                .find(|check| check["id"] == "forge.read_access")
                .unwrap();
            for field in [
                "status",
                "presentation",
                "diagnostic",
                "reason",
                "next_step",
            ] {
                assert_eq!(
                    human_access[field], access[field],
                    "{provider} {name} {field}"
                );
            }
        }
    }
}

#[test]
fn actual_request_target_wins_and_ambiguous_requests_are_not_selected() {
    let f = Fixture::new();
    let mut state = f.state();
    let request = json!({"number":9,"head":{"repo":{"id":7},"ref":"feature"},"base":{"repo":{"id":7},"ref":"dev"}});
    state["requests"] = json!([request.clone()]);
    fs::write(&f.state, state.to_string()).unwrap();
    let r = f.run(&[
        "init",
        "--provider",
        "github",
        "--target",
        "preview",
        "--inspect",
    ]);
    assert_eq!(r["exit"], 0, "{r}");
    assert_eq!(r["evidence"]["flow"]["target"], "dev");
    assert_eq!(r["evidence"]["flow"]["issue_closing"], "unsupported_target");
    assert!(
        r["evidence"]["flow"]["warnings"]
            .as_array()
            .unwrap()
            .contains(&json!("configured_request_target_mismatch"))
    );
    state["requests"] = json!([request.clone(), request]);
    fs::write(&f.state, state.to_string()).unwrap();
    let r = f.run(&["init", "--provider", "github"]);
    assert_eq!(r["exit"], 3);
    assert_eq!(r["diagnostics"][0]["code"], "ambiguous_request");
    assert!(!f.root.join(".specgit.yaml").exists());
}
#[test]
fn private_endpoint_stays_local_and_rollback_needs_no_native_api() {
    let f = Fixture::new();
    assert!(
        Command::new("git")
            .current_dir(&f.root)
            .args([
                "remote",
                "set-url",
                "origin",
                "ssh://git@ssh.example:2222/fixture/repo.git"
            ])
            .output()
            .unwrap()
            .status
            .success()
    );
    let r = f.run(&[
        "init",
        "--provider",
        "github",
        "--api-host",
        "api.example:8443",
    ]);
    assert_eq!(r["exit"], 0, "{r}");
    let declaration = fs::read(f.root.join(".specgit.yaml")).unwrap();
    assert!(!String::from_utf8_lossy(&declaration).contains("api.example"));
    let status = f.run(&["status"]);
    assert_eq!(
        status["evidence"]["context"]["repository"]["host"],
        "api.example:8443"
    );
    let transaction = r["evidence"]["transaction"]["transaction"]
        .as_str()
        .unwrap();
    let calls = f.state()["calls"].as_array().unwrap().len();
    let rollback = f.run(&["init", "--rollback", transaction]);
    assert_eq!(rollback["exit"], 0, "{rollback}");
    assert!(!f.root.join(".specgit.yaml").exists());
    assert!(!f.root.join("AGENTS.md").exists());
    assert!(!f.root.join(".git/specgit-v2/local-routing.json").exists());
    assert_eq!(f.state()["calls"].as_array().unwrap().len(), calls);
}
#[test]
fn selected_language_translates_diagnostics_without_changing_codes() {
    let f = Fixture::new();
    let mut state = f.state();
    state["deny"] = json!(true);
    fs::write(&f.state, state.to_string()).unwrap();
    let r = f.run(&["init", "--provider", "github", "--language", "zh"]);
    assert_eq!(r["diagnostics"][0]["code"], "permission_denied");
    assert!(
        r["diagnostics"][0]["message"]
            .as_str()
            .unwrap()
            .contains("权限")
    );
}

#[test]
fn manual_declaration_edits_refresh_owned_blocks_and_rollback_receipt_together() {
    let f = Fixture::new();
    let first = f.run(&["init", "--provider", "github", "--mirror-claude"]);
    assert_eq!(first["exit"], 0, "{first}");
    let receipt_path = f.root.join(".git/specgit-v2/guidance.json");
    let before_receipt = fs::read(&receipt_path).unwrap();
    let before_agents = fs::read(f.root.join("AGENTS.md")).unwrap();
    let declaration = f.root.join(".specgit.yaml");
    let text = fs::read_to_string(&declaration)
        .unwrap()
        .replace("language: en", "language: zh");
    fs::write(&declaration, text).unwrap();
    let result = f.run(&["init"]);
    assert_eq!(result["exit"], 0, "{result}");
    for name in ["AGENTS.md", "CLAUDE.md"] {
        assert!(
            fs::read_to_string(f.root.join(name))
                .unwrap()
                .contains(".agents/skills/specgit-native/SKILL.md")
        );
    }
    assert_eq!(result["evidence"]["transaction"]["changes"], 0);
    assert_eq!(fs::read(&receipt_path).unwrap(), before_receipt);
    assert_eq!(fs::read(f.root.join("AGENTS.md")).unwrap(), before_agents);
    assert_eq!(f.run(&["init"])["exit"], 0);
    let agents = f.root.join("AGENTS.md");
    let edited = fs::read_to_string(&agents)
        .unwrap()
        .replace("specgit init", "用户编辑");
    fs::write(&agents, &edited).unwrap();
    assert_eq!(f.run(&["init"])["exit"], 0);
    let refreshed = fs::read_to_string(agents).unwrap();
    assert!(refreshed.contains(".agents/skills/specgit-native/SKILL.md"));
    assert!(!refreshed.contains("用户编辑"));
}

#[test]
fn cli_init_refreshes_edited_recorded_block_using_real_asset_journal() {
    let f = Fixture::new();
    let agents = f.root.join("AGENTS.md");
    fs::write(&agents, "manual prefix\n").unwrap();
    let first = f.run(&["init", "--provider", "github"]);
    assert_eq!(first["exit"], 0, "{first}");
    let receipt = f.root.join(".git/specgit-v2/agent-assets/ownership.json");
    let declaration = fs::read(f.root.join(".specgit.yaml")).unwrap();
    let original = fs::read_to_string(&agents).unwrap();
    let edited = original.replace("SpecGit 2", "edited managed block");
    fs::write(&agents, &edited).unwrap();
    let before_receipt = fs::read(&receipt).unwrap();
    let preview = f.run(&["init", "--dry-run"]);
    assert_eq!(preview["exit"], 0, "{preview}");
    assert_eq!(fs::read_to_string(&agents).unwrap(), edited);
    assert_eq!(fs::read(&receipt).unwrap(), before_receipt);
    let applied = f.run(&["init"]);
    assert_eq!(applied["exit"], 0, "{applied}");
    let current = fs::read_to_string(&agents).unwrap();
    assert!(current.starts_with("manual prefix\n"));
    assert!(current.contains("## SpecGit 2"));
    assert!(!current.contains("edited managed block"));
    assert_eq!(fs::read(f.root.join(".specgit.yaml")).unwrap(), declaration);
    assert_eq!(f.run(&["status"])["exit"], 0);
    assert_eq!(f.run_raw(&["doctor", "--provider", "github"])["exit"], 0);
    let second = f.run(&["init", "--dry-run"]);
    assert_eq!(second["exit"], 0, "{second}");
    assert_eq!(f.run(&["init"])["evidence"]["transaction"]["changes"], 0);
}

#[test]
fn branch_switch_recognizes_pristine_guidance_from_the_checked_out_declaration() {
    let f = Fixture::new();
    assert_eq!(
        f.run(&["init", "--provider", "github", "--language", "zh"])["exit"],
        0
    );
    let git = |args: &[&str]| {
        assert!(
            Command::new("git")
                .current_dir(&f.root)
                .args(args)
                .output()
                .unwrap()
                .status
                .success()
        )
    };
    git(&["config", "core.autocrlf", "true"]);
    git(&["add", "-f", ".specgit.yaml", "AGENTS.md"]);
    git(&["commit", "-m", "Chinese branch"]);
    git(&["checkout", "-b", "english"]);
    assert_eq!(f.run(&["init", "--language", "en"])["exit"], 0);
    git(&["add", "-f", ".specgit.yaml", "AGENTS.md"]);
    git(&["commit", "-m", "English branch"]);
    git(&["checkout", "feature"]);
    assert_eq!(f.run(&["init"])["exit"], 0);
    assert!(
        fs::read_to_string(f.root.join("AGENTS.md"))
            .unwrap()
            .contains(".agents/skills/specgit-native/SKILL.md")
    );
}

#[test]
fn receiptless_worktree_refreshes_unmodified_earlier_release_guidance_only() {
    let f = Fixture::new();
    assert_eq!(f.run(&["init", "--provider", "github"])["exit"], 0);
    let receipt = f.root.join(".git/specgit-v2/guidance.json");
    fs::remove_file(f.root.join(".git/specgit-v2/agent-assets/ownership.json")).unwrap();
    fs::remove_file(f.root.join(".agents/skills/specgit-native/SKILL.md")).unwrap();
    let agents = f.root.join("AGENTS.md");
    let old = include_str!("fixtures/guidance-2.4.0-en.txt");
    // A fresh clone or linked worktree has the committed block but no receipt.
    fs::write(&agents, format!("User rules\n\n{old}\n")).unwrap();
    fs::remove_file(&receipt).unwrap();
    let r = f.run(&["init"]);
    assert_eq!(r["exit"], 0, "{r}");
    let text = fs::read_to_string(&agents).unwrap();
    assert!(text.starts_with("User rules\n\n"));
    assert!(!text.contains("Runtime:"));
    assert!(text.contains("<!-- specgit:project:v2:start -->"));
    let edited = format!("User rules\n\n{}\n", old.replacen("SpecGit", "Spec Git", 2));
    fs::write(&agents, &edited).unwrap();
    fs::remove_file(&receipt).unwrap();
    fs::remove_file(f.root.join(".git/specgit-v2/agent-assets/ownership.json")).unwrap();
    fs::remove_file(f.root.join(".agents/skills/specgit-native/SKILL.md")).unwrap();
    let r = f.run(&["init"]);
    assert_eq!(r["exit"], 3, "{r}");
    assert_eq!(r["diagnostics"][0]["code"], "ownership_conflict", "{r}");
    assert_eq!(fs::read_to_string(&agents).unwrap(), edited);
}

#[test]
fn missing_declaration_uses_the_supplied_config_file_as_previous_declaration() {
    let f = Fixture::new();
    let r = f.run(&["init", "--provider", "github", "--language", "zh"]);
    assert_eq!(r["exit"], 0, "{r}");
    let config = f.root.parent().unwrap().join("original.yaml");
    fs::rename(f.root.join(".specgit.yaml"), &config).unwrap();
    fs::remove_file(f.root.join(".git/specgit-v2/guidance.json")).unwrap();
    fs::remove_file(f.root.join(".git/specgit-v2/agent-assets/ownership.json")).unwrap();
    fs::remove_file(f.root.join(".agents/skills/specgit-native/SKILL.md")).unwrap();
    let agents = f.root.join("AGENTS.md");
    let old = include_str!("fixtures/guidance-2.5.0-zh.txt");
    fs::write(&agents, format!("{old}\n")).unwrap();
    let r = f.run(&["init", "--config-file", config.to_str().unwrap()]);
    assert_eq!(r["exit"], 0, "{r}");
    let text = fs::read_to_string(&agents).unwrap();
    assert!(text.contains("<!-- specgit:project:v2:start -->"));
    assert!(text.contains(".agents/skills/specgit-native/SKILL.md"));
    assert_eq!(
        fs::read(f.root.join(".specgit.yaml")).unwrap(),
        fs::read(&config).unwrap()
    );
}

#[test]
fn unknown_capabilities_require_choice_and_inspection_has_no_local_writes() {
    for provider in ["github", "gitlab"] {
        let f = Fixture::new();
        for mode in ["--check", "--dry-run"] {
            let result = f.run_raw(&["init", "--provider", provider, mode]);
            assert_eq!(result["status"], "confirmation_required", "{result}");
            assert_eq!(result["diagnostics"][0]["code"], "confirmation_required");
            assert_eq!(
                result["evidence"]["capabilities"]["auto_merge"]["status"],
                "unknown"
            );
            assert_eq!(result["evidence"]["written"], false);
            assert!(!f.root.join(".specgit.yaml").exists());
            assert!(!f.root.join(".git/specgit-v2").exists());
            let preview = f.run_raw(&["init", "--provider", provider, mode, "--manual-observe"]);
            assert_eq!(preview["exit"], 0, "{preview}");
            assert!(!f.root.join(".git/specgit-v2").exists());
        }
        assert_eq!(
            f.run_raw(&["init", "--provider", provider, "--manual-observe"])["exit"],
            0
        );
        assert_eq!(
            f.run_raw(&["init"])["exit"],
            0,
            "persisted manual choice refreshes"
        );
        assert!(
            f.state()["calls"]
                .as_array()
                .unwrap()
                .iter()
                .all(|call| call["method"] == "GET")
        );
    }
}
#[test]
fn github_effective_rulesets_prove_readable_target_protection_without_classic_api() {
    let f = Fixture::new();
    let mut state = f.state();
    state["read_routes"] = json!({
        "user": {"id":1,"login":"fixture"},
        "repos/fixture/repo": state["project"].clone(),
        "repos/fixture/repo/pulls?state=open&head=fixture%3Afeature&per_page=100&page=1": [],
        "repos/fixture/repo/rules/branches/preview?per_page=100&page=1": [{
            "type": "required_status_checks",
            "ruleset_id": 44,
            "ruleset_source": "fixture/repo",
            "ruleset_source_type": "Repository",
            "parameters": {"required_status_checks":[{"context":"SpecGit Acceptance"}]}
        }]
    });
    fs::write(&f.state, state.to_string()).unwrap();
    let report = f.run_raw(&["init", "--provider", "github", "--inspect"]);
    let protection = &report["evidence"]["capabilities"]["target_protection"];
    assert_eq!(protection["status"], "supported", "{report}");
    assert_eq!(
        report["evidence"]["inspection"]["complete"], true,
        "{report}"
    );
    assert!(
        protection["source"]
            .as_str()
            .unwrap()
            .contains("/rules/branches/preview")
    );
    let calls = f.state()["calls"].as_array().unwrap().clone();
    assert!(calls.iter().all(|call| call["method"] == "GET"));
    assert!(
        calls
            .iter()
            .all(|call| !call["endpoint"].as_str().unwrap().ends_with("/protection"))
    );
    assert!(!f.root.join(".specgit.yaml").exists());
}
#[test]
fn github_rulesets_empty_falls_back_to_classic_and_errors_stay_unknown() {
    for (rules, classic, expected, diagnostic, complete) in [
        (
            json!([]),
            json!({"required_status_checks":null,"enforce_admins":{"enabled":true}}),
            "supported",
            None,
            true,
        ),
        (
            json!([]),
            json!({"__fixture_error":"HTTP 404"}),
            "unknown",
            Some("ambiguous_not_found"),
            false,
        ),
        (
            json!({"__fixture_error":"HTTP 403"}),
            json!({"required_status_checks":null,"enforce_admins":{}}),
            "unknown",
            Some("permission_denied"),
            false,
        ),
        (
            json!({"__fixture_error":"HTTP 404"}),
            json!({"required_status_checks":null,"enforce_admins":{}}),
            "unknown",
            Some("ambiguous_not_found"),
            false,
        ),
        (
            json!({"__fixture_error":"network connection failed"}),
            json!({"required_status_checks":null,"enforce_admins":{}}),
            "unknown",
            Some("network_failed"),
            false,
        ),
        (
            json!({"unexpected":"shape"}),
            json!({"required_status_checks":null,"enforce_admins":{}}),
            "unknown",
            Some("malformed_response"),
            false,
        ),
        (
            json!([{"ruleset_id":44}]),
            json!({"required_status_checks":null,"enforce_admins":{}}),
            "unknown",
            Some("malformed_response"),
            false,
        ),
        (
            json!([{"type":"required_status_checks","ruleset_id":"44"}]),
            json!({"required_status_checks":null,"enforce_admins":{}}),
            "unknown",
            Some("malformed_response"),
            false,
        ),
        (
            json!([{"type":"required_status_checks","parameters":null}]),
            json!({"required_status_checks":null,"enforce_admins":{}}),
            "unknown",
            Some("malformed_response"),
            false,
        ),
    ] {
        let f = Fixture::new();
        let mut state = f.state();
        let fallback = rules.as_array().is_some_and(Vec::is_empty);
        state["read_routes"] = json!({
            "user": {"id":1,"login":"fixture"},
            "repos/fixture/repo": state["project"].clone(),
            "repos/fixture/repo/pulls?state=open&head=fixture%3Afeature&per_page=100&page=1": [],
            "repos/fixture/repo/rules/branches/preview?per_page=100&page=1": rules,
            "repos/fixture/repo/branches/preview/protection": classic,
        });
        fs::write(&f.state, state.to_string()).unwrap();
        let report = f.run_raw(&["init", "--provider", "github", "--inspect"]);
        let protection = &report["evidence"]["capabilities"]["target_protection"];
        assert_eq!(protection["status"], expected, "{report}");
        assert_eq!(
            protection["diagnostic"]["code"].as_str(),
            diagnostic,
            "{report}"
        );
        assert_eq!(
            report["evidence"]["inspection"]["complete"], complete,
            "{report}"
        );
        let calls = f.state()["calls"].as_array().unwrap().clone();
        let classic_called = calls
            .iter()
            .any(|call| call["endpoint"] == "repos/fixture/repo/branches/preview/protection");
        assert_eq!(classic_called, fallback, "{report}");
        assert!(calls.iter().all(|call| call["method"] == "GET"));
    }
}
#[test]
fn github_effective_rules_without_optional_ruleset_metadata_are_readable() {
    let f = Fixture::new();
    let mut state = f.state();
    state["read_routes"] = json!({
        "user": {"id":1,"login":"fixture"},
        "repos/fixture/repo": state["project"].clone(),
        "repos/fixture/repo/pulls?state=open&head=fixture%3Afeature&per_page=100&page=1": [],
        "repos/fixture/repo/rules/branches/preview?per_page=100&page=1": [{"type":"required_status_checks"}],
        "repos/fixture/repo/branches/preview/protection": {"required_status_checks":null,"enforce_admins":{"enabled":true}}
    });
    fs::write(&f.state, state.to_string()).unwrap();
    let report = f.run_raw(&["init", "--provider", "github", "--inspect"]);
    assert_eq!(
        report["evidence"]["capabilities"]["target_protection"]["status"], "supported",
        "{report}"
    );
    assert_eq!(
        report["evidence"]["inspection"]["complete"], true,
        "{report}"
    );
    assert!(
        f.state()["calls"]
            .as_array()
            .unwrap()
            .iter()
            .all(|call| !call["endpoint"].as_str().unwrap().ends_with("/protection"))
    );
}
#[test]
fn github_rulesets_pagination_and_encoded_target_are_bounded() {
    let rule = json!({"type":"future_rule","ruleset_id":44,"ruleset_source":"fixture","ruleset_source_type":"Organization"});
    let f = Fixture::new();
    let mut state = f.state();
    state["project"]["default_branch"] = json!("release/x");
    state["read_routes"] = json!({
        "user": {"id":1,"login":"fixture"},
        "repos/fixture/repo": state["project"].clone(),
        "repos/fixture/repo/pulls?state=open&head=fixture%3Afeature&per_page=100&page=1": [],
        "repos/fixture/repo/rules/branches/release%2Fx?per_page=100&page=1": vec![rule.clone();100],
        "repos/fixture/repo/rules/branches/release%2Fx?per_page=100&page=2": [rule],
        "repos/fixture/repo/branches/release%2Fx/protection": {"__fixture_error":"HTTP 404"}
    });
    fs::write(&f.state, state.to_string()).unwrap();
    let report = f.run_raw(&["init", "--provider", "github", "--inspect"]);
    assert_eq!(
        report["evidence"]["capabilities"]["target_protection"]["status"], "supported",
        "{report}"
    );
    assert_eq!(
        report["evidence"]["inspection"]["complete"], true,
        "{report}"
    );
    let calls = f.state()["calls"].as_array().unwrap().clone();
    assert!(calls.iter().any(|call| call["endpoint"]
        == "repos/fixture/repo/rules/branches/release%2Fx?per_page=100&page=2"));
    assert!(
        calls
            .iter()
            .all(|call| !call["endpoint"].as_str().unwrap().ends_with("/protection"))
    );
}
#[test]
fn github_rulesets_page_cap_does_not_promote_partial_evidence() {
    let f = Fixture::new();
    let mut state = f.state();
    let rule = json!({"type":"required_status_checks","ruleset_id":44,"ruleset_source":"fixture/repo","ruleset_source_type":"Repository"});
    let mut routes = serde_json::Map::new();
    routes.insert("user".into(), json!({"id":1,"login":"fixture"}));
    routes.insert("repos/fixture/repo".into(), state["project"].clone());
    routes.insert(
        "repos/fixture/repo/pulls?state=open&head=fixture%3Afeature&per_page=100&page=1".into(),
        json!([]),
    );
    for page in 1..=10 {
        routes.insert(
            format!("repos/fixture/repo/rules/branches/preview?per_page=100&page={page}"),
            json!(vec![rule.clone(); 100]),
        );
    }
    routes.insert(
        "repos/fixture/repo/branches/preview/protection".into(),
        json!({"required_status_checks":null,"enforce_admins":{}}),
    );
    state["read_routes"] = Value::Object(routes);
    fs::write(&f.state, state.to_string()).unwrap();
    let report = f.run_raw(&["init", "--provider", "github", "--inspect"]);
    assert_eq!(
        report["evidence"]["capabilities"]["target_protection"]["status"], "unknown",
        "{report}"
    );
    assert_eq!(
        report["evidence"]["inspection"]["complete"], false,
        "{report}"
    );
    assert!(report["evidence"]["capabilities"]["target_protection"]["diagnostic"].is_object());
    let calls = f.state()["calls"].as_array().unwrap().clone();
    assert!(
        calls
            .iter()
            .all(|call| !call["endpoint"].as_str().unwrap().ends_with("/protection"))
    );
    assert_eq!(
        calls
            .iter()
            .filter(|call| call["endpoint"]
                .as_str()
                .unwrap()
                .contains("/rules/branches/"))
            .count(),
        10
    );
}
#[test]
fn project_auto_merge_setting_is_a_fact_and_not_request_authority() {
    for (enabled, expected) in [(true, "supported"), (false, "unsupported")] {
        let f = Fixture::new();
        let mut state = f.state();
        state["project"]["allow_auto_merge"] = json!(enabled);
        fs::write(&f.state, state.to_string()).unwrap();
        let report = f.run_raw(&[
            "init",
            "--provider",
            "github",
            "--check",
            "--native-auto-merge",
            "true",
        ]);
        assert_eq!(
            report["evidence"]["capabilities"]["auto_merge"]["status"], expected,
            "{report}"
        );
        let auto_merge = report["evidence"]["checks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|check| check["id"] == "auto_merge.setting")
            .unwrap();
        assert_eq!(
            auto_merge["status"],
            if enabled {
                "verified"
            } else {
                "not_configured"
            }
        );
        assert_eq!(
            auto_merge["presentation"],
            if enabled { "pass" } else { "hint" }
        );
        assert_eq!(
            report["evidence"]["capabilities"]["request_eligibility"]["status"],
            "unknown"
        );
        assert_eq!(report["status"], "confirmation_required");
        assert!(!f.root.join(".specgit.yaml").exists());
    }
}
#[test]
fn persisted_language_drives_diagnostics_without_reading_report_json() {
    let f = Fixture::new();
    assert_eq!(
        f.run(&["init", "--provider", "github", "--language", "zh"])["exit"],
        0
    );
    let mut state = f.state();
    state["deny"] = json!(true);
    fs::write(&f.state, state.to_string()).unwrap();
    let report = f.run_raw(&["init", "--check"]);
    assert!(
        report["diagnostics"][0]["message"]
            .as_str()
            .unwrap()
            .contains("权限")
    );
}

#[test]
fn supported_native_settings_allow_explicit_preference_and_refresh_detects_drift() {
    let f = Fixture::new();
    let mut state = f.state();
    state["project"]["allow_auto_merge"] = json!(true);
    state["read_routes"] = json!({
        "user":{"id":1,"login":"fixture"},
        "repos/fixture/repo":state["project"],
        "repos/fixture/repo/pulls?state=open&head=fixture%3Afeature&per_page=100&page=1":[],
        "repos/fixture/repo/rules/branches/preview?per_page=100&page=1":[],
        "repos/fixture/repo/branches/preview/protection":{
            "required_status_checks":null,"enforce_admins":{"enabled":true}
        }
    });
    fs::write(&f.state, state.to_string()).unwrap();
    let result = f.run_raw(&[
        "init",
        "--provider",
        "github",
        "--native-auto-merge",
        "true",
    ]);
    assert_eq!(result["exit"], 0, "{result}");
    assert!(
        specgit::config::read(&f.root)
            .unwrap()
            .unwrap()
            .agent
            .native_auto_merge
    );
    let original = fs::read(f.root.join(".specgit.yaml")).unwrap();
    let mut state = f.state();
    state["read_routes"]["repos/fixture/repo"]["allow_auto_merge"] = json!(false);
    fs::write(&f.state, state.to_string()).unwrap();
    let result = f.run_raw(&["init", "--check"]);
    assert_eq!(result["status"], "confirmation_required", "{result}");
    assert_eq!(fs::read(f.root.join(".specgit.yaml")).unwrap(), original);
    assert!(
        f.state()["calls"]
            .as_array()
            .unwrap()
            .iter()
            .all(|call| call["method"] == "GET")
    );
}

#[test]
fn local_exclusions_are_idempotent_and_preserve_user_rules() {
    let f = Fixture::new();
    let exclude = f.root.join(".git/info/exclude");
    let original = b"# My rules\r\n/local-cache\r\n";
    fs::create_dir_all(exclude.parent().unwrap()).unwrap();
    fs::write(&exclude, original).unwrap();
    let preview = f.run(&[
        "init",
        "--provider",
        "github",
        "--mirror-claude",
        "--dry-run",
    ]);
    assert_eq!(preview["exit"], 0, "{preview}");
    assert_eq!(fs::read(&exclude).unwrap(), original);
    let first = f.run(&["init", "--provider", "github", "--mirror-claude"]);
    assert_eq!(first["exit"], 0, "{first}");
    let bytes = fs::read(&exclude).unwrap();
    assert!(bytes.starts_with(original));
    assert!(
        Command::new("git")
            .current_dir(&f.root)
            .args(["check-ignore", ".specgit.yaml"])
            .output()
            .unwrap()
            .status
            .success()
    );
    for name in ["AGENTS.md", "CLAUDE.md"] {
        assert!(
            !Command::new("git")
                .current_dir(&f.root)
                .args(["check-ignore", name])
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    let again = f.run(&["init"]);
    assert_eq!(again["exit"], 0, "{again}");
    assert_eq!(fs::read(&exclude).unwrap(), bytes);
    let agents = fs::read_to_string(f.root.join("AGENTS.md")).unwrap();
    assert_eq!(
        agents.matches("<!-- specgit:project:v2:start -->").count(),
        1
    );
    assert_eq!(
        String::from_utf8(bytes)
            .unwrap()
            .matches("# specgit:local:v2:start")
            .count(),
        1
    );
}

#[test]
fn local_exclusion_reports_tracked_config_and_preserves_mixed_guidance() {
    let f = Fixture::new();
    fs::write(f.root.join("AGENTS.md"), "User rules\n").unwrap();
    let first = f.run(&["init", "--provider", "github"]);
    assert_eq!(first["exit"], 0, "{first}");
    assert!(
        Command::new("git")
            .current_dir(&f.root)
            .args(["add", "-f", ".specgit.yaml"])
            .output()
            .unwrap()
            .status
            .success()
    );
    let again = f.run(&["init"]);
    assert_eq!(
        again["evidence"]["local_exclusion"]["already_tracked"],
        json!([".specgit.yaml"])
    );
    assert_eq!(
        again["evidence"]["local_exclusion"]["mixed_guidance_paths"],
        json!(["AGENTS.md"])
    );
    assert!(
        !Command::new("git")
            .current_dir(&f.root)
            .args(["check-ignore", "AGENTS.md"])
            .output()
            .unwrap()
            .status
            .success()
    );
    assert!(
        Command::new("git")
            .current_dir(&f.root)
            .args(["ls-files", "--error-unmatch", ".specgit.yaml"])
            .output()
            .unwrap()
            .status
            .success()
    );
}

#[test]
fn linked_worktree_uses_common_git_exclude() {
    let mut f = Fixture::new();
    let common = f.root.join(".git/info/exclude");
    fs::create_dir_all(common.parent().unwrap()).unwrap();
    fs::write(&common, b"# original\n").unwrap();
    let original = fs::read(&common).unwrap();
    let worktree = f.root.parent().unwrap().join("linked");
    assert!(
        Command::new("git")
            .current_dir(&f.root)
            // Rust's canonical Windows path has a verbatim prefix that Git
            // cannot use as a worktree argument. Resolve the sibling from cwd.
            .args(["worktree", "add", "-b", "linked", "../linked"])
            .output()
            .unwrap()
            .status
            .success()
    );
    f.root = worktree;
    let init = f.run(&["init", "--provider", "github"]);
    assert_eq!(init["exit"], 0, "{init}");
    assert_eq!(
        PathBuf::from(
            init["evidence"]["local_exclusion"]["path"]
                .as_str()
                .unwrap()
        )
        .canonicalize()
        .unwrap(),
        common.canonicalize().unwrap()
    );
    assert!(
        Command::new("git")
            .current_dir(&f.root)
            .args(["check-ignore", ".specgit.yaml"])
            .output()
            .unwrap()
            .status
            .success()
    );
    let transaction = init["evidence"]["transaction"]["transaction"]
        .as_str()
        .unwrap();
    let rollback = f.run(&["init", "--rollback", transaction]);
    assert_eq!(rollback["exit"], 0, "{rollback}");
    assert_eq!(fs::read(common).unwrap(), original);
}

fn git_ok(root: &std::path::Path, args: &[&str]) -> bool {
    Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap()
        .status
        .success()
}

#[test]
fn init_check_reports_exclusion_state_and_lost_declarations_without_writing() {
    let f = Fixture::new();
    let fresh = f.run(&["init", "--provider", "github", "--check"]);
    assert_eq!(fresh["exit"], 0, "{fresh}");
    assert_report_matches_schema(&fresh);
    assert_eq!(fresh["evidence"]["initial_adoption"], true);
    assert_eq!(
        fresh["evidence"]["local_exclusion"]["block_state"],
        "absent"
    );
    assert_eq!(
        fresh["evidence"]["local_exclusion"]["already_tracked"],
        json!([])
    );
    assert!(!f.root.join(".git/specgit-v2").exists());

    fs::write(f.root.join("AGENTS.md"), "User rules\n").unwrap();
    let first = f.run(&["init", "--provider", "github"]);
    assert_eq!(first["exit"], 0, "{first}");
    assert!(git_ok(&f.root, &["add", "-f", ".specgit.yaml"]));
    let tracked = f.run(&["init", "--check"]);
    assert_eq!(tracked["exit"], 0, "{tracked}");
    let exclusion = &tracked["evidence"]["local_exclusion"];
    assert_eq!(exclusion["already_tracked"], json!([".specgit.yaml"]));
    assert_eq!(exclusion["mixed_guidance_paths"], json!(["AGENTS.md"]));
    assert_eq!(exclusion["block_state"], "current");
    assert_eq!(exclusion["index_changed"], false);
    assert!(
        exclusion["tracked_remedy"]
            .as_str()
            .unwrap()
            .contains("every other clone or worktree")
    );
    assert_eq!(tracked["evidence"]["initial_adoption"], false);

    // A damaged block is reported, not repaired, by the read-only check.
    assert!(git_ok(&f.root, &["rm", "--cached", "-q", ".specgit.yaml"]));
    let exclude = f.root.join(".git/info/exclude");
    let intact = fs::read_to_string(&exclude).unwrap();
    let damaged = format!("{intact}# specgit:local:v2:start\n");
    fs::write(&exclude, &damaged).unwrap();
    let report = f.run(&["init", "--check"]);
    assert_eq!(report["exit"], 0, "{report}");
    assert_eq!(
        report["evidence"]["local_exclusion"]["block_state"],
        "damaged"
    );
    assert_eq!(
        report["evidence"]["local_exclusion"]["diagnostic"]["code"],
        "ownership_conflict"
    );
    assert_eq!(fs::read_to_string(&exclude).unwrap(), damaged);
    fs::write(&exclude, &intact).unwrap();

    // The declaration disappears (for example after a pulled untrack commit) while
    // the worktree's private receipts remain: this is not an initial adoption.
    let private = fs::read_dir(f.root.join(".git/specgit-v2"))
        .unwrap()
        .count();
    fs::remove_file(f.root.join(".specgit.yaml")).unwrap();
    let lost = f.run(&["init", "--provider", "github", "--check"]);
    assert_eq!(lost["exit"], 0, "{lost}");
    assert_eq!(lost["evidence"]["initial_adoption"], false);
    assert_eq!(
        lost["evidence"]["private_state"]["initialized"],
        json!(["guidance.json"])
    );
    assert!(!f.root.join(".specgit.yaml").exists());
    assert_eq!(
        fs::read_dir(f.root.join(".git/specgit-v2"))
            .unwrap()
            .count(),
        private
    );
}

fn linked(f: &Fixture) -> PathBuf {
    // Resolve the sibling from cwd; Windows verbatim paths are not Git arguments.
    assert!(git_ok(
        &f.root,
        &["worktree", "add", "-b", "linked", "../linked"]
    ));
    f.root
        .parent()
        .unwrap()
        .join("linked")
        .canonicalize()
        .unwrap()
}

#[test]
fn rollback_keeps_the_shared_exclusion_block_while_a_sibling_is_initialized() {
    for sibling_initialized in [true, false] {
        let mut f = Fixture::new();
        let main = f.root.clone();
        let exclude = main.join(".git/info/exclude");
        fs::create_dir_all(exclude.parent().unwrap()).unwrap();
        fs::write(&exclude, b"# original\n").unwrap();
        let sibling = linked(&f);
        let first = f.run(&["init", "--provider", "github"]);
        assert_eq!(first["exit"], 0, "{first}");
        let transaction = first["evidence"]["transaction"]["transaction"]
            .as_str()
            .unwrap()
            .to_owned();
        if sibling_initialized {
            f.root = sibling.clone();
            let second = f.run(&["init", "--provider", "github"]);
            assert_eq!(second["exit"], 0, "{second}");
            f.root = main.clone();
        }
        let rollback = f.run(&["init", "--rollback", &transaction]);
        assert_eq!(rollback["exit"], 0, "{rollback}");
        assert!(!main.join(".specgit.yaml").exists());
        let retained = rollback["evidence"]["retained"].as_array().unwrap();
        if sibling_initialized {
            assert_eq!(retained.len(), 1, "{rollback}");
            assert_eq!(retained[0]["reason"], "shared_initialized_worktree");
            assert_eq!(
                PathBuf::from(retained[0]["shared_consumers"][0]["root"].as_str().unwrap())
                    .canonicalize()
                    .unwrap(),
                sibling
            );
            assert!(
                fs::read_to_string(&exclude)
                    .unwrap()
                    .contains("/.specgit.yaml")
            );
            assert!(git_ok(&sibling, &["check-ignore", "-q", ".specgit.yaml"]));
        } else {
            assert!(retained.is_empty(), "{rollback}");
            assert_eq!(fs::read(&exclude).unwrap(), b"# original\n");
        }
    }
}

#[test]
fn rollback_counts_a_sibling_with_private_state_but_no_declaration() {
    let mut f = Fixture::new();
    let main = f.root.clone();
    let sibling = linked(&f);
    let first = f.run(&["init", "--provider", "github"]);
    assert_eq!(first["exit"], 0, "{first}");
    let transaction = first["evidence"]["transaction"]["transaction"]
        .as_str()
        .unwrap()
        .to_owned();
    f.root = sibling.clone();
    assert_eq!(f.run(&["init", "--provider", "github"])["exit"], 0);
    fs::remove_file(sibling.join(".specgit.yaml")).unwrap();
    f.root = main;
    let rollback = f.run(&["init", "--rollback", &transaction]);
    assert_eq!(rollback["exit"], 0, "{rollback}");
    let consumer = &rollback["evidence"]["retained"][0]["shared_consumers"][0];
    assert_eq!(consumer["declaration_sha256"], Value::Null, "{rollback}");
    assert_eq!(
        consumer["private_state"],
        json!(["guidance.json", "agent-assets/ownership.json"])
    );
    assert!(git_ok(&sibling, &["check-ignore", "-q", ".specgit.yaml"]));
}

#[test]
fn doctor_reports_uninitialized_local_context_without_writing() {
    let f = Fixture::new();
    let before = fs::read(f.root.join(".git/config")).unwrap();
    let report = f.run_raw(&["doctor", "--provider", "github"]);
    assert_eq!(report["exit"], 0, "{report}");
    assert_eq!(
        report["evidence"]["local"]["status"], "uninitialized",
        "{report}"
    );
    assert_eq!(
        report["evidence"]["local"]["checkpoint"]["status"],
        "absent"
    );
    assert_eq!(report["evidence"]["local"]["remote_state"], "not_checked");
    assert!(!f.root.join(".specgit.yaml").exists());
    assert!(!f.root.join(".git/specgit-v2/selection.json").exists());
    assert_eq!(fs::read(f.root.join(".git/config")).unwrap(), before);
}

#[test]
fn doctor_account_only_skips_malformed_local_configuration_and_checkpoint() {
    let f = Fixture::new();
    fs::write(f.root.join(".specgit.yaml"), "version: [broken").unwrap();
    let private = f.root.join(".git/specgit-v2");
    fs::create_dir_all(&private).unwrap();
    fs::write(private.join("selection.json"), "{broken checkpoint").unwrap();
    let mut state = f.state();
    state["record_transport"] = json!(true);
    fs::write(&f.state, state.to_string()).unwrap();
    let before = project_files(&f.root);
    let report = f.run_raw(&[
        "doctor",
        "--provider",
        "github",
        "--account-only",
        "--api-host",
        "forge.example",
    ]);
    assert_eq!(report["exit"], 0, "{report}");
    assert_eq!(
        report["evidence"]["local"],
        json!({
            "status": "not_checked", "context": null, "target": null,
            "checkpoint": {"status": "not_checked"}, "remote_state": "not_checked"
        })
    );
    assert_eq!(
        fs::read_to_string(f.root.join(".specgit.yaml")).unwrap(),
        "version: [broken"
    );
    assert_eq!(
        fs::read_to_string(private.join("selection.json")).unwrap(),
        "{broken checkpoint"
    );
    let state = f.state();
    let calls = doctor_platform_calls(state["calls"].as_array().unwrap());
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["endpoint"], "user");
    assert_eq!(calls[0]["hostname"], "forge.example");
    assert_eq!(calls[0]["executable"], "gh");
    assert_eq!(project_files(&f.root), before);
    assert_report_matches_schema(&report);
}

#[test]
fn doctor_uses_declared_remote_stored_routing_and_explicit_overrides() {
    let f = Fixture::new();
    assert!(
        Command::new("git")
            .current_dir(&f.root)
            .args(["remote", "rename", "origin", "upstream"])
            .output()
            .unwrap()
            .status
            .success()
    );
    fs::write(
        f.root.join(".specgit.yaml"),
        "version: 2\nprovider: github\nremote: upstream\ntarget: release\n",
    )
    .unwrap();
    let private = f.root.join(".git/specgit-v2");
    fs::create_dir_all(&private).unwrap();
    let routing = json!({"version":2,"repository":{"provider":"github","host":"forge.example","path":"fixture/repo"},"api_host":"api.example:8443"}).to_string();
    fs::write(private.join("local-routing.json"), &routing).unwrap();
    for (args, host) in [
        (vec!["doctor", "--provider", "github"], "api.example:8443"),
        (
            vec![
                "doctor",
                "--provider",
                "github",
                "--api-host",
                "override.example",
            ],
            "override.example",
        ),
    ] {
        let report = f.run_raw(&args);
        assert_eq!(report["exit"], 0, "{report}");
        let local = &report["evidence"]["local"];
        assert_eq!(local["status"], "initialized");
        assert_eq!(local["target"], "release");
        assert_eq!(local["checkpoint"]["status"], "absent");
        assert_eq!(local["context"]["repository"]["host"], host);
        assert_report_matches_schema(&report);
    }
    assert!(
        Command::new("git")
            .current_dir(&f.root)
            .args([
                "remote",
                "add",
                "alternate",
                "https://elsewhere.example/fixture/repo.git"
            ])
            .output()
            .unwrap()
            .status
            .success()
    );
    let report = f.run_raw(&[
        "doctor",
        "--provider",
        "github",
        "--remote",
        "alternate",
        "--api-host",
        "explicit.example",
    ]);
    assert_eq!(report["exit"], 0, "{report}");
    assert_eq!(
        report["evidence"]["local"]["context"]["repository"]["host"],
        "explicit.example"
    );
    assert_eq!(
        fs::read_to_string(private.join("local-routing.json")).unwrap(),
        routing
    );
    assert!(!private.join("selection.json").exists());
}

#[test]
fn doctor_rejects_malformed_declaration_without_rewriting_it() {
    let f = Fixture::new();
    let malformed = "version: [broken";
    fs::write(f.root.join(".specgit.yaml"), malformed).unwrap();
    let mut state = f.state();
    state["record_transport"] = json!(true);
    fs::write(&f.state, state.to_string()).unwrap();
    let before = project_files(&f.root);
    let report = f.run_raw(&["doctor", "--provider", "github"]);
    assert_ne!(report["exit"], 0, "{report}");
    assert!(report["evidence"].get("local").is_none());
    assert_report_matches_schema(&report);
    assert!(
        !report["diagnostics"].as_array().unwrap().is_empty(),
        "{report}"
    );
    assert_eq!(
        fs::read_to_string(f.root.join(".specgit.yaml")).unwrap(),
        malformed
    );
    assert!(!f.root.join(".git/specgit-v2/selection.json").exists());
    let state = f.state();
    assert!(doctor_platform_calls(state["calls"].as_array().unwrap()).is_empty());
    assert_eq!(project_files(&f.root), before);
}

#[cfg(unix)]
#[test]
fn doctor_preserves_repository_root_with_trailing_newline() {
    let mut f = Fixture::new();
    let renamed = f.root.with_file_name("project\n");
    fs::rename(&f.root, &renamed).unwrap();
    f.root = renamed;
    let declaration = "version: 2\nprovider: github\nremote: origin\ntarget: release\n";
    fs::write(f.root.join(".specgit.yaml"), declaration).unwrap();
    let report = f.run_raw(&["doctor", "--provider", "github"]);
    assert_eq!(report["exit"], 0, "{report}");
    assert_eq!(report["evidence"]["local"]["status"], "initialized");
    assert_eq!(report["evidence"]["local"]["target"], "release");
    assert_eq!(
        report["evidence"]["local"]["context"]["root"],
        json!(f.root)
    );
    assert_eq!(
        fs::read_to_string(f.root.join(".specgit.yaml")).unwrap(),
        declaration
    );
    assert_report_matches_schema(&report);
    let status = f.run_raw(&["status"]);
    assert_eq!(status["exit"], 0, "{status}");
    assert_eq!(status["evidence"]["context"]["root"], json!(f.root));
}

#[test]
fn init_prepares_the_project_local_workflow_body() {
    let f = Fixture::new();
    let report = f.run(&["init", "--provider", "github"]);
    assert_eq!(report["status"], "initialized", "{report}");
    assert!(
        f.root
            .join(".agents/skills/specgit-native/SKILL.md")
            .is_file()
    );
}

#[test]
fn init_restores_a_clone_skill_and_preserves_the_committed_stable_entry() {
    let f = Fixture::new();
    assert_eq!(f.run(&["init", "--provider", "github"])["exit"], 0);
    let entry = fs::read(f.root.join("AGENTS.md")).unwrap();
    fs::remove_file(f.root.join(".git/specgit-v2/agent-assets/ownership.json")).unwrap();
    fs::remove_file(f.root.join(".agents/skills/specgit-native/SKILL.md")).unwrap();
    assert_eq!(f.run(&["init"])["exit"], 0);
    assert_eq!(fs::read(f.root.join("AGENTS.md")).unwrap(), entry);
    assert_eq!(f.run(&["init"])["evidence"]["transaction"]["changes"], 0);
    fs::remove_file(f.root.join(".agents/skills/specgit-native/SKILL.md")).unwrap();
    assert_eq!(f.run(&["init"])["exit"], 0);
    assert_eq!(fs::read(f.root.join("AGENTS.md")).unwrap(), entry);
    assert!(
        f.root
            .join(".agents/skills/specgit-native/SKILL.md")
            .is_file()
    );
}

#[test]
fn default_init_keeps_proven_legacy_claude_guidance_without_repeating_mirror() {
    let f = Fixture::new();
    let legacy = include_str!("fixtures/stable-guidance/2.11.1-zh.txt");
    for name in ["AGENTS.md", "CLAUDE.md"] {
        fs::write(
            f.root.join(name),
            format!("{name} manual\r\n{legacy}{name} tail\n"),
        )
        .unwrap();
    }
    let result = f.run(&["init", "--provider", "github"]);
    assert_eq!(result["exit"], 0, "{result}");
    for name in ["AGENTS.md", "CLAUDE.md"] {
        let text = fs::read_to_string(f.root.join(name)).unwrap();
        assert!(text.starts_with(&format!("{name} manual\r\n")));
        assert!(text.contains(&format!("{name} tail\n")));
        assert_eq!(
            text.matches("<!-- specgit:project:v2:start -->").count(),
            1,
            "{text}"
        );
    }
    assert!(
        f.root
            .join(".claude/skills/specgit-native/SKILL.md")
            .is_file()
    );
    assert!(!f.root.join(".claude/settings.json").exists());
    assert_eq!(f.run(&["init"])["evidence"]["transaction"]["changes"], 0);
}

#[test]
fn setup_uninstall_preserves_initialized_worktree_exclusions_until_project_remove() {
    let f = Fixture::new();
    let exclude = f.root.join(".git/info/exclude");
    fs::create_dir_all(exclude.parent().unwrap()).unwrap();
    let manual = b"# user exclusion\r\n/private-user-file\r\n";
    fs::write(&exclude, manual).unwrap();
    let initialized = f.run(&["init", "--provider", "github"]);
    assert_eq!(initialized["ok"], true, "{initialized}");
    let declaration = fs::read(f.root.join(".specgit.yaml")).unwrap();
    assert_eq!(f.run(&["setup", "--agent", "claude"])["ok"], true);
    let preview = f.run(&["setup", "--uninstall", "--dry-run"]);
    assert_eq!(preview["ok"], true, "{preview}");
    let uninstalled = f.run(&["setup", "--uninstall"]);
    assert_eq!(uninstalled["ok"], true, "{uninstalled}");
    assert_eq!(fs::read(f.root.join(".specgit.yaml")).unwrap(), declaration);
    let preserved = fs::read(&exclude).unwrap();
    assert!(preserved.starts_with(manual));
    assert!(String::from_utf8_lossy(&preserved).contains("/.specgit.yaml"));
    let ignored = Command::new("git")
        .current_dir(&f.root)
        .args(["check-ignore", ".specgit.yaml"])
        .output()
        .unwrap();
    assert!(ignored.status.success(), "{ignored:?}");
    let prepared = f.run(&["remove"]);
    assert_eq!(prepared["status"], "prepared", "{prepared}");
    let digest = prepared["evidence"]["preview_sha256"].as_str().unwrap();
    let removed = f.run(&["remove", "--apply", "--expect", digest]);
    assert_eq!(removed["ok"], true, "{removed}");
    assert!(!f.root.join(".specgit.yaml").exists());
    assert_eq!(fs::read(exclude).unwrap(), manual);
}
