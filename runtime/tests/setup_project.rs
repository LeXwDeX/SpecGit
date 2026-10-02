//! Project setup contract: worktree-owned receipts, the separately installed
//! shared CLI as an external executable fixture, and CLI input rejections.
//! Global setup is removed permanently; see tests/setup.rs for reject-global
//! command coverage.
use serde_json::{Value, json};
use specgit::{
    diagnostic::Code,
    setup::{Agent, project},
};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
};
#[path = "support/executable.rs"]
mod executable;

fn files(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut result = BTreeMap::new();
    for entry in fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            result.extend(files(&path));
        } else if path.file_name().unwrap() != ".specgit-lock" {
            result.insert(path.clone(), fs::read(path).unwrap());
        }
    }
    result
}

/// Checkout files outside Git's private specgit-v2 journal area, whose
/// transaction records are AssetStore mechanics covered elsewhere.
fn checkout_files(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let private = |path: &Path| path.components().any(|c| c.as_os_str() == "specgit-v2");
    files(root)
        .into_iter()
        .filter(|(path, _)| !private(path))
        .collect()
}

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}

/// A regular executable native CLI fixture outside any project checkout. Setup
/// treats it as the separately installed shared executable; no global receipt
/// exists, so tests may remove or mutate this copy freely.
fn source_fixture(directory: &Path) -> PathBuf {
    let path = directory.join(if cfg!(windows) {
        "specgit-fixture.exe"
    } else {
        "specgit-fixture"
    });
    fs::copy(executable::binary(), &path).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    path
}

struct Fixture {
    _temp: tempfile::TempDir,
    base: PathBuf,
    root: PathBuf,
    private: PathBuf,
    source: PathBuf,
}

fn fixture(agents: Vec<Agent>) -> (Fixture, project::Options) {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let root = base.join("checkout");
    fs::create_dir(&root).unwrap();
    git(&root, &["init", "-b", "feature"]);
    git(
        &root,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "fixture",
        ],
    );
    let private = PathBuf::from(git(&root, &["rev-parse", "--absolute-git-dir"]))
        .join("specgit-v2/agent-assets");
    let source = source_fixture(&base);
    (
        Fixture {
            _temp: temp,
            base,
            root,
            private,
            source,
        },
        project::Options {
            agents,
            opencode_claude_hooks: false,
            uninstall: false,
            dry_run: false,
            rollback: None,
        },
    )
}

fn install(
    options: &project::Options,
    f: &Fixture,
) -> Result<Value, specgit::diagnostic::Diagnostic> {
    project::install(options, &f.root, &f.private, &f.source)
}

#[test]
fn selected_agents_are_isolated_and_project_never_installs_an_executable() {
    for agent in [Agent::Generic, Agent::Claude, Agent::Codex, Agent::Opencode] {
        let (f, mut options) = fixture(vec![agent]);
        let source = fs::read(&f.source).unwrap();
        let pristine = checkout_files(&f.root);
        let before = files(&f.base);
        options.dry_run = true;
        let preview = install(&options, &f).unwrap();
        assert_eq!(preview["scope"], "project");
        assert_eq!(preview["operation"], "install");
        assert_eq!(preview["registration"], "write_planned");
        assert_eq!(preview["written"], false);
        assert_eq!(files(&f.base), before);
        assert!(!f.private.join("ownership.json").exists());
        options.dry_run = false;
        let result = install(&options, &f).unwrap();
        assert_eq!(result["registration"], "written_not_verified");
        assert_eq!(result["host_delivery"]["imported_event"], "not_checked");
        assert!(
            f.root
                .join(".agents/skills/specgit-native/SKILL.md")
                .exists()
        );
        assert_eq!(
            f.root
                .join(".claude/skills/specgit-native/SKILL.md")
                .exists(),
            agent == Agent::Claude
        );
        assert_eq!(
            f.root.join(".claude/settings.json").exists(),
            agent == Agent::Claude
        );
        assert_eq!(
            f.root.join(".codex/hooks.json").exists(),
            agent == Agent::Codex
        );
        // Default OpenCode selection registers no hooks at all.
        assert!(!f.root.join(".opencode").exists());
        assert!(!f.root.join("versions").exists());
        assert!(!f.root.join("bin").exists());
        assert_eq!(fs::read(&f.source).unwrap(), source);
        for relative in [".claude/settings.json", ".codex/hooks.json"] {
            if f.root.join(relative).exists() {
                let text = fs::read_to_string(f.root.join(relative)).unwrap();
                assert!(!text.contains("--state-root"), "{text}");
                let hooks: Value = serde_json::from_str(&text).unwrap();
                let entry = &hooks["hooks"]["SessionStart"][0]["hooks"][0];
                assert_eq!(entry["command"], json!(f.source.to_str().unwrap()));
                assert_eq!(entry["args"], json!(["hook", "--event", "SessionStart"]));
            }
        }
        options.agents.clear();
        assert_eq!(install(&options, &f).unwrap()["transaction"]["changes"], 0);
        let installed = files(&f.base);
        options.uninstall = true;
        options.dry_run = true;
        install(&options, &f).unwrap();
        assert_eq!(files(&f.base), installed);
        options.dry_run = false;
        install(&options, &f).unwrap();
        assert_eq!(checkout_files(&f.root), pristine);
        assert!(!f.private.join("ownership.json").exists());
        assert_eq!(fs::read(&f.source).unwrap(), source);
    }
}

