//! Setup command surface. Global setup is permanently removed: every retired
//! global flag is rejected before any write, and the value coverage that the
//! global era proved (foreign settings fields, permissions, duplicate hook
//! entries, conflict diagnostics, dry-run, rollback) is preserved at project
//! scope. The project setup core contract lives in tests/setup_project.rs.
use serde_json::{Value, json};
use specgit::{
    diagnostic::{Code, Diagnostic},
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

fn fixture() -> Fixture {
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
    Fixture {
        _temp: temp,
        base,
        root,
        private,
        source,
    }
}

fn options(agents: Vec<Agent>) -> project::Options {
    project::Options {
        agents,
        opencode_claude_hooks: false,
        uninstall: false,
        dry_run: false,
        rollback: None,
    }
}

fn install(options: &project::Options, f: &Fixture) -> Result<Value, Diagnostic> {
    project::install(options, &f.root, &f.private, &f.source)
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
fn removed_global_setup_surface_is_rejected_without_writes() {
    for args in [
        vec!["--scope", "global", "--agent", "generic"],
        vec!["global"],
        vec!["--provider", "github", "--agent", "claude"],
        vec!["--register-codex"],
        vec!["--register-opencode"],
        vec!["--register-claude"],
        vec!["--agent", "codex", "--codex-root", "x"],
        vec!["--agent", "opencode", "--opencode-root", "x"],
        vec!["--agent", "claude", "--claude-settings", "x"],
        vec!["--agent", "claude", "--root", "x"],
        vec!["--agent", "claude", "--api-host", "forge.example"],
        vec!["--agent", "claude", "--state-root", "x"],
        vec!["--agent", "claude", "--dry-run", "--rollback", "x"],
        vec!["--uninstall", "--rollback", "x"],
    ] {
        let f = fixture();
        let before = files(&f.base);
        let report = cli(&f.root, &args);
        assert_eq!(report["ok"], false, "{args:?}: {report}");
        assert_eq!(report["exit"], 2, "{args:?}: {report}");
        if args.contains(&"global") {
            assert!(
                report["diagnostics"][0]["message"]
                    .as_str()
                    .unwrap()
                    .contains("permanently project-only"),
                "{args:?}: {report}"
            );
        }
        assert_eq!(files(&f.base), before, "{args:?}");
        for created in [
            ".agents",
            ".claude",
            ".codex",
            ".opencode",
            "AGENTS.md",
            "AGENTS.override.md",
            "CLAUDE.md",
        ] {
            assert!(!f.root.join(created).exists(), "{args:?}: {created}");
        }
        assert!(
            !f.private.join("agent-assets/ownership.json").exists(),
            "{args:?}"
        );
    }
}

#[test]
fn project_scope_is_the_permanent_default_for_setup() {
    let f = fixture();
    let installed = cli(&f.root, &["--agent", "opencode"]);
    assert_eq!(installed["ok"], true, "{installed}");
    assert_eq!(installed["status"], "installed");
    assert_eq!(installed["evidence"]["scope"], "project");
    assert!(
        f.root
            .join(".agents/skills/specgit-native/SKILL.md")
            .exists()
    );
    // Default OpenCode selection registers no hooks.
    assert!(!f.root.join(".opencode").exists());
    let f = fixture();
    let explicit = cli(&f.root, &["--scope", "project", "--agent", "generic"]);
    assert_eq!(explicit["ok"], true, "{explicit}");
    assert_eq!(explicit["evidence"]["scope"], "project");
    for mode in ["--schema", "--help"] {
        let output = executable::command()
            .args(["setup", mode])
            .output()
            .unwrap();
        assert!(output.status.success(), "{mode}");
    }
}

#[test]
fn claude_registration_preserves_foreign_fields_permissions_and_user_entries() {
    let f = fixture();
    let settings = f.root.join(".claude/settings.json");
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    let foreign =
        json!({"matcher":"Bash","hooks":[{"type":"command","command":"echo foreign","unknown":7}]});
    let original =
        json!({"unknown":{"array":[1,true,null]},"hooks":{"PreToolUse":[foreign.clone()]}});
    fs::write(&settings, serde_json::to_vec(&original).unwrap()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&settings, fs::Permissions::from_mode(0o640)).unwrap();
    }
    let first = install(&options(vec![Agent::Claude]), &f).unwrap();
    assert_eq!(first["registration"], "written_not_verified");
    assert_eq!(first["host_delivery"]["imported_event"], "not_checked");
    let before = fs::read(&settings).unwrap();
    let mut refresh = options(vec![]);
    assert_eq!(install(&refresh, &f).unwrap()["transaction"]["changes"], 0);
    assert_eq!(fs::read(&settings).unwrap(), before);
    let mut user: Value = serde_json::from_slice(&before).unwrap();
    user["hooks"]["PreToolUse"]
        .as_array_mut()
        .unwrap()
        .push(json!({"matcher":"Edit","hooks":[{"type":"command","command":"echo user-added"}]}));
    fs::write(&settings, serde_json::to_vec(&user).unwrap()).unwrap();
    install(&refresh, &f).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(&settings).unwrap()).unwrap(),
        user
    );
    refresh.uninstall = true;
    install(&refresh, &f).unwrap();
    let after: Value = serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
    assert_eq!(after["unknown"], original["unknown"]);
    assert_eq!(after["hooks"]["PreToolUse"].as_array().unwrap().len(), 2);
    assert_eq!(after["hooks"]["PreToolUse"][0], foreign);
    assert!(!f.private.join("ownership.json").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&settings).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }
}

