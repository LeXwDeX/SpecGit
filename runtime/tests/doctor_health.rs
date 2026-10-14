#![cfg(feature = "test-fixtures")]

#[path = "support/executable.rs"]
mod executable;

use serde_json::{Value, json};
use specgit::setup::{Agent, project};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::{Command, ExitStatus},
};

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap().join("project");
        fs::create_dir_all(&root).unwrap();
        for args in [
            vec!["init", "-b", "feature"],
            vec![
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "fixture",
            ],
        ] {
            let output = Command::new("git")
                .current_dir(&root)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let output = Command::new("git")
            .current_dir(&root)
            .args([
                "remote",
                "add",
                "origin",
                "https://github.com/fixture/repo.git",
            ])
            .output()
            .unwrap();
        assert!(output.status.success());
        Self { _temp: temp, root }
    }

    fn doctor(&self, args: &[&str]) -> (Value, std::process::ExitStatus) {
        let output = executable::command()
            .current_dir(&self.root)
            .args(args)
            .arg("--json")
            .output()
            .unwrap();
        let report: Value = serde_json::from_slice(&output.stdout)
            .unwrap_or_else(|_| panic!("stdout={:?}; stderr={:?}", output.stdout, output.stderr));
        (report, output.status)
    }

    fn private(&self) -> PathBuf {
        let output = Command::new("git")
            .current_dir(&self.root)
            .args(["rev-parse", "--absolute-git-dir"])
            .output()
            .unwrap();
        assert!(output.status.success());
        PathBuf::from(String::from_utf8(output.stdout).unwrap().trim())
            .join("specgit-v2/agent-assets")
    }

    fn install_generic(&self) {
        fs::write(
            self.root.join(".specgit.yaml"),
            "version: 2\nprovider: github\nremote: origin\ntarget: main\n",
        )
        .unwrap();
        let base = self._temp.path().canonicalize().unwrap();
        let source = base.join(if cfg!(windows) {
            "shared-specgit.exe"
        } else {
            "shared-specgit"
        });
        fs::copy(executable::binary(), &source).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&source, fs::Permissions::from_mode(0o755)).unwrap();
        }
        project::install(
            &project::Options {
                agents: vec![Agent::Generic],
                opencode_claude_hooks: false,
                uninstall: false,
                dry_run: false,
                rollback: None,
            },
            &self.root,
            &self.private(),
            &source,
        )
        .unwrap();
    }
}

fn files(root: &Path) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
    let mut result = BTreeMap::new();
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

fn doctor_in(root: &Path, args: &[&str]) -> (Value, ExitStatus) {
    let output = executable::command()
        .current_dir(root)
        .args(args)
        .arg("--json")
        .output()
        .unwrap();
    let report: Value = serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|_| panic!("stdout={:?}; stderr={:?}", output.stdout, output.stderr));
    (report, output.status)
}

#[test]
fn doctor_offline_runs_project_health_without_platform_probes() {
    let fixture = Fixture::new();
    let (report, status) = fixture.doctor(&["doctor", "--offline"]);

    assert!(status.success(), "{report}");
    assert_eq!(report["operation"], "doctor");
    assert_eq!(report["status"], "attention_required");
    assert!(report["evidence"]["local"].is_object());
    assert_eq!(report["evidence"]["health"]["scope"], "project_static");
    assert!(report["evidence"]["health"]["checks"].is_array());
    assert_eq!(
        report["evidence"]["health"]["host_behavior"],
        "not_verified"
    );
    assert_eq!(report["evidence"]["repair"]["requested"], false);
    assert_eq!(report["evidence"]["agent_guidance"]["max_rounds"], 3);
    assert!(report["evidence"]["agent_guidance"]["tasks"].is_array());
    assert!(report["evidence"]["agent_guidance"]["stop_conditions"].is_array());
}