#[test]
fn custom_opencode_claude_hooks_are_top_level_native_quoted_commands() {
    let (f, mut options) = fixture(vec![Agent::Opencode]);
    options.opencode_claude_hooks = true;
    install(&options, &f).unwrap();
    let path = f.root.join(".opencode/hooks.json");
    let text = fs::read_to_string(&path).unwrap();
    let hooks: Value = serde_json::from_str(&text).unwrap();
    assert!(hooks.get("hooks").is_none(), "{hooks}");
    for event in ["SessionStart", "PreToolUse", "PostToolUse", "Stop"] {
        let entry = &hooks[event][0]["hooks"][0];
        assert_eq!(entry["shell"], "bash", "{event}: {hooks}");
        assert_eq!(
            entry["command"],
            json!(format!("'{}' hook --event {event}", f.source.display())),
            "{event}: {hooks}"
        );
        assert_eq!(entry["inputFormat"], "claude-code", "{event}: {hooks}");
        if matches!(event, "PreToolUse" | "PostToolUse") {
            assert!(
                hooks[event][0]["matcher"]
                    .as_str()
                    .is_some_and(|m| m.contains("apply_patch")),
                "{event}: {hooks}"
            );
        }
    }
    let receipt: Value =
        serde_json::from_slice(&fs::read(f.private.join("ownership.json")).unwrap()).unwrap();
    assert_eq!(receipt["version"], 2);
    assert_eq!(receipt["agents"], json!(["opencode"]), "{receipt}");
    assert!(receipt["hooks"].get("opencode").is_some(), "{receipt}");
    // The custom choice persists: a plain refresh keeps the recorded hooks.
    let before = fs::read(&path).unwrap();
    options.opencode_claude_hooks = false;
    options.agents.clear();
    assert_eq!(install(&options, &f).unwrap()["transaction"]["changes"], 0);
    assert_eq!(fs::read(&path).unwrap(), before);
    options.uninstall = true;
    install(&options, &f).unwrap();
    assert!(!path.exists());
}

#[test]
fn custom_opencode_hooks_require_the_selected_agent() {
    let (f, mut options) = fixture(vec![Agent::Claude]);
    options.opencode_claude_hooks = true;
    let before = files(&f.base);
    let error = install(&options, &f).unwrap_err();
    assert_eq!(error.code, Code::InvalidInput, "{error}");
    assert!(error.message.contains("--agent opencode"), "{error}");
    assert_eq!(files(&f.base), before);
    assert!(!f.private.join("ownership.json").exists());
}

fn skill_text() -> String {
    include_str!("../assets/SKILL.md").replace("{{version}}", env!("CARGO_PKG_VERSION"))
}

