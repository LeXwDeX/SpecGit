#![cfg(feature = "test-fixtures")]
#[path = "support/executable.rs"]
mod executable;
use serde_json::{Value, json};
use std::{fs, path::PathBuf, process::Command};
struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    state: PathBuf,
    bin: PathBuf,
}

fn report_schema_with_init_checks() -> Value {
    let mut schema: Value =
        serde_json::from_str(include_str!("../schemas/report.schema.json")).unwrap();
    schema["properties"]["evidence"] = init_evidence_schema(&schema);
    schema
}

fn init_evidence_schema(report_schema: &Value) -> Value {
    json!({
        "$schema": report_schema["$schema"],
        "$defs": report_schema["$defs"],
        "type": "object",
        "additionalProperties": true,
        "required": ["checks", "operation_assessments"],
        "properties": {
            "checks": {"type":"array","items":{"$ref":"#/$defs/init_check"}},
            "operation_assessments": {"$ref":"#/$defs/init_operation_assessments"}
        }
    })
}

fn assert_report_matches_schema(report: &Value) {
    let schema = report_schema_with_init_checks();
    jsonschema::draft202012::validate(&schema, report)
        .unwrap_or_else(|error| panic!("report violates report.schema.json: {error}"));
}

fn assert_init_evidence_matches_schema(evidence: &Value) {
    let report_schema: Value =
        serde_json::from_str(include_str!("../schemas/report.schema.json")).unwrap();
    let schema = init_evidence_schema(&report_schema);
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
        let out = executable::command()
            .current_dir(&self.root)
            .env("PATH", std::env::join_paths(paths).unwrap())
            .env("SPECGIT_FIXTURE_API_FILE", &self.state)
            .args(args)
            .arg("--json")
            .output()
            .unwrap();
        let v: Value = serde_json::from_slice(&out.stdout)
            .unwrap_or_else(|_| panic!("stdout={:?}, stderr={:?}", out.stdout, out.stderr));
        assert_eq!(v["exit"].as_i64(), out.status.code().map(i64::from));
        v
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
    let schema = report_schema_with_init_checks();
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
    for name in [".specgit.yaml", "AGENTS.md", "CLAUDE.md"] {
        assert!(
            Command::new("git")
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
