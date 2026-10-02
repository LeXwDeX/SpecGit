use serde_json::{Value, json};
use specgit::{
    diagnostic::Code,
    setup::{self, Agent, project},
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
#[path = "support/executable.rs"]
mod executable;

fn files(root: &Path) -> std::collections::BTreeMap<PathBuf, Vec<u8>> {
    let mut result = std::collections::BTreeMap::new();
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

fn fixture(agents: Vec<Agent>) -> (tempfile::TempDir, project::Options, PathBuf, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let root = base.join("checkout");
    let private = base.join("private/agent-assets");
    fs::create_dir(&root).unwrap();
    let shared = base.join("shared");
    setup::install(
        &setup::Options {
            root: shared.clone(),
            provider: None,
            api_host: None,
            claude_settings: None,
            host_roots: Default::default(),
            uninstall: false,
            dry_run: false,
            rollback: None,
        },
        &executable::binary().canonicalize().unwrap(),
    )
    .unwrap();
    (
        temp,
        project::Options {
            shared_root: shared,
            agents,
            uninstall: false,
            dry_run: false,
            rollback: None,
        },
        root,
        private,
    )
}

#[test]
fn selected_agents_are_isolated_and_project_never_installs_a_binary() {
    for agent in [Agent::Generic, Agent::Claude, Agent::Codex, Agent::Opencode] {
        let (temp, mut options, root, private) = fixture(vec![agent]);
        let shared = files(&options.shared_root);
        let before = files(temp.path());
        options.dry_run = true;
        let preview = project::install(&options, &root, &private).unwrap();
        assert_eq!(preview["scope"], "project");
        assert_eq!(files(temp.path()), before);
        assert!(!private.exists());
        options.dry_run = false;
        let result = project::install(&options, &root, &private).unwrap();
        assert_eq!(result["registration"], "written_not_verified");
        assert_eq!(result["host_delivery"]["imported_event"], "not_checked");
        assert!(root.join(".agents/skills/specgit-native/SKILL.md").exists());
        assert_eq!(
            root.join(".claude/skills/specgit-native/SKILL.md").exists(),
            agent == Agent::Claude
        );
        assert_eq!(
            root.join(".claude/settings.json").exists(),
            agent == Agent::Claude
        );
        assert_eq!(
            root.join(".codex/hooks.json").exists(),
            agent == Agent::Codex
        );
        assert!(!root.join(".opencode").exists());
        assert!(!root.join("versions").exists());
        for relative in [".claude/settings.json", ".codex/hooks.json"] {
            if root.join(relative).exists() {
                let hooks: Value =
                    serde_json::from_slice(&fs::read(root.join(relative)).unwrap()).unwrap();
                let command = PathBuf::from(
                    hooks["hooks"]["SessionStart"][0]["hooks"][0]["command"]
                        .as_str()
                        .unwrap(),
                );
                assert!(command.starts_with(&options.shared_root));
                assert!(!command.starts_with(&root));
            }
        }
        options.agents.clear();
        assert_eq!(
            project::install(&options, &root, &private).unwrap()["transaction"]["changes"],
            0
        );
        let installed = files(temp.path());
        options.uninstall = true;
        options.dry_run = true;
        project::install(&options, &root, &private).unwrap();
        assert_eq!(files(temp.path()), installed);
        options.dry_run = false;
        project::install(&options, &root, &private).unwrap();
        assert!(files(&root).is_empty());
        assert!(!private.join("ownership.json").exists());
        assert_eq!(files(&options.shared_root), shared);
    }
}

#[test]
fn additive_selection_coowns_guidance_once_and_preserves_init_and_user_content() {
    let (_temp, mut options, root, private) = fixture(vec![Agent::Generic]);
    let user = "user guidance\r\n<!-- specgit:v2:start -->\ninit block\n<!-- specgit:v2:end -->\n";
    fs::write(root.join("AGENTS.md"), user).unwrap();
    project::install(&options, &root, &private).unwrap();
    options.agents = vec![Agent::Codex, Agent::Opencode, Agent::Claude];
    project::install(&options, &root, &private).unwrap();
    let guidance = fs::read_to_string(root.join("AGENTS.md")).unwrap();
    assert_eq!(
        guidance.matches("<!-- specgit:global:v2:start -->").count(),
        1
    );
    options.agents.clear();
    assert_eq!(
        project::install(&options, &root, &private).unwrap()["transaction"]["changes"],
        0
    );
    fs::write(
        root.join("AGENTS.md"),
        format!("{guidance}later user content"),
    )
    .unwrap();
    let settings = root.join(".claude/settings.json");
    let mut value: Value = serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
    value["foreign"] = json!({"preserve":true});
    fs::write(&settings, serde_json::to_vec(&value).unwrap()).unwrap();
    // Uninstall does not require the shared executable to still exist.
    fs::remove_file(options.shared_root.join(format!(
        "versions/{}/bin/specgit{}",
        env!("CARGO_PKG_VERSION"),
        if cfg!(windows) { ".exe" } else { "" }
    )))
    .unwrap();
    options.uninstall = true;
    project::install(&options, &root, &private).unwrap();
    assert_eq!(
        fs::read_to_string(root.join("AGENTS.md")).unwrap(),
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
        let (temp, mut options, root, private) = fixture(vec![Agent::Claude]);
        let skill = root.join(".agents/skills/specgit-native/SKILL.md");
        if fault == "foreign skill" {
            fs::create_dir_all(skill.parent().unwrap()).unwrap();
            fs::write(&skill, "private foreign text").unwrap();
        } else {
            project::install(&options, &root, &private).unwrap();
            match fault {
                "edited skill" => fs::write(&skill, "private edited text").unwrap(),
                "edited guidance" => {
                    let path = root.join("CLAUDE.md");
                    let text = fs::read_to_string(&path).unwrap();
                    fs::write(path, text.replace("SpecGit 2", "edited owned block")).unwrap();
                }
                _ => {
                    let path = root.join(".claude/settings.json");
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
        let before = files(temp.path());
        let error = project::install(&options, &root, &private).unwrap_err();
        assert_eq!(error.code, Code::OwnershipConflict, "{fault}: {error}");
        assert!(!error.message.contains("private edited text"));
        assert_eq!(files(temp.path()), before);
    }
}

#[test]
fn shared_binary_requires_owned_hash_execute_permission_and_external_root() {
    for fault in [
        "edited",
        "missing receipt",
        "project root",
        "execute permission",
    ] {
        let (temp, mut options, root, private) = fixture(vec![Agent::Codex]);
        let binary = options.shared_root.join(format!(
            "versions/{}/bin/specgit{}",
            env!("CARGO_PKG_VERSION"),
            if cfg!(windows) { ".exe" } else { "" }
        ));
        match fault {
            "edited" => fs::write(binary, b"unowned").unwrap(),
            "missing receipt" => {
                fs::remove_file(options.shared_root.join("ownership.json")).unwrap()
            }
            "project root" => options.shared_root = root.join("shared"),
            _ => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(binary, fs::Permissions::from_mode(0o600)).unwrap();
                }
                #[cfg(not(unix))]
                {
                    continue;
                }
            }
        }
        let before = files(temp.path());
        assert!(
            project::install(&options, &root, &private).is_err(),
            "{fault}"
        );
        assert_eq!(files(temp.path()), before);
        assert!(!private.exists());
    }
}

#[test]
fn codex_override_and_opencode_guidance_remain_independently_discoverable() {
    let (_temp, mut options, root, private) = fixture(vec![Agent::Codex, Agent::Opencode]);
    fs::write(root.join("AGENTS.override.md"), "codex user override").unwrap();
    project::install(&options, &root, &private).unwrap();
    assert!(root.join("AGENTS.md").exists());
    assert!(
        fs::read_to_string(root.join("AGENTS.override.md"))
            .unwrap()
            .starts_with("codex user override")
    );
    options.agents.clear();
    assert_eq!(
        project::install(&options, &root, &private).unwrap()["transaction"]["changes"],
        0
    );
    options.uninstall = true;
    project::install(&options, &root, &private).unwrap();
    assert_eq!(
        fs::read_to_string(root.join("AGENTS.override.md")).unwrap(),
        "codex user override"
    );
    assert!(!root.join("AGENTS.md").exists());
}

#[test]
fn additive_guidance_refresh_detects_new_codex_shadow_in_both_selection_orders() {
    for first in [Agent::Generic, Agent::Codex] {
        let (temp, mut options, root, private) = fixture(vec![first]);
        project::install(&options, &root, &private).unwrap();
        options.agents = vec![if first == Agent::Codex {
            Agent::Generic
        } else {
            Agent::Codex
        }];
        project::install(&options, &root, &private).unwrap();
        options.agents.clear();
        assert_eq!(
            project::install(&options, &root, &private).unwrap()["transaction"]["changes"],
            0
        );
        fs::write(root.join("AGENTS.override.md"), "private new override").unwrap();
        let before = files(temp.path());
        options.dry_run = true;
        assert_eq!(
            project::install(&options, &root, &private)
                .unwrap_err()
                .code,
            Code::OwnershipConflict
        );
        assert_eq!(files(temp.path()), before);
    }
}

#[test]
fn explicit_global_agent_selection_accepts_legacy_custom_paths_without_guessing() {
    for agent in ["generic", "claude", "codex", "opencode"] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let run = |extra: &[&str]| {
            let mut command = executable::command();
            command
                .current_dir(&root)
                .env("HOME", &root)
                .env("USERPROFILE", &root)
                .env("CODEX_HOME", root.join("codex"))
                .env("XDG_CONFIG_HOME", root.join("config"))
                .env("PATH", &root)
                .args([
                    "setup",
                    "--scope",
                    "global",
                    "--provider",
                    "github",
                    "--agent",
                    agent,
                    "--json",
                    "--root",
                ])
                .arg(root.join("shared"));
            let path = root.join("host");
            if agent != "generic" {
                command
                    .arg(match agent {
                        "claude" => "--claude-settings",
                        "codex" => "--codex-root",
                        _ => "--opencode-root",
                    })
                    .arg(if agent == "claude" {
                        path.join("settings.json")
                    } else {
                        path.clone()
                    });
            }
            let output = command.args(extra).output().unwrap();
            let value: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(
                output.status.code(),
                Some(if extra.contains(&"--uninstall") { 0 } else { 3 }),
                "{value}"
            );
            value
        };
        assert_eq!(run(&["--dry-run"])["evidence"]["scope"], "global");
        assert!(!root.join("shared").exists());
        let installed = run(&[]);
        assert_eq!(installed["evidence"]["agents"], json!([agent]));
        assert_eq!(run(&[])["evidence"]["transaction"]["changes"], 0);
        let skill = if agent == "generic" {
            root.join(".agents/skills/specgit-native/SKILL.md")
        } else {
            root.join("host/skills/specgit-native/SKILL.md")
        };
        assert!(skill.exists());
        run(&["--uninstall"]);
        assert!(!skill.exists());
    }
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
fn cli(root: &Path, shared: &Path, args: &[&str]) -> Value {
    let output = executable::command()
        .current_dir(root)
        .args(["setup", "--scope", "project", "--json", "--root"])
        .arg(shared)
        .args(args)
        .output()
        .unwrap();
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        output.status.code(),
        value["exit"].as_i64().map(|n| n as i32)
    );
    value
}

#[test]
fn cli_linked_worktrees_have_separate_receipts_and_removal_is_local() {
    let (_temp, options, root, _) = fixture(vec![]);
    git(&root, &["init"]);
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
    let other = root.parent().unwrap().join("linked");
    git(
        &root,
        // Git for Windows does not accept Rust's canonical verbatim path here.
        &["worktree", "add", "--detach", "../linked", "HEAD"],
    );
    for checkout in [&root, &other] {
        assert_eq!(
            cli(
                checkout,
                &options.shared_root,
                &["--agent", "opencode", "--dry-run"]
            )["ok"],
            true
        );
        assert!(!checkout.join(".agents").exists());
        assert_eq!(
            cli(checkout, &options.shared_root, &["--agent", "opencode"])["ok"],
            true
        );
        let git_dir = PathBuf::from(git(checkout, &["rev-parse", "--absolute-git-dir"]));
        assert!(
            git_dir
                .join("specgit-v2/agent-assets/ownership.json")
                .exists()
        );
    }
    let other_before = files(&other);
    let shared_before = files(&options.shared_root);
    assert_eq!(
        cli(&root, &options.shared_root, &["--uninstall"])["ok"],
        true
    );
    assert!(!root.join(".agents/skills/specgit-native/SKILL.md").exists());
    assert_eq!(files(&other), other_before);
    assert_eq!(files(&options.shared_root), shared_before);
}

#[test]
fn cli_rejects_ambiguous_or_unsupported_choices_before_writes_and_exports_typed_schema() {
    let (temp, options, root, _) = fixture(vec![]);
    git(&root, &["init"]);
    for args in [
        vec![],
        vec!["--agent", "unknown"],
        vec!["--scope", "unknown"],
        vec!["--agent", "claude", "--register-claude"],
        vec!["--agent", "codex", "--agent", "codex"],
        vec!["--register-codex", "--codex-root", "unselected-global-path"],
        vec!["--agent", "opencode", "--api-host", "github.com"],
    ] {
        let before = files(temp.path());
        assert_eq!(
            cli(&root, &options.shared_root, &args)["exit"],
            2,
            "{args:?}"
        );
        assert_eq!(files(temp.path()), before);
    }
    let output = executable::command()
        .args(["setup", "--schema"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let text = String::from_utf8(output.stdout).unwrap();
    for value in [
        "scope", "global", "project", "agent", "generic", "claude", "codex", "opencode",
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
        let (temp, options, root, _) = fixture(vec![]);
        git(&root, &["init"]);
        assert_eq!(
            cli(&root, &options.shared_root, &["--agent", "opencode"])["ok"],
            true
        );
        let private = PathBuf::from(git(&root, &["rev-parse", "--absolute-git-dir"]))
            .join("specgit-v2/agent-assets");
        let receipt = fs::read(private.join("ownership.json")).unwrap();
        let skill = root.join(".agents/skills/specgit-native/SKILL.md");
        let lock = specgit::assets::AssetStore::lock(
            &private,
            &[root.clone(), private.clone()],
            Duration::from_secs(1),
        )
        .unwrap();
        let ready = temp.path().canonicalize().unwrap().join("planned");
        let mut child = Command::new(env!("CARGO_BIN_EXE_specgit"))
            .current_dir(&root)
            .args([
                "setup", "--scope", "project", "--agent", "claude", "--json", "--root",
            ])
            .arg(&options.shared_root)
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
        assert_eq!(fs::read(private.join("ownership.json")).unwrap(), receipt);
        assert!(!root.join(".claude").exists());
        assert!(!root.join("CLAUDE.md").exists());
    }
}

#[cfg(feature = "test-fixtures")]
#[test]
fn interrupted_project_install_has_recoverable_private_journal_and_no_global_writes() {
    let (_temp, options, root, _) = fixture(vec![]);
    git(&root, &["init"]);
    let shared_before = files(&options.shared_root);
    // Fault injection uses the fixture build; recovery uses the installed entrypoint.
    let output = Command::new(env!("CARGO_BIN_EXE_specgit"))
        .current_dir(&root)
        .args([
            "setup", "--scope", "project", "--agent", "opencode", "--root",
        ])
        .arg(&options.shared_root)
        .env("SPECGIT_FIXTURE_ASSET_CRASH", "before-write:1")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(99));
    let private = PathBuf::from(git(&root, &["rev-parse", "--absolute-git-dir"]))
        .join("specgit-v2/agent-assets");
    let transaction = fs::read_dir(private.join("transactions"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .file_name()
        .into_string()
        .unwrap();
    assert_eq!(
        cli(&root, &options.shared_root, &["--rollback", &transaction])["ok"],
        true
    );
    assert!(!root.join(".agents/skills/specgit-native/SKILL.md").exists());
    assert!(!root.join("AGENTS.md").exists());
    assert!(!private.join("ownership.json").exists());
    assert_eq!(files(&options.shared_root), shared_before);
}

#[test]
fn global_generic_skill_and_prior_v2_receipt_survive_refresh_and_uninstall() {
    let (_temp, options, root, _) = fixture(vec![]);
    let receipt_path = options.shared_root.join("ownership.json");
    let mut receipt: Value = serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
    receipt.as_object_mut().unwrap().remove("hosts");
    receipt.as_object_mut().unwrap().remove("host_hooks");
    fs::write(&receipt_path, serde_json::to_vec(&receipt).unwrap()).unwrap();
    let mut global = setup::Options {
        root: options.shared_root.clone(),
        provider: None,
        api_host: None,
        claude_settings: None,
        host_roots: [("generic".into(), root.join("global-agents"))].into(),
        uninstall: false,
        dry_run: false,
        rollback: None,
    };
    let binary = executable::binary().canonicalize().unwrap();
    setup::install(&global, &binary).unwrap();
    assert!(
        root.join("global-agents/skills/specgit-native/SKILL.md")
            .exists()
    );
    assert!(!root.join("global-agents/AGENTS.md").exists());
    global.host_roots.clear();
    assert_eq!(
        setup::install(&global, &binary).unwrap()["transaction"]["changes"],
        0
    );
    global.uninstall = true;
    setup::install(&global, &binary).unwrap();
    assert!(
        !root
            .join("global-agents/skills/specgit-native/SKILL.md")
            .exists()
    );
}