#[test]
fn project_receipt_v2_is_written_and_legacy_v1_receipts_stay_readable() {
    // New integrations record a version 2 receipt with no shared root at all.
    let (f, options) = fixture(vec![Agent::Generic]);
    install(&options, &f).unwrap();
    let receipt: Value =
        serde_json::from_slice(&fs::read(f.private.join("ownership.json")).unwrap()).unwrap();
    assert_eq!(receipt["version"], 2, "{receipt}");
    assert!(receipt.get("shared_root").is_none(), "{receipt}");
    assert_eq!(receipt["root"], json!(f.root.canonicalize().unwrap()));
    assert_eq!(receipt["agents"], json!(["generic"]));
    assert!(
        receipt["skills"]
            .get(".agents/skills/specgit-native/SKILL.md")
            .is_some()
    );
    assert!(receipt["instructions"].get("generic").is_some());

    // A 2.x v1 receipt with a shared root stays readable: refresh migrates it
    // to v2 without adopting foreign content, and uninstall still honors it.
    let (f, mut options) = fixture(vec![]);
    let skill = skill_text();
    let skill_path = f.root.join(".agents/skills/specgit-native/SKILL.md");
    fs::create_dir_all(skill_path.parent().unwrap()).unwrap();
    fs::write(&skill_path, &skill).unwrap();
    let block = "<!-- specgit:global:v2:start -->\n## SpecGit 2\n\nlegacy 2.3 guidance\n<!-- specgit:global:v2:end -->\n";
    let user = "user rules\n\n";
    fs::write(f.root.join("AGENTS.md"), format!("{user}{block}")).unwrap();
    let legacy = json!({
        "version": 1,
        "owner": "specgit",
        "root": serde_json::to_value(&f.root).unwrap(),
        "shared_root": serde_json::to_value(f.base.join("shared")).unwrap(),
        "agents": ["generic"],
        "skills": {".agents/skills/specgit-native/SKILL.md": specgit::assets::hash(skill.as_bytes())},
        "instructions": {"generic": {
            "root": serde_json::to_value(&f.root).unwrap(),
            "skill_hash": specgit::assets::hash(skill.as_bytes()),
            "instructions": "AGENTS.md",
            "block": block,
            "created_instructions": false,
        }},
        "hooks": {},
    });
    fs::create_dir_all(&f.private).unwrap();
    fs::write(
        f.private.join("ownership.json"),
        serde_json::to_vec_pretty(&legacy).unwrap(),
    )
    .unwrap();
    let result = install(&options, &f).unwrap();
    assert_eq!(result["agents"], json!(["generic"]));
    assert_eq!(result["transaction"]["changes"], 2, "{result}");
    let guidance = fs::read_to_string(f.root.join("AGENTS.md")).unwrap();
    assert!(guidance.starts_with(user), "{guidance}");
    assert!(
        guidance.contains("<!-- specgit:project:v2:start -->"),
        "{guidance}"
    );
    assert!(!guidance.contains("specgit:global:v2"), "{guidance}");
    let receipt: Value =
        serde_json::from_slice(&fs::read(f.private.join("ownership.json")).unwrap()).unwrap();
    assert_eq!(receipt["version"], 2, "{receipt}");
    assert!(receipt.get("shared_root").is_none(), "{receipt}");
    options.agents.clear();
    assert_eq!(install(&options, &f).unwrap()["transaction"]["changes"], 0);
    options.uninstall = true;
    install(&options, &f).unwrap();
    assert_eq!(fs::read_to_string(f.root.join("AGENTS.md")).unwrap(), user);
    assert!(!skill_path.exists());
    assert!(!f.private.join("ownership.json").exists());
}

#[test]
fn source_executable_faults_are_rejected_before_any_writes() {
    for fault in ["relative", "inside project", "missing", "empty", "mode"] {
        #[cfg(not(unix))]
        if fault == "mode" {
            continue;
        }
        let (f, options) = fixture(vec![Agent::Codex]);
        let source = match fault {
            "relative" => PathBuf::from("specgit-relative-fixture"),
            "inside project" => {
                let path = f.root.join("copied-fixture");
                fs::copy(&f.source, &path).unwrap();
                path
            }
            "missing" => f.base.join("absent-fixture"),
            "empty" => {
                let path = f.base.join("empty-fixture");
                fs::write(&path, b"").unwrap();
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
                }
                path
            }
            _ => {
                let path = f.base.join("noexec-fixture");
                fs::copy(&f.source, &path).unwrap();
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
                }
                path
            }
        };
        let before = files(&f.base);
        let error = project::install(&options, &f.root, &f.private, &source).unwrap_err();
        match fault {
            "relative" => {
                assert_eq!(error.code, Code::UnsafePath, "{fault}: {error}");
                assert!(error.message.contains("absolute"), "{error}");
            }
            "inside project" => {
                assert_eq!(error.code, Code::InvalidInput, "{fault}: {error}");
                assert!(error.message.contains("outside this checkout"), "{error}");
            }
            "missing" | "empty" => {
                assert_eq!(error.code, Code::OwnershipConflict, "{fault}: {error}");
                assert!(error.message.contains("unavailable"), "{error}");
            }
            _ => {
                assert_eq!(error.code, Code::OwnershipConflict, "{fault}: {error}");
                assert!(error.message.contains("execute permission"), "{error}");
            }
        }
        assert_eq!(files(&f.base), before, "{fault}");
        assert!(!f.private.join("ownership.json").exists(), "{fault}");
    }
}