#[test]
fn registered_choice_survives_refresh_and_empty_foreign_keys_survive_uninstall() {
    let f = fixture();
    let settings = f.root.join(".claude/settings.json");
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    let initial = json!({"hooks":{"SessionStart":[]},"unknown":[]});
    fs::write(&settings, serde_json::to_vec(&initial).unwrap()).unwrap();
    install(&options(vec![Agent::Claude]), &f).unwrap();
    let mut refresh = options(vec![]);
    let r = install(&refresh, &f).unwrap();
    assert_eq!(r["registration"], "written_not_verified");
    assert_eq!(r["transaction"]["changes"], 0);
    refresh.uninstall = true;
    install(&refresh, &f).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(&settings).unwrap()).unwrap(),
        initial
    );
    // A created settings file is removed again when uninstall leaves it empty.
    let f = fixture();
    let settings = f.root.join(".claude/settings.json");
    install(&options(vec![Agent::Claude]), &f).unwrap();
    assert!(settings.exists());
    let mut uninstall = options(vec![]);
    uninstall.uninstall = true;
    install(&uninstall, &f).unwrap();
    assert!(!settings.exists());
}

#[test]
fn hook_entry_conflicts_name_host_asset_and_event_without_private_payloads() {
    for fault in ["missing event", "edited", "duplicated"] {
        let f = fixture();
        install(&options(vec![Agent::Claude]), &f).unwrap();
        let settings = f.root.join(".claude/settings.json");
        let mut value: Value = serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
        let event = "SessionStart";
        match fault {
            "missing event" => {
                value["hooks"].as_object_mut().unwrap().remove(event);
            }
            "edited" => {
                value["hooks"][event][0]["hooks"][0]["command"] = json!("private-hook-command");
            }
            _ => {
                let entry = value["hooks"][event][0].clone();
                value["hooks"][event].as_array_mut().unwrap().push(entry);
            }
        }
        fs::write(&settings, serde_json::to_vec(&value).unwrap()).unwrap();
        let before = files(&f.base);
        let error = install(&options(vec![]), &f).unwrap_err();
        assert_eq!(error.code, Code::OwnershipConflict, "{fault}: {error}");
        assert_eq!(error.exit(), 3);
        assert!(error.message.contains("claude"), "{fault}: {error}");
        assert!(
            error
                .message
                .contains(&serde_json::to_string(&settings.canonicalize().unwrap()).unwrap()),
            "{fault}: {error}"
        );
        assert!(error.message.contains(event), "{fault}: {error}");
        assert!(
            error.message.contains(if fault == "duplicated" {
                "duplicated"
            } else if fault == "edited" {
                "edited"
            } else {
                "missing"
            }),
            "{fault}: {error}"
        );
        assert!(
            !error.message.contains("private-hook-command"),
            "{fault}: {error}"
        );
        assert!(!error.message.contains("--state-root"), "{fault}: {error}");
        assert_eq!(files(&f.base), before, "{fault}");
    }
}

