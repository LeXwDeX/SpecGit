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
        let mut paths = vec![self.bin.clone()];
        paths.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        // Short budgets require the feature-enabled fixture binary, not the installed release.
        let out = Command::new(env!("CARGO_BIN_EXE_specgit"))
            .current_dir(&self.root)
            .env("PATH", std::env::join_paths(paths).unwrap())
            .env("SPECGIT_FIXTURE_API_FILE", &self.state)
            .env("SPECGIT_TEST_INSPECTION_BUDGET_MS", budget_ms.to_string())
            .args(args)
            .arg("--json")
            .output()
            .unwrap();
        let value: Value = serde_json::from_slice(&out.stdout)
            .unwrap_or_else(|_| panic!("stdout={:?}, stderr={:?}", out.stdout, out.stderr));
        assert_eq!(value["exit"].as_i64(), out.status.code().map(i64::from));
        value
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
    assert_eq!(by_id("issue.write_permission")["status"], "not_checked");
    assert_eq!(by_id("request.write_permission")["status"], "not_checked");
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
    for unknown in [
        "native.merge_readback",
        "native.issue_closure_readback",
        "main.installed_acceptance",
    ] {
        assert!(
            layer("delivery_completion")["unverified_by"]
                .as_array()
                .unwrap()
                .contains(&json!(unknown)),
            "missing lifecycle evidence {unknown} must remain visible"
        );
    }
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
        json!([
            "native.merge_readback",
            "native.issue_closure_readback",
            "main.installed_acceptance"
        ])
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
                .contains("specification Issues")
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
                .contains("原因、范围、方案")
        );
    }
    let transaction = result["evidence"]["transaction"]["transaction"]
        .as_str()
        .unwrap();
    let rollback = f.run(&["init", "--rollback", transaction]);
    assert_eq!(rollback["exit"], 0, "{rollback}");
    assert_eq!(fs::read(&receipt_path).unwrap(), before_receipt);
    assert_eq!(fs::read(f.root.join("AGENTS.md")).unwrap(), before_agents);
    assert_eq!(f.run(&["init"])["exit"], 0);
    let agents = f.root.join("AGENTS.md");
    let edited = fs::read_to_string(&agents)
        .unwrap()
        .replace("原因、范围、方案", "用户编辑");
    fs::write(&agents, &edited).unwrap();
    assert_eq!(f.run(&["init"])["exit"], 3);
    assert_eq!(fs::read_to_string(agents).unwrap(), edited);
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
            .contains("原因、范围、方案")
    );
}

#[test]
fn receiptless_worktree_refreshes_unmodified_earlier_release_guidance_only() {
    let f = Fixture::new();
    assert_eq!(f.run(&["init", "--provider", "github"])["exit"], 0);
    let receipt = f.root.join(".git/specgit-v2/guidance.json");
    let agents = f.root.join("AGENTS.md");
    let old = include_str!("fixtures/guidance-2.4.0-en.txt");
    // A fresh clone or linked worktree has the committed block but no receipt.
    fs::write(&agents, format!("User rules\n\n{old}\n")).unwrap();
    fs::remove_file(&receipt).unwrap();
    let r = f.run(&["init"]);
    assert_eq!(r["exit"], 0, "{r}");
    let text = fs::read_to_string(&agents).unwrap();
    assert!(text.starts_with("User rules\n\n<!-- specgit:v2:start -->"));
    assert!(text.contains(&format!("Runtime: {}.", env!("CARGO_PKG_VERSION"))));
    assert!(text.contains("<!-- specgit:v2:sha256 "));
    let edited = format!("User rules\n\n{}\n", old.replacen("SpecGit", "Spec Git", 2));
    fs::write(&agents, &edited).unwrap();
    fs::remove_file(&receipt).unwrap();
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
    let agents = f.root.join("AGENTS.md");
    let old = include_str!("fixtures/guidance-2.5.0-zh.txt");
    fs::write(&agents, format!("{old}\n")).unwrap();
    let r = f.run(&["init", "--config-file", config.to_str().unwrap()]);
    assert_eq!(r["exit"], 0, "{r}");
    let text = fs::read_to_string(&agents).unwrap();
    assert!(text.contains("<!-- specgit:v2:sha256 "));
    assert!(text.contains("\"language\":\"zh\""));
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
    assert_eq!(agents.matches("<!-- specgit:v2:start -->").count(), 1);
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