#[test]
fn additive_selection_coowns_guidance_once_and_preserves_user_content_without_the_executable() {
    let (f, mut options) = fixture(vec![Agent::Generic]);
    let user = "user guidance\r\n<!-- specgit:v2:start -->\ninit block\n<!-- specgit:v2:end -->\n";
    fs::write(f.root.join("AGENTS.md"), user).unwrap();
    install(&options, &f).unwrap();
    options.agents = vec![Agent::Codex, Agent::Opencode, Agent::Claude];
    install(&options, &f).unwrap();
    let guidance = fs::read_to_string(f.root.join("AGENTS.md")).unwrap();
    assert_eq!(
        guidance
            .matches("<!-- specgit:project:v2:start -->")
            .count(),
        1,
        "{guidance}"
    );
    assert!(!guidance.contains("specgit:global:v2"), "{guidance}");
    options.agents.clear();
    assert_eq!(install(&options, &f).unwrap()["transaction"]["changes"], 0);
    fs::write(
        f.root.join("AGENTS.md"),
        format!("{guidance}later user content"),
    )
    .unwrap();
    let settings = f.root.join(".claude/settings.json");
    let mut value: Value = serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
    value["foreign"] = json!({"preserve":true});
    fs::write(&settings, serde_json::to_vec(&value).unwrap()).unwrap();
    // Uninstall never requires the separately installed CLI to still exist.
    fs::remove_file(&f.source).unwrap();
    options.uninstall = true;
    install(&options, &f).unwrap();
    assert_eq!(
        fs::read_to_string(f.root.join("AGENTS.md")).unwrap(),
        format!("{user}later user content")
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(settings).unwrap()).unwrap(),
        json!({"foreign":{"preserve":true}})
    );
}

#[test]
fn project_conflicts_preserve_edited_duplicate_and_foreign_assets() {
    for fault in [
        "foreign skill",
        "edited skill",
        "edited guidance",
        "duplicate hooks",
    ] {
        let (f, mut options) = fixture(vec![Agent::Claude]);
        let skill = f.root.join(".agents/skills/specgit-native/SKILL.md");
        if fault == "foreign skill" {
            fs::create_dir_all(skill.parent().unwrap()).unwrap();
            fs::write(&skill, "private foreign text").unwrap();
        } else {
            install(&options, &f).unwrap();
            match fault {
                "edited skill" => fs::write(&skill, "private edited text").unwrap(),
                "edited guidance" => {
                    let path = f.root.join("CLAUDE.md");
                    let text = fs::read_to_string(&path).unwrap();
                    fs::write(path, text.replace("SpecGit 2", "edited owned block")).unwrap();
                }
                _ => {
                    let path = f.root.join(".claude/settings.json");
                    let mut value: Value =
                        serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                    let entry = value["hooks"]["SessionStart"][0].clone();
                    value["hooks"]["SessionStart"]
                        .as_array_mut()
                        .unwrap()
                        .push(entry);
                    fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
                }
            }
        }
        options.dry_run = true;
        let before = files(&f.base);
        let error = install(&options, &f).unwrap_err();
        assert_eq!(error.code, Code::OwnershipConflict, "{fault}: {error}");
        assert!(
            !error.message.contains("private edited text"),
            "{fault}: {error}"
        );
        assert!(
            error.message.contains(f.root.to_string_lossy().as_ref()),
            "{fault}: {error}"
        );
        assert!(error.remedy.contains("Restore"), "{fault}: {error}");
        assert_eq!(files(&f.base), before, "{fault}");
    }
}