#[test]
fn malformed_host_settings_are_rejected_without_writes() {
    let f = fixture();
    let settings = f.root.join(".claude/settings.json");
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    let invalid = b"{\"unknown\":1,\"unknown\":2}";
    fs::write(&settings, invalid).unwrap();
    let before = files(&f.base);
    assert!(install(&options(vec![Agent::Claude]), &f).is_err());
    assert_eq!(fs::read(&settings).unwrap(), invalid);
    assert_eq!(files(&f.base), before);
    assert!(!f.private.join("ownership.json").exists());
}

#[test]
fn dry_run_previews_without_taking_the_private_lock_or_writing() {
    let f = fixture();
    install(&options(vec![Agent::Claude]), &f).unwrap();
    let lock = specgit::assets::AssetStore::lock(
        &f.private,
        &[f.root.clone(), f.private.clone()],
        std::time::Duration::from_secs(1),
    )
    .unwrap();
    let mut preview = options(vec![]);
    preview.dry_run = true;
    let before = files(&f.base);
    assert_eq!(install(&preview, &f).unwrap()["written"], false);
    assert_eq!(files(&f.base), before);
    drop(lock);
}

#[test]
fn rollback_rejects_conflicting_choices_and_restores_the_recorded_state() {
    let f = fixture();
    let mut conflicting = options(vec![Agent::Claude]);
    conflicting.rollback = Some("uninspected".into());
    let error = install(&conflicting, &f).unwrap_err();
    assert_eq!(error.code, Code::InvalidInput, "{error}");
    let mut flags = options(vec![]);
    flags.opencode_claude_hooks = true;
    flags.rollback = Some("uninspected".into());
    assert_eq!(install(&flags, &f).unwrap_err().code, Code::InvalidInput);
    let mut dry = options(vec![]);
    dry.dry_run = true;
    dry.rollback = Some("uninspected".into());
    assert_eq!(install(&dry, &f).unwrap_err().code, Code::InvalidInput);
    let mut removed = options(vec![]);
    removed.uninstall = true;
    removed.rollback = Some("uninspected".into());
    assert_eq!(install(&removed, &f).unwrap_err().code, Code::InvalidInput);
    assert!(!f.private.join("ownership.json").exists());

    // A recorded uninstall transaction rolls back to the installed state.
    install(&options(vec![Agent::Claude]), &f).unwrap();
    let installed = files(&f.root);
    let removed = install(&removed_set(), &f).unwrap();
    let id = removed["transaction"]["transaction"].as_str().unwrap();
    assert!(!f.private.join("ownership.json").exists());
    let mut rollback = options(vec![]);
    rollback.rollback = Some(id.into());
    let rolled = install(&rollback, &f).unwrap();
    assert_eq!(rolled["scope"], "project");
    // Owned checkout assets are restored byte-identically; the rollback
    // transaction's own journal files are AssetStore mechanics covered elsewhere.
    let journal = |path: &Path| path.components().any(|c| c.as_os_str() == "transactions");
    let installed: BTreeMap<_, _> = installed
        .into_iter()
        .filter(|(path, _)| !journal(path))
        .collect();
    let after: BTreeMap<_, _> = files(&f.root)
        .into_iter()
        .filter(|(path, _)| !journal(path))
        .collect();
    assert_eq!(after, installed);
    assert!(f.private.join("ownership.json").exists());
}

fn removed_set() -> project::Options {
    let mut options = options(vec![]);
    options.uninstall = true;
    options
}