#[test]
fn doctor_health_checks_are_stable_and_report_schema_accepts_the_new_fields() {
    let fixture = Fixture::new();
    let (report, status) = fixture.doctor(&["doctor", "--offline"]);
    assert!(status.success(), "{report}");
    let checks = report["evidence"]["health"]["checks"].as_array().unwrap();
    for expected in ["declaration", "setup", "guidance", "guard"] {
        let check = checks
            .iter()
            .find(|check| check["id"] == expected)
            .unwrap_or_else(|| panic!("missing {expected}: {checks:?}"));
        assert!(
            matches!(
                check["status"].as_str(),
                Some(
                    "current"
                        | "change_required"
                        | "not_selected"
                        | "unknown"
                        | "needs_initialization"
                        | "not_checked"
                )
            ),
            "{check}"
        );
        assert!(check["severity"].is_string(), "{check}");
        assert!(check["repairable"].is_boolean(), "{check}");
        assert!(
            check["evidence"].is_null()
                || check["evidence"].is_array()
                || check["evidence"].is_object(),
            "{check}"
        );
        assert!(
            check["diagnostic"].is_null() || check["diagnostic"].is_string(),
            "{check}"
        );
    }
    let schema: Value =
        serde_json::from_str(include_str!("../schemas/report.schema.json")).unwrap();
    let valid = |value: &Value| jsonschema::draft202012::validate(&schema, value).is_ok();
    assert!(valid(&report), "doctor report violates schema: {report}");

    // Additive doctor evidence must keep accepting reports emitted before this extension.
    let mut historical = report.clone();
    for key in ["health", "repair", "agent_guidance"] {
        historical["evidence"].as_object_mut().unwrap().remove(key);
    }
    assert!(
        valid(&historical),
        "historical doctor report rejected: {historical}"
    );

    let mut invalid = report.clone();
    invalid["evidence"]["health"]["checks"][0]["status"] = json!("green");
    assert!(
        !valid(&invalid),
        "unknown health status accepted: {invalid}"
    );
    let mut invalid = report.clone();
    invalid["evidence"]["agent_guidance"]["max_rounds"] = json!(4);
    assert!(!valid(&invalid), "unbounded guidance accepted: {invalid}");
    let mut invalid = report.clone();
    invalid["evidence"]["repair"]["plans"] = json!([{"id":"setup","assets":[{"path":".agents/skills/specgit-native/SKILL.md","state":"healthy"}]}]);
    assert!(
        !valid(&invalid),
        "invalid maintenance state accepted: {invalid}"
    );
}