#[test]
fn codex_override_and_opencode_guidance_remain_independently_discoverable() {
    let (f, mut options) = fixture(vec![Agent::Codex, Agent::Opencode]);
    fs::write(f.root.join("AGENTS.override.md"), "codex user override").unwrap();
    install(&options, &f).unwrap();
    assert!(f.root.join("AGENTS.md").exists());
    assert!(
        fs::read_to_string(f.root.join("AGENTS.override.md"))
            .unwrap()
            .starts_with("codex user override")
    );
    // Default OpenCode selection stays hook-free.
    assert!(!f.root.join(".opencode").exists());
    options.agents.clear();
    assert_eq!(install(&options, &f).unwrap()["transaction"]["changes"], 0);
    options.uninstall = true;
    install(&options, &f).unwrap();
    assert_eq!(
        fs::read_to_string(f.root.join("AGENTS.override.md")).unwrap(),
        "codex user override"
    );
    assert!(!f.root.join("AGENTS.md").exists());
}

#[test]
fn additive_guidance_refresh_detects_new_codex_shadow_in_both_selection_orders() {
    for first in [Agent::Generic, Agent::Codex] {
        let (f, mut options) = fixture(vec![first]);
        install(&options, &f).unwrap();
        options.agents = vec![if first == Agent::Codex {
            Agent::Generic
        } else {
            Agent::Codex
        }];
        install(&options, &f).unwrap();
        options.agents.clear();
        assert_eq!(install(&options, &f).unwrap()["transaction"]["changes"], 0);
        fs::write(f.root.join("AGENTS.override.md"), "private new override").unwrap();
        let before = files(&f.base);
        options.dry_run = true;
        assert_eq!(
            install(&options, &f).unwrap_err().code,
            Code::OwnershipConflict
        );
        assert_eq!(files(&f.base), before);
    }
}

fn cli(root: &Path, args: &[&str]) -> Value {
    let output = executable::command()
        .current_dir(root)
        .args(["setup"])
        .args(args)
        .arg("--json")
        .output()
        .unwrap();
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        output.status.code(),
        value["exit"].as_i64().map(|n| n as i32),
        "{value}"
    );
    value
}

#[test]
fn cli_scope_defaults_to_project_and_still_accepts_the_explicit_scope() {
    let (f, _) = fixture(vec![]);
    let default_scope = cli(&f.root, &["--agent", "opencode", "--dry-run"]);
    assert_eq!(default_scope["ok"], true, "{default_scope}");
    assert_eq!(default_scope["evidence"]["scope"], "project");
    assert!(!f.root.join(".agents").exists());
    let explicit = cli(
        &f.root,
        &["--scope", "project", "--agent", "generic", "--dry-run"],
    );
    assert_eq!(explicit["ok"], true, "{explicit}");
    assert_eq!(explicit["evidence"]["scope"], "project");
}

#[test]
fn cli_linked_worktrees_have_separate_receipts_and_removal_is_local() {
    let (f, _) = fixture(vec![]);
    let root = f.root.clone();
    let other = root.parent().unwrap().join("linked");
    git(
        &root,
        // Git for Windows does not accept Rust's canonical verbatim path here.
        &["worktree", "add", "--detach", "../linked", "HEAD"],
    );
    for checkout in [&root, &other] {
        assert_eq!(
            cli(checkout, &["--agent", "opencode", "--dry-run"])["ok"],
            true
        );
        assert!(!checkout.join(".agents").exists());
        assert_eq!(cli(checkout, &["--agent", "opencode"])["ok"], true);
        let git_dir = PathBuf::from(git(checkout, &["rev-parse", "--absolute-git-dir"]));
        assert!(
            git_dir
                .join("specgit-v2/agent-assets/ownership.json")
                .exists()
        );
    }
    let other_before = files(&other);
    assert_eq!(cli(&root, &["--uninstall"])["ok"], true);
    assert!(!root.join(".agents/skills/specgit-native/SKILL.md").exists());
    assert_eq!(files(&other), other_before);
}

