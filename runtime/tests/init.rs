#![cfg(feature = "test-fixtures")]
use serde_json::{Value, json};
use std::{fs, path::PathBuf, process::Command};
struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    state: PathBuf,
    bin: PathBuf,
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
        let mut paths = vec![self.bin.clone()];
        paths.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        let out = Command::new(env!("CARGO_BIN_EXE_specgit"))
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
    fn state(&self) -> Value {
        serde_json::from_slice(&fs::read(&self.state).unwrap()).unwrap()
    }
}
#[test]
fn both_forges_init_refresh_and_explicit_cleanup_use_live_default_and_preserve_user_content() {
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
        assert_eq!(r["exit"], 0, "{r}");
        assert_eq!(r["evidence"]["native_setting_change"]["observed"], true);
        assert!(
            fs::read_to_string(f.root.join("CLAUDE.md"))
                .unwrap()
                .contains("issue-based delivery harness")
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
            1
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
    assert_eq!(r["exit"], 3);
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
    git(&["add", ".specgit.yaml", "AGENTS.md"]);
    git(&["commit", "-m", "Chinese branch"]);
    git(&["checkout", "-b", "english"]);
    assert_eq!(f.run(&["init", "--language", "en"])["exit"], 0);
    git(&["add", ".specgit.yaml", "AGENTS.md"]);
    git(&["commit", "-m", "English branch"]);
    git(&["checkout", "feature"]);
    assert_eq!(f.run(&["init"])["exit"], 0);
    assert!(
        fs::read_to_string(f.root.join("AGENTS.md"))
            .unwrap()
            .contains("原因、范围、方案")
    );
}