#[test]
fn doctor_offline_is_read_only_and_works_from_a_project_subdirectory() {
    let fixture = Fixture::new();
    let nested = fixture.root.join("nested");
    fs::create_dir(&nested).unwrap();
    fs::write(nested.join("note.txt"), "preserve\n").unwrap();
    let before = files(&fixture.root);
    let (report, status) = doctor_in(&nested, &["doctor", "--offline"]);
    assert!(status.success(), "{report}");
    assert_eq!(files(&fixture.root), before);
    assert_eq!(report["status"], "attention_required");
    assert_eq!(report["evidence"]["health"]["scope"], "project_static");
    assert_ne!(report["evidence"]["health"]["status"], "healthy");
    assert_eq!(
        report["evidence"]["health"]["host_behavior"],
        "not_verified"
    );
    assert!(
        report["evidence"]["probes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|probe| probe["status"] == "not_checked")
    );
}

#[test]
fn doctor_offline_honors_explicit_cwd_and_keeps_local_checks_without_a_remote() {
    let fixture = Fixture::new();
    let output = Command::new("git")
        .current_dir(&fixture.root)
        .args(["remote", "remove", "origin"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let outside = fixture._temp.path();
    let before = files(&fixture.root);
    let cwd = fixture.root.to_string_lossy().to_string();
    let (report, _) = doctor_in(outside, &["--cwd", &cwd, "doctor", "--offline"]);
    let checks = report["evidence"]["health"]["checks"].as_array().unwrap();
    for expected in ["declaration", "setup", "guidance", "guard"] {
        assert!(
            checks.iter().any(|check| check["id"] == expected),
            "{report}"
        );
    }
    assert!(
        matches!(
            report["status"].as_str(),
            Some("offline_checked" | "attention_required" | "unknown")
        ),
        "{report}"
    );
    assert_eq!(files(&fixture.root), before);
}

#[test]
fn doctor_offline_from_non_git_directory_does_not_initialize_or_create_files() {
    let temp = tempfile::tempdir().unwrap();
    let outside = temp.path().join("ordinary-directory");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("keep.txt"), "keep\n").unwrap();
    let before = files(&outside);
    let (report, status) = doctor_in(&outside, &["doctor", "--offline"]);
    assert!(matches!(status.code(), Some(0 | 3)), "{report}");
    assert!(
        matches!(
            report["status"].as_str(),
            Some("offline_checked" | "attention_required" | "unknown")
        ),
        "{report}"
    );
    assert_eq!(files(&outside), before);
    assert!(!outside.join(".specgit.yaml").exists());
}

#[test]
fn doctor_fix_dry_run_preserves_files_and_reports_asset_plans() {
    let fixture = Fixture::new();
    fixture.install_generic();
    let skill = fixture.root.join(".agents/skills/specgit-native/SKILL.md");
    fs::write(&skill, "damaged user-visible body\n").unwrap();
    let before = files(&fixture.root);
    let (report, status) = fixture.doctor(&["doctor", "--offline", "--fix", "--dry-run"]);
    assert!(status.success(), "{report}");
    assert_eq!(files(&fixture.root), before);
    assert_eq!(report["evidence"]["repair"]["requested"], true);
    assert_eq!(report["evidence"]["repair"]["dry_run"], true);
    assert!(
        report["evidence"]["repair"]["plans"]
            .as_array()
            .unwrap()
            .iter()
            .any(|plan| plan["assets"]
                .as_array()
                .unwrap()
                .iter()
                .any(|asset| asset["path"]
                    .as_str()
                    .unwrap_or("")
                    .contains("specgit-native/SKILL.md")))
    );
}

#[test]
fn doctor_fix_repairs_owned_generic_skill_and_second_run_converges() {
    let fixture = Fixture::new();
    fixture.install_generic();
    let skill = fixture.root.join(".agents/skills/specgit-native/SKILL.md");
    fs::write(&skill, "corrupted managed Skill\n").unwrap();
    let (first, first_status) = fixture.doctor(&["doctor", "--offline", "--fix"]);
    assert!(first_status.success(), "{first}");
    assert_ne!(
        fs::read_to_string(&skill).unwrap(),
        "corrupted managed Skill\n"
    );
    assert_eq!(first["evidence"]["repair"]["requested"], true);
    assert!(
        first["evidence"]["repair"]["recheck"]["checks"].is_array(),
        "{first}"
    );

    let (second, second_status) = fixture.doctor(&["doctor", "--offline", "--fix"]);
    assert!(second_status.success(), "{second}");
    assert_eq!(second["evidence"]["repair"]["requested"], true);
    assert_ne!(
        second["evidence"]["health"]["status"], "unknown",
        "{second}"
    );
    assert!(
        second["evidence"]["repair"]["plans"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|plan| plan["assets"].as_array().into_iter().flatten())
            .all(|asset| !matches!(
                asset["state"].as_str(),
                Some("change_required" | "planned" | "repair_required")
            )),
        "{second}"
    );
}

#[test]
fn doctor_fix_restores_a_missing_owned_generic_skill() {
    let fixture = Fixture::new();
    fixture.install_generic();
    let skill = fixture.root.join(".agents/skills/specgit-native/SKILL.md");
    fs::remove_file(&skill).unwrap();
    let before = files(&fixture.root);
    let (preview, preview_status) = fixture.doctor(&["doctor", "--offline", "--fix", "--dry-run"]);
    assert!(preview_status.success(), "{preview}");
    assert_eq!(files(&fixture.root), before);
    assert!(
        preview["evidence"]["repair"]["plans"]
            .as_array()
            .unwrap()
            .iter()
            .any(|plan| plan["assets"]
                .as_array()
                .unwrap()
                .iter()
                .any(|asset| asset["path"]
                    .as_str()
                    .unwrap_or("")
                    .contains("specgit-native/SKILL.md")))
    );
    let (fixed, fixed_status) = fixture.doctor(&["doctor", "--offline", "--fix"]);
    assert!(fixed_status.success(), "{fixed}");
    assert!(skill.is_file(), "{fixed}");
    let after_fix = files(&fixture.root);
    let (second, second_status) = fixture.doctor(&["doctor", "--offline", "--fix"]);
    assert!(second_status.success(), "{second}");
    assert_eq!(files(&fixture.root), after_fix);
}

#[test]
fn doctor_reports_missing_declaration_when_owned_setup_state_remains() {
    let fixture = Fixture::new();
    fixture.install_generic();
    fs::remove_file(fixture.root.join(".specgit.yaml")).unwrap();
    let before = files(&fixture.root);
    let (report, status) = fixture.doctor(&["doctor", "--offline"]);
    assert!(
        !status.success(),
        "missing declarations with private state must fail closed: {report}"
    );
    assert_eq!(files(&fixture.root), before);
    assert_eq!(report["evidence"]["health"]["status"], "unknown");
    assert_eq!(
        report["evidence"]["health"]["checks"][1]["id"],
        "declaration"
    );
    assert_eq!(
        report["evidence"]["health"]["checks"][1]["status"],
        "unknown"
    );
}

#[test]
fn doctor_fix_refuses_unknown_ownership_without_changing_project_files() {
    let fixture = Fixture::new();
    fixture.install_generic();
    fs::write(
        fixture.private().join("ownership.json"),
        b"broken receipt\n",
    )
    .unwrap();
    let before = files(&fixture.root);
    let (report, status) = fixture.doctor(&["doctor", "--offline", "--fix"]);
    assert_eq!(files(&fixture.root), before);
    assert_eq!(status.code(), Some(2), "{report}");
    assert!(
        report["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "invalid_input"
                || diagnostic["message"]
                    .as_str()
                    .is_some_and(|message| message.contains("Malformed JSON"))),
        "{report}"
    );
}

#[test]
fn doctor_rejects_invalid_fix_combinations_and_preserves_account_only_contract() {
    let fixture = Fixture::new();
    for args in [
        vec!["doctor", "--offline", "--dry-run"],
        vec!["doctor", "--account-only"],
        vec![
            "doctor",
            "--account-only",
            "--provider",
            "github",
            "--offline",
        ],
        vec!["doctor", "--account-only", "--provider", "github", "--fix"],
    ] {
        let output = executable::command()
            .current_dir(&fixture.root)
            .args(&args)
            .arg("--json")
            .output()
            .unwrap();
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(output.status.code(), Some(2), "{args:?}: {report}");
    }
    let (report, status) = fixture.doctor(&["doctor", "--account-only", "--provider", "github"]);
    assert!(status.success(), "{report}");
    assert_eq!(report["evidence"]["health"]["scope"], "account_only");
    assert_eq!(report["evidence"]["health"]["status"], "not_checked");
    assert_eq!(report["evidence"]["repair"]["requested"], false);
    let schema: Value =
        serde_json::from_str(include_str!("../schemas/report.schema.json")).unwrap();
    jsonschema::draft202012::validate(&schema, &report).unwrap_or_else(|error| {
        panic!("account-only doctor report violates schema: {error}; {report}")
    });
}

#[test]
fn doctor_fix_converges_both_owned_blocks_in_one_guidance_file() {
    let fixture = Fixture::new();
    fixture.install_generic();
    let private = fixture.private().parent().unwrap().to_path_buf();
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
    let path = fixture.root.join("AGENTS.md");
    let canonical = fs::read_to_string(&path).unwrap();
    let edited = format!(
        "Keep this manual prefix.\n{}\nKeep this manual suffix.\n",
        canonical
            .replace(
                "<!-- specgit:project:v2:start -->",
                "<!-- specgit:project:v2:start -->\nStale project content."
            )
            .replace(
                "<!-- specgit:v2:start -->",
                "<!-- specgit:v2:start -->\nStale init content."
            )
    );
    fs::write(&path, &edited).unwrap();
    let (preview, status) = fixture.doctor(&["doctor", "--offline", "--fix", "--dry-run"]);
    assert!(status.success(), "{preview}");
    assert_eq!(
        preview["evidence"]["repair"]["plans"]
            .as_array()
            .unwrap()
            .len(),
        2,
        "{preview}"
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), edited);
    let (fixed, status) = fixture.doctor(&["doctor", "--offline", "--fix"]);
    assert!(status.success(), "{fixed}");
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.starts_with("Keep this manual prefix.\n"));
    assert!(text.ends_with("\nKeep this manual suffix.\n"));
    assert!(!text.contains("Stale project content."));
    assert!(!text.contains("Stale init content."));
    let settled = files(&fixture.root);
    let (next, status) = fixture.doctor(&["doctor", "--offline", "--fix"]);
    assert!(status.success(), "{next}");
    assert!(
        next["evidence"]["repair"]["plans"]
            .as_array()
            .unwrap()
            .is_empty(),
        "{next}"
    );
    assert_eq!(files(&fixture.root), settled);
}