#[test]
fn cli_rejects_ambiguous_or_unsupported_choices_before_writes_and_exports_typed_schema() {
    let (f, _) = fixture(vec![]);
    for args in [
        vec![],
        vec!["--agent", "unknown"],
        vec!["--scope", "unknown"],
        vec!["--scope", "global"],
        vec!["--agent", "claude", "--register-claude"],
        vec!["--agent", "codex", "--agent", "codex"],
        vec!["--agent", "codex", "--codex-root", "unselected-global-path"],
        vec![
            "--agent",
            "opencode",
            "--opencode-claude-hooks",
            "--uninstall",
        ],
        vec!["--agent", "opencode", "--api-host", "github.com"],
        vec!["--agent", "opencode", "--state-root", "x"],
        vec!["--agent", "opencode", "--root", "shared"],
        vec!["--agent", "opencode", "--rollback", "x", "--dry-run"],
    ] {
        let before = files(&f.base);
        assert_eq!(cli(&f.root, &args)["exit"], 2, "{args:?}");
        assert_eq!(files(&f.base), before, "{args:?}");
    }
    let output = executable::command()
        .args(["setup", "--schema"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let text = String::from_utf8(output.stdout).unwrap();
    for value in [
        "scope",
        "project",
        "agent",
        "generic",
        "claude",
        "codex",
        "opencode",
        "opencode-claude-hooks",
    ] {
        assert!(text.contains(value), "{value}");
    }
}

#[cfg(feature = "test-fixtures")]
#[test]
fn unchanged_project_assets_are_revalidated_after_waiting_for_the_private_lock() {
    use std::{
        process::Stdio,
        time::{Duration, Instant},
    };
    for fault in ["content", "removed", "permissions"] {
        #[cfg(not(unix))]
        if fault == "permissions" {
            continue;
        }
        let (f, _) = fixture(vec![]);
        assert_eq!(cli(&f.root, &["--agent", "opencode"])["ok"], true);
        let receipt = fs::read(f.private.join("ownership.json")).unwrap();
        let skill = f.root.join(".agents/skills/specgit-native/SKILL.md");
        let lock = specgit::assets::AssetStore::lock(
            &f.private,
            &[f.root.clone(), f.private.clone()],
            Duration::from_secs(1),
        )
        .unwrap();
        let ready = f.base.join("planned");
        let mut child = Command::new(env!("CARGO_BIN_EXE_specgit"))
            .current_dir(&f.root)
            .args(["setup", "--agent", "claude", "--json"])
            .env("SPECGIT_FIXTURE_SETUP_PLAN_READY", &ready)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !ready.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        if !ready.exists() {
            let _ = child.kill();
            panic!("project setup never finished planning");
        }
        assert!(child.try_wait().unwrap().is_none());
        match fault {
            "content" => fs::write(&skill, "user edit during lock wait").unwrap(),
            "removed" => fs::remove_file(&skill).unwrap(),
            _ => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&skill, fs::Permissions::from_mode(0o640)).unwrap();
                }
            }
        }
        let edited = specgit::assets::Snapshot::read(&skill).unwrap();
        drop(lock);
        let output = child.wait_with_output().unwrap();
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["ok"], false, "{fault}: {result}");
        assert_eq!(
            result["diagnostics"][0]["code"], "concurrent_edit",
            "{fault}: {result}"
        );
        assert_eq!(
            specgit::assets::Snapshot::read(&skill).unwrap().bytes,
            edited.bytes
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                specgit::assets::Snapshot::read(&skill)
                    .unwrap()
                    .permissions
                    .map(|p| p.mode()),
                edited.permissions.map(|p| p.mode())
            );
        }
        assert_eq!(fs::read(f.private.join("ownership.json")).unwrap(), receipt);
        assert!(!f.root.join(".claude").exists());
        assert!(!f.root.join("CLAUDE.md").exists());
    }
}

#[cfg(feature = "test-fixtures")]
#[test]
fn interrupted_project_install_has_recoverable_private_journal_and_no_outside_writes() {
    let (f, _) = fixture(vec![]);
    let source = fs::read(&f.source).unwrap();
    // Fault injection uses the fixture build; recovery uses the installed entrypoint.
    let output = Command::new(env!("CARGO_BIN_EXE_specgit"))
        .current_dir(&f.root)
        .args(["setup", "--agent", "opencode", "--json"])
        .env("SPECGIT_FIXTURE_ASSET_CRASH", "before-write:1")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(99));
    let transaction = fs::read_dir(f.private.join("transactions"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .file_name()
        .into_string()
        .unwrap();
    assert_eq!(cli(&f.root, &["--rollback", &transaction])["ok"], true);
    assert!(
        !f.root
            .join(".agents/skills/specgit-native/SKILL.md")
            .exists()
    );
    assert!(!f.root.join("AGENTS.md").exists());
    assert!(!f.private.join("ownership.json").exists());
    assert_eq!(fs::read(&f.source).unwrap(), source);
}