#[cfg(unix)]
#[test]
fn doctor_offline_never_launches_provider_cli_and_human_output_is_compact() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let bin = fixture._temp.path().canonicalize().unwrap().join("bin");
    fs::create_dir(&bin).unwrap();
    let fake = bin.join("gh");
    fs::write(
        &fake,
        "#!/bin/sh\nprintf invoked > provider-was-launched\nexit 99\n",
    )
    .unwrap();
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
    let mut paths = vec![bin];
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    let output = executable::command()
        .current_dir(&fixture.root)
        .env("PATH", std::env::join_paths(paths).unwrap())
        .args(["doctor", "--offline", "--human"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{:?}", output);
    assert!(!fixture.root.join("provider-was-launched").exists());
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(text.contains("declaration: needs_initialization"), "{text}");
    assert!(text.contains("not verified"), "{text}");
    assert!(!text.contains("\"agent_guidance\""), "{text}");
    assert!(text.lines().count() < 30, "{text}");
}

#[test]
fn doctor_does_not_treat_a_declaration_alone_as_completed_initialization() {
    let fixture = Fixture::new();
    fs::write(
        fixture.root.join(".specgit.yaml"),
        "version: 2\nprovider: github\nremote: origin\ntarget: main\n",
    )
    .unwrap();
    let before = files(&fixture.root);
    let (report, status) = fixture.doctor(&["doctor", "--offline", "--fix"]);
    assert!(status.success(), "{report}");
    assert_eq!(report["status"], "attention_required");
    assert_eq!(report["evidence"]["health"]["status"], "attention");
    assert!(
        report["evidence"]["agent_guidance"]["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|task| task["check"] == "initialization")
    );
    assert_eq!(files(&fixture.root), before);
}

#[test]
fn doctor_keeps_committed_transaction_when_postimage_verification_fails() {
    let fixture = Fixture::new();
    fixture.install_generic();
    fs::write(
        fixture.root.join(".agents/skills/specgit-native/SKILL.md"),
        "outdated owned content",
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_specgit"))
        .current_dir(&fixture.root)
        .env("SPECGIT_FIXTURE_DOCTOR_POST_APPLY_FAILURE", "1")
        .args(["doctor", "--offline", "--fix", "--json"])
        .output()
        .unwrap();
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(output.status.code(), Some(1), "{report}");
    let result = &report["evidence"]["repair"]["results"][0];
    assert_eq!(result["status"], "failed");
    let transaction = result["transaction"]["transaction"].as_str().unwrap();
    assert!(!transaction.is_empty(), "{report}");
    let journal: Value = serde_json::from_slice(
        &fs::read(
            fixture
                .private()
                .join("transactions")
                .join(transaction)
                .join("journal.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(journal["state"], "committed");
    assert_eq!(
        report["effects"]["operations"][0]["recovery"]["transaction"]["transaction"],
        transaction
    );
    assert!(
        !report["evidence"]["agent_guidance"]["tasks"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
