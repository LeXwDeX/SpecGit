//! Project setup contract: worktree-owned receipts, the separately installed
//! shared CLI as an external executable fixture, and CLI input rejections.
//! Global setup is removed permanently; see tests/setup.rs for reject-global
//! command coverage.
use serde_json::{Value, json};
use specgit::process::Process;
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

fn selection(purposes: &[specgit::setup::HookPurpose], wake: bool) -> specgit::setup::HookOptions {
    specgit::setup::HookOptions {
        purposes: purposes.to_vec(),
        opencode_async_rewake: wake,
    }
}

fn install_with_hooks(
    options: &project::Options,
    hooks: &specgit::setup::HookOptions,
    root: &Path,
    private: &Path,
    source: &Path,
) -> Result<Value, specgit::diagnostic::Diagnostic> {
    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(project::install_with_context(
            options,
            hooks,
            root,
            private,
            source,
            &Process::default(),
        ))
}

fn health_plan(
    root: &Path,
    private: &Path,
    source: &Path,
) -> Result<Option<specgit::assets::MaintenancePlan>, specgit::diagnostic::Diagnostic> {
    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(project::health_plan_with_context(
            &Process::default(),
            root,
            private,
            source,
        ))
}

#[test]
fn setup_report_schema_validates_real_selection_and_rejects_false_claims() {
    use specgit::{report::Report, setup::HookPurpose::*};
    let schema: Value =
        serde_json::from_str(include_str!("../schemas/report.schema.json")).unwrap();
    let report = |evidence: Value| {
        let status = if evidence.get("rolled_back").is_some() {
            "rolled_back"
        } else if evidence["written"] == false {
            "dry_run"
        } else {
            "installed"
        };
        serde_json::to_value(Report::success("setup", status, evidence)).unwrap()
    };
    let validate = |value: &Value| jsonschema::draft202012::validate(&schema, value).is_ok();
    let (f, mut options) = fixture(vec![Agent::Opencode, Agent::Generic]);
    options.opencode_claude_hooks = true;
    let hooks = selection(&[Context, Observe], false);
    options.dry_run = true;
    let preview =
        report(install_with_hooks(&options, &hooks, &f.root, &f.private, &f.source).unwrap());
    assert!(validate(&preview), "{preview}");
    assert_eq!(
        preview["evidence"]["hook_purposes"]["opencode"]["declined"][0]["status"],
        "unsupported"
    );
    assert_eq!(
        preview["evidence"]["hook_purposes"]["generic"]["declined"][0]["status"],
        "unsupported"
    );
    options.dry_run = false;
    let installed = report(
        install_with_hooks(
            &options,
            &selection(&[Context, Observe], true),
            &f.root,
            &f.private,
            &f.source,
        )
        .unwrap(),
    );
    assert!(validate(&installed), "{installed}");
    assert_eq!(
        installed["evidence"]["host_delivery"]["idle_wake"],
        "not_supported"
    );
    for (pointer, value) in [
        (
            "/evidence/hook_purposes/opencode/requested/0",
            json!("invalid"),
        ),
        (
            "/evidence/hook_purposes/opencode/installed/0",
            json!("none"),
        ),
        (
            "/evidence/hook_purposes/opencode/declined/0/status",
            json!("supported"),
        ),
        (
            "/evidence/hook_purposes/opencode/declined/0/purpose",
            json!("none"),
        ),
        (
            "/evidence/hook_purposes/opencode/declined/0/reason",
            json!(""),
        ),
        (
            "/evidence/hook_purposes/opencode/declined/0/reason",
            json!(false),
        ),
        ("/evidence/host_delivery/idle_wake", json!("observed")),
        (
            "/evidence/host_delivery/context_injection",
            json!("verified"),
        ),
    ] {
        let mut invalid = preview.clone();
        *invalid.pointer_mut(pointer).unwrap() = value;
        assert!(
            !validate(&invalid),
            "schema accepted invalid claim at {pointer}: {invalid}"
        );
    }
    let mut invalid = preview.clone();
    invalid["evidence"]["hook_purposes"]["unknown_host"] =
        invalid["evidence"]["hook_purposes"]["opencode"].clone();
    assert!(!validate(&invalid));
    let mut invalid = preview.clone();
    invalid["evidence"]["hook_purposes"]["opencode"]["declined"][0]
        .as_object_mut()
        .unwrap()
        .remove("reason");
    assert!(!validate(&invalid));

    let transaction = installed["evidence"]["transaction"]["transaction"]
        .as_str()
        .unwrap();
    let rolled_back = cli(&f.root, &["--rollback", transaction]);
    assert!(validate(&rolled_back));
    let error = install_with_hooks(
        &options,
        &selection(&[None, Guard], false),
        &f.root,
        &f.private,
        &f.source,
    )
    .unwrap_err();
    assert!(validate(
        &serde_json::to_value(Report::failure("setup", error)).unwrap()
    ));
    let no_hooks = report(
        install_with_hooks(
            &options,
            &selection(&[None], false),
            &f.root,
            &f.private,
            &f.source,
        )
        .unwrap(),
    );
    assert!(validate(&no_hooks));
}

#[test]
fn selective_context_none_refresh_and_existing_guard_preservation() {
    use specgit::setup::HookPurpose::*;
    let (f, options) = fixture(vec![Agent::Claude]);
    let install = |hooks: &specgit::setup::HookOptions| {
        install_with_hooks(&options, hooks, &f.root, &f.private, &f.source).unwrap()
    };
    install(&selection(&[Context], false));
    let settings = f.root.join(".claude/settings.json");
    let value: Value = serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
    assert_eq!(value["hooks"].as_object().unwrap().len(), 2);
    assert!(value["hooks"].get("PostToolUse").is_none());
    assert_eq!(value["hooks"]["PreToolUse"][0]["matcher"], "*");
    install(&selection(&[Guard], false));
    let before = fs::read(&settings).unwrap();
    let evidence = install(&selection(&[None], false));
    assert_eq!(
        evidence["hook_purposes"]["claude"]["installed"],
        json!(["guard", "context"])
    );
    assert_eq!(before, fs::read(&settings).unwrap());
    install_with_hooks(
        &options,
        &specgit::setup::HookOptions::default(),
        &f.root,
        &f.private,
        &f.source,
    )
    .unwrap();
    assert_eq!(before, fs::read(&settings).unwrap());
    let mut uninstall = options.clone();
    uninstall.agents.clear();
    uninstall.uninstall = true;
    install_with_hooks(
        &uninstall,
        &specgit::setup::HookOptions::default(),
        &f.root,
        &f.private,
        &f.source,
    )
    .unwrap();
    assert!(!settings.exists());

    let (f, options) = fixture(vec![Agent::Claude]);
    fs::remove_file(&f.source).unwrap();
    install_with_hooks(
        &options,
        &selection(&[None], false),
        &f.root,
        &f.private,
        &f.source,
    )
    .unwrap();
    install_with_hooks(
        &options,
        &specgit::setup::HookOptions::default(),
        &f.root,
        &f.private,
        &f.source,
    )
    .unwrap();
    assert!(!f.root.join(".claude/settings.json").exists());
}

#[test]
fn custom_observation_requires_explicit_capability_and_preserves_wake() {
    use specgit::setup::HookPurpose::*;
    let (mut f, mut options) = fixture(vec![Agent::Opencode]);
    let quoted_source = f.base.join("shared cli's binary");
    fs::rename(&f.source, &quoted_source).unwrap();
    f.source = quoted_source;
    options.opencode_claude_hooks = true;
    let unknown = install_with_hooks(
        &options,
        &selection(&[Context, Observe], false),
        &f.root,
        &f.private,
        &f.source,
    )
    .unwrap();
    assert_eq!(
        unknown["hook_purposes"]["opencode"]["declined"][0]["status"],
        "unsupported"
    );
    let settings = f.root.join(".opencode/hooks.json");
    let value: Value = serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
    assert!(value.get("Stop").is_none());
    let evidence = install_with_hooks(
        &options,
        &selection(&[Guard, Observe], true),
        &f.root,
        &f.private,
        &f.source,
    )
    .unwrap();
    assert_eq!(evidence["host_delivery"]["idle_wake"], "not_supported");
    let bytes = fs::read(&settings).unwrap();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert!(value.get("Stop").is_none());
    assert!(value.get("SessionStart").is_some());
    assert!(value.get("PreToolUse").is_some());
    options.opencode_claude_hooks = false;
    install(&options, &f).unwrap();
    assert_eq!(bytes, fs::read(&settings).unwrap());
    fs::write(&settings, b"{\"manual\":true}").unwrap();
    assert!(install(&options, &f).is_err());
    assert_eq!(fs::read(&settings).unwrap(), b"{\"manual\":true}");
}

#[test]
fn selection_rejects_invalid_combinations_without_writes() {
    use specgit::setup::HookPurpose::*;
    let (f, options) = fixture(vec![Agent::Claude]);
    let before = files(&f.root);
    for hooks in [
        selection(&[None, Guard], false),
        selection(&[Guard, Guard], false),
    ] {
        assert!(install_with_hooks(&options, &hooks, &f.root, &f.private, &f.source).is_err());
    }
    assert_eq!(before, files(&f.root));
    let (f, mut options) = fixture(vec![Agent::Opencode]);
    options.opencode_claude_hooks = true;
    let before = files(&f.root);
    options.dry_run = true;
    let accepted = install_with_hooks(
        &options,
        &selection(&[None], true),
        &f.root,
        &f.private,
        &f.source,
    )
    .unwrap();
    assert_eq!(accepted["host_delivery"]["idle_wake"], "not_supported");
    assert_eq!(files(&f.root), before);
}

#[test]
fn hook_purpose_cli_is_available_and_validates_values() {
    let output = Command::new(executable::binary())
        .args(["setup", "--help"])
        .output()
        .unwrap();
    let help = String::from_utf8(output.stdout).unwrap();
    assert!(help.contains("--hook-purpose"), "{help}");
    assert!(help.contains("--opencode-async-rewake"), "{help}");
    let output = Command::new(executable::binary())
        .args(["setup", "--hook-purpose", "invalid"])
        .output()
        .unwrap();
    assert!(!output.status.success());
}

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

#[test]
fn health_plan_restores_proven_missing_skill_and_keeps_manual_guidance() {
    let (f, options) = fixture(vec![Agent::Generic]);
    assert!(
        health_plan(&f.root, &f.private, &f.source)
            .unwrap()
            .is_none()
    );
    install(&options, &f).unwrap();
    let guidance = f.root.join("AGENTS.md");
    let skill = f.root.join(".agents/skills/specgit-native/SKILL.md");
    let original = fs::read(&skill).unwrap();
    let prior_guidance = fs::read_to_string(&guidance).unwrap();
    fs::write(
        &guidance,
        format!("manual prefix\n{prior_guidance}manual suffix\n"),
    )
    .unwrap();
    fs::remove_file(&skill).unwrap();
    let before = files(&f.base);
    let plan = health_plan(&f.root, &f.private, &f.source)
        .unwrap()
        .unwrap();
    assert!(
        plan.assets()
            .iter()
            .any(|a| a.path == skill && a.state == "created")
    );
    assert_eq!(files(&f.base), before, "planning created a file or lock");
    assert!(plan.apply().unwrap().changes > 0);
    assert_eq!(fs::read(&skill).unwrap(), original);
    let after = fs::read_to_string(&guidance).unwrap();
    assert!(after.starts_with("manual prefix\n"));
    assert!(after.ends_with("manual suffix\n"));
    let settled = health_plan(&f.root, &f.private, &f.source)
        .unwrap()
        .unwrap();
    assert!(settled.assets().is_empty());
    assert_eq!(settled.apply().unwrap().changes, 0);
}

#[cfg(windows)]
#[test]
fn health_plan_repairs_missing_skill_across_windows_root_spellings() {
    let (f, options) = fixture(vec![Agent::Generic]);
    install(&options, &f).unwrap();
    let extended = f.root.to_string_lossy();
    let ordinary = extended
        .strip_prefix(r"\\?\")
        .expect("the Windows fixture root should use a verbatim prefix");
    let ordinary_root = PathBuf::from(ordinary);
    let skill = ordinary_root.join(".agents/skills/specgit-native/SKILL.md");
    let expected = fs::read(&skill).unwrap();
    fs::remove_file(&skill).unwrap();

    let plan = health_plan(&ordinary_root, &f.private, &f.source)
        .unwrap()
        .unwrap();
    assert!(plan.assets().iter().any(|asset| asset.path == skill));
    assert!(plan.apply().unwrap().changes > 0);
    assert_eq!(fs::read(&skill).unwrap(), expected);
    let settled = health_plan(&ordinary_root, &f.private, &f.source)
        .unwrap()
        .unwrap();
    assert!(settled.assets().is_empty());
}

#[test]
fn health_plan_rechecks_shared_executable_ownership_after_lock() {
    let (f, options) = fixture(vec![Agent::Claude]);
    let shared = f.base.join("shared-dir");
    fs::create_dir(&shared).unwrap();
    let source = source_fixture(&shared);
    install_with_hooks(
        &options,
        &specgit::setup::HookOptions::default(),
        &f.root,
        &f.private,
        &source,
    )
    .unwrap();
    let skill = f.root.join(".agents/skills/specgit-native/SKILL.md");
    fs::remove_file(&skill).unwrap();
    let plan = health_plan(&f.root, &f.private, &source).unwrap().unwrap();
    assert!(plan.assets().iter().any(|asset| asset.path == skill));
    let original_source = specgit::assets::Snapshot::read(&source).unwrap();

    git(
        &f.root,
        &[
            "worktree",
            "add",
            "--detach",
            "--no-checkout",
            "../newlinked",
            "HEAD",
        ],
    );
    let linked = f.base.join("newlinked");
    source_fixture(&linked);
    fs::rename(&shared, f.base.join("shared-old")).unwrap();
    fs::rename(&linked, &shared).unwrap();
    git(&f.root, &["worktree", "repair", "../shared-dir"]);
    assert_eq!(
        git(&shared, &["rev-parse", "--is-inside-work-tree"]),
        "true"
    );
    let replacement_source = specgit::assets::Snapshot::read(&source).unwrap();
    assert_eq!(original_source.bytes, replacement_source.bytes);
    assert_eq!(
        original_source
            .permissions
            .as_ref()
            .map(fs::Permissions::readonly),
        replacement_source
            .permissions
            .as_ref()
            .map(fs::Permissions::readonly)
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            original_source.permissions.as_ref().unwrap().mode(),
            replacement_source.permissions.as_ref().unwrap().mode()
        );
    }
    assert_eq!(
        health_plan(&f.root, &f.private, &source)
            .err()
            .unwrap()
            .code,
        Code::InvalidInput
    );

    let error = plan.apply().unwrap_err();
    assert_eq!(error.code, Code::InvalidInput);
    assert!(
        !skill.exists(),
        "rejected repair must not restore the skill"
    );
}

#[test]
fn health_plan_rejects_missing_guidance_and_stale_snapshot() {
    let (f, options) = fixture(vec![Agent::Generic]);
    install(&options, &f).unwrap();
    let guidance = f.root.join("AGENTS.md");
    fs::remove_file(&guidance).unwrap();
    assert_eq!(
        health_plan(&f.root, &f.private, &f.source)
            .err()
            .unwrap()
            .code,
        Code::OwnershipConflict
    );
    fs::write(&guidance, "foreign guidance").unwrap();
    assert_eq!(
        health_plan(&f.root, &f.private, &f.source)
            .err()
            .unwrap()
            .code,
        Code::OwnershipConflict
    );
    // Reinstall the precise owned block through a fresh fixture for the race check.
    let (f, options) = fixture(vec![Agent::Generic]);
    install(&options, &f).unwrap();
    fs::remove_file(f.root.join(".agents/skills/specgit-native/SKILL.md")).unwrap();
    let plan = health_plan(&f.root, &f.private, &f.source)
        .unwrap()
        .unwrap();
    fs::write(
        f.root.join(".agents/skills/specgit-native/SKILL.md"),
        "raced",
    )
    .unwrap();
    assert_eq!(plan.apply().unwrap_err().code, Code::ConcurrentEdit);
    assert_eq!(
        fs::read_to_string(f.root.join(".agents/skills/specgit-native/SKILL.md")).unwrap(),
        "raced"
    );
}

#[test]
fn health_plan_restores_only_proven_missing_hook_event() {
    let (f, options) = fixture(vec![Agent::Claude]);
    install(&options, &f).unwrap();
    let settings = f.root.join(".claude/settings.json");
    let mut value: Value = serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
    let original = value["hooks"]["SessionStart"].clone();
    value["manual"] = json!("keep");
    value["hooks"]
        .as_object_mut()
        .unwrap()
        .remove("SessionStart");
    fs::write(&settings, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    let plan = health_plan(&f.root, &f.private, &f.source)
        .unwrap()
        .unwrap();
    assert!(
        plan.assets()
            .iter()
            .any(|a| a.path == settings && a.state == "updated")
    );
    plan.apply().unwrap();
    let restored: Value = serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
    assert_eq!(restored["manual"], "keep");
    assert_eq!(restored["hooks"]["SessionStart"], original);
    let mut edited = restored;
    edited["hooks"]["SessionStart"][0]["hooks"][0]["args"] = json!(["foreign"]);
    fs::write(&settings, serde_json::to_vec_pretty(&edited).unwrap()).unwrap();
    assert_eq!(
        health_plan(&f.root, &f.private, &f.source)
            .err()
            .unwrap()
            .code,
        Code::OwnershipConflict
    );
}

#[test]
fn health_plan_restores_only_an_owned_missing_hook_map() {
    let (f, options) = fixture(vec![Agent::Claude]);
    install(&options, &f).unwrap();
    let settings = f.root.join(".claude/settings.json");
    let mut value: Value = serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
    let original_hooks = value["hooks"].clone();
    value["manual"] = json!("keep");
    value.as_object_mut().unwrap().remove("hooks");
    fs::write(&settings, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    let before = files(&f.base);
    let plan = health_plan(&f.root, &f.private, &f.source)
        .unwrap()
        .unwrap();
    assert_eq!(files(&f.base), before);
    assert!(
        plan.assets()
            .iter()
            .any(|asset| asset.path == settings && asset.state == "updated")
    );
    plan.apply().unwrap();
    let restored: Value = serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
    assert_eq!(restored["manual"], "keep");
    assert_eq!(restored["hooks"], original_hooks);
    let mut replaced = restored;
    replaced["hooks"] = Value::Null;
    fs::write(&settings, serde_json::to_vec_pretty(&replaced).unwrap()).unwrap();
    assert_eq!(
        health_plan(&f.root, &f.private, &f.source)
            .err()
            .unwrap()
            .code,
        Code::OwnershipConflict
    );

    let (f, options) = fixture(vec![Agent::Claude]);
    let settings = f.root.join(".claude/settings.json");
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    fs::write(
        &settings,
        b"{\"manual\":\"keep\",\"hooks\":{\"Foreign\":[{\"manual\":true}]}}",
    )
    .unwrap();
    install(&options, &f).unwrap();
    let mut value: Value = serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
    value.as_object_mut().unwrap().remove("hooks");
    fs::write(&settings, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    let before = files(&f.base);
    assert_eq!(
        health_plan(&f.root, &f.private, &f.source)
            .err()
            .unwrap()
            .code,
        Code::OwnershipConflict
    );
    assert_eq!(files(&f.base), before);
}

#[cfg(unix)]
#[test]
fn health_plan_does_not_reset_changed_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let (f, options) = fixture(vec![Agent::Generic]);
    install(&options, &f).unwrap();
    let skill = f.root.join(".agents/skills/specgit-native/SKILL.md");
    fs::set_permissions(&skill, fs::Permissions::from_mode(0o644)).unwrap();
    let before = files(&f.base);
    assert_eq!(
        health_plan(&f.root, &f.private, &f.source)
            .err()
            .unwrap()
            .code,
        Code::OwnershipConflict
    );
    assert_eq!(files(&f.base), before);
    assert_eq!(
        fs::metadata(&skill).unwrap().permissions().mode() & 0o777,
        0o644
    );
}

#[cfg(unix)]
#[test]
fn permission_drift_rejects_setup_refresh_and_uninstall_without_adopting_changes() {
    use specgit::setup::HookPurpose::Guard;
    use std::os::unix::fs::PermissionsExt;

    for relative in [
        ".opencode/hooks.json",
        ".agents/skills/specgit-native/SKILL.md",
        "AGENTS.md",
        ".git/specgit-v2/agent-assets/ownership.json",
    ] {
        let (f, mut options) = fixture(vec![Agent::Opencode]);
        options.opencode_claude_hooks = true;
        install(&options, &f).unwrap();
        let path = f.root.join(relative);
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        let before = files(&f.base);
        let modes: BTreeMap<_, _> = before
            .keys()
            .map(|path| {
                (
                    path.clone(),
                    fs::metadata(path).unwrap().permissions().mode(),
                )
            })
            .collect();
        options.agents.clear();
        options.opencode_claude_hooks = false;
        for uninstall in [false, true] {
            options.uninstall = uninstall;
            for dry_run in [true, false] {
                options.dry_run = dry_run;
                let error = install(&options, &f).expect_err(relative);
                assert_eq!(error.code, Code::OwnershipConflict, "{relative}: {error}");
                assert!(error.message.contains("recorded unix_mode=0600"), "{error}");
                assert!(error.message.contains("observed unix_mode=0644"), "{error}");
                assert!(
                    error.message.contains(&path.to_string_lossy().to_string()),
                    "{error}"
                );
                assert_eq!(files(&f.base), before, "{relative}");
            }
        }
        options.uninstall = false;
        // A requested hook change must not silently adopt the changed mode.
        for dry_run in [true, false] {
            options.dry_run = dry_run;
            let error = install_with_hooks(
                &options,
                &selection(&[Guard], false),
                &f.root,
                &f.private,
                &f.source,
            )
            .unwrap_err();
            assert_eq!(error.code, Code::OwnershipConflict, "{relative}: {error}");
            assert_eq!(files(&f.base), before, "{relative}");
        }
        let error = health_plan(&f.root, &f.private, &f.source).err().unwrap();
        assert_eq!(error.code, Code::OwnershipConflict);
        assert!(error.message.contains("recorded unix_mode=0600"), "{error}");
        assert!(error.message.contains("observed unix_mode=0644"), "{error}");
        assert_eq!(files(&f.base), before);
        for (path, mode) in modes {
            assert_eq!(fs::metadata(path).unwrap().permissions().mode(), mode);
        }
    }
}

#[test]
fn readonly_permission_drift_is_rejected_before_setup_writes() {
    let (f, mut options) = fixture(vec![Agent::Codex]);
    install(&options, &f).unwrap();
    let path = f.root.join(".codex/hooks.json");
    let original = fs::metadata(&path).unwrap().permissions();
    let mut changed = original.clone();
    changed.set_readonly(true);
    fs::set_permissions(&path, changed).unwrap();
    let before = files(&f.base);
    options.agents.clear();
    let result = install(&options, &f);
    let after = files(&f.base);
    let kept_readonly = fs::metadata(&path).unwrap().permissions().readonly();
    // Restore only the disposable fixture so Windows can remove its directory.
    fs::set_permissions(&path, original).unwrap();
    let error = result.unwrap_err();
    assert_eq!(error.code, Code::OwnershipConflict, "{error}");
    assert!(error.message.contains("readonly=false"), "{error}");
    assert!(error.message.contains("readonly=true"), "{error}");
    assert_eq!(after, before);
    assert!(kept_readonly);
}

#[cfg(unix)]
#[test]
fn ownership_proof_does_not_skip_a_newer_recorded_permission() {
    use specgit::assets::{AssetStore, Change};
    use std::os::unix::fs::PermissionsExt;
    let (f, mut options) = fixture(vec![Agent::Opencode]);
    options.opencode_claude_hooks = true;
    install(&options, &f).unwrap();
    let path = f.root.join(".opencode/hooks.json");
    let receipt_path = f.private.join("ownership.json");
    let receipt: Value = serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
    // A new receipt revision with the same semantics links the permission-only
    // transaction to its predecessor.
    let updated_receipt = serde_json::to_vec(&receipt).unwrap();
    assert_ne!(fs::read(&receipt_path).unwrap(), updated_receipt);
    let mut change = Change::new(path.clone(), Some(fs::read(&path).unwrap())).unwrap();
    change.permissions = Some(fs::Permissions::from_mode(0o640));
    AssetStore::lock(
        &f.private,
        &[f.root.clone(), f.private.clone()],
        std::time::Duration::from_secs(2),
    )
    .unwrap()
    .apply(vec![
        change,
        Change::new(receipt_path, Some(updated_receipt)).unwrap(),
    ])
    .unwrap();
    // This matches the older transaction, but not the most recent record in
    // the current receipt chain. An older mode must not erase that conflict.
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let before = files(&f.base);
    options.agents.clear();
    options.opencode_claude_hooks = false;
    let errors = [
        install(&options, &f).unwrap_err(),
        health_plan(&f.root, &f.private, &f.source).err().unwrap(),
    ];
    for error in errors {
        assert_eq!(error.code, Code::OwnershipConflict, "{error}");
        assert!(error.message.contains("recorded unix_mode=0640"), "{error}");
        assert!(error.message.contains("observed unix_mode=0600"), "{error}");
    }
    assert_eq!(files(&f.base), before);
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[cfg(unix)]
#[test]
fn reinstallation_cannot_use_an_older_permission_record_for_the_same_receipt() {
    use std::os::unix::fs::PermissionsExt;
    let (f, mut options) = fixture(vec![Agent::Generic]);
    let guidance = f.root.join("AGENTS.md");
    fs::write(&guidance, "Manual rules\n").unwrap();
    fs::set_permissions(&guidance, fs::Permissions::from_mode(0o644)).unwrap();
    let installed = install(&options, &f).unwrap();
    let first_receipt = fs::read(f.private.join("ownership.json")).unwrap();
    options.agents.clear();
    options.uninstall = true;
    let removed = install(&options, &f).unwrap();
    assert_eq!(fs::read_to_string(&guidance).unwrap(), "Manual rules\n");
    fs::set_permissions(&guidance, fs::Permissions::from_mode(0o600)).unwrap();
    options.agents = vec![Agent::Generic];
    options.uninstall = false;
    let reinstalled = install(&options, &f).unwrap();
    let second_receipt = fs::read(f.private.join("ownership.json")).unwrap();
    assert_ne!(
        first_receipt, second_receipt,
        "Reinstall must identify a new installation"
    );
    // Journal names carry no chronological contract. Put the older record
    // first deterministically instead of relying on random tempdir ordering.
    for (result, name) in [
        (&installed, "tx-000-old"),
        (&removed, "tx-100-uninstalled"),
        (&reinstalled, "tx-999-new"),
    ] {
        fs::rename(
            f.private
                .parent()
                .unwrap()
                .join("assets/transactions")
                .join(result["transaction"]["transaction"].as_str().unwrap()),
            f.private
                .parent()
                .unwrap()
                .join("assets/transactions")
                .join(name),
        )
        .unwrap();
    }
    assert!(
        health_plan(&f.root, &f.private, &f.source)
            .unwrap()
            .unwrap()
            .assets()
            .is_empty()
    );
    assert_eq!(install(&options, &f).unwrap()["transaction"]["changes"], 0);
    assert_eq!(
        fs::read(f.private.join("ownership.json")).unwrap(),
        second_receipt
    );
    fs::set_permissions(&guidance, fs::Permissions::from_mode(0o644)).unwrap();
    let before = files(&f.base);
    for dry_run in [true, false] {
        options.dry_run = dry_run;
        let result = install(&options, &f);
        assert!(
            result.is_err(),
            "An older permission was accepted; identical receipts: {}",
            first_receipt == second_receipt
        );
        assert_eq!(result.unwrap_err().code, Code::OwnershipConflict);
        assert_eq!(files(&f.base), before);
    }
    assert_eq!(
        health_plan(&f.root, &f.private, &f.source)
            .err()
            .unwrap()
            .code,
        Code::OwnershipConflict
    );
    assert_eq!(files(&f.base), before);
    assert_eq!(
        fs::metadata(&guidance).unwrap().permissions().mode() & 0o777,
        0o644
    );
}

#[test]
fn invalid_installation_generations_are_rejected_without_changes() {
    for generation in [
        None,
        Some(json!("")),
        Some(json!("0".repeat(63))),
        Some(json!("G".repeat(64))),
    ] {
        let (f, mut options) = fixture(vec![Agent::Generic]);
        install(&options, &f).unwrap();
        let receipt_path = f.private.join("ownership.json");
        let mut receipt: Value = serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
        receipt["version"] = json!(3);
        receipt.as_object_mut().unwrap().remove("purposes");
        match generation {
            Some(value) => {
                receipt["generation"] = value;
            }
            None => {
                receipt.as_object_mut().unwrap().remove("generation");
            }
        }
        fs::write(&receipt_path, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
        let before = files(&f.base);
        options.agents.clear();
        for uninstall in [false, true] {
            options.uninstall = uninstall;
            assert_eq!(
                install(&options, &f).unwrap_err().code,
                Code::OwnershipConflict
            );
        }
        assert_eq!(
            health_plan(&f.root, &f.private, &f.source)
                .err()
                .unwrap()
                .code,
            Code::OwnershipConflict
        );
        assert_eq!(files(&f.base), before);
    }
}

#[cfg(unix)]
#[test]
fn recurring_legacy_receipts_reject_conflicting_permission_records_in_any_order() {
    use specgit::assets::{AssetStore, Change};
    use std::os::unix::fs::PermissionsExt;
    for older_first in [false, true] {
        let (f, mut options) = fixture(vec![Agent::Generic]);
        install(&options, &f).unwrap();
        let receipt_path = f.private.join("ownership.json");
        let guidance = f.root.join("AGENTS.md");
        let skill = f.root.join(".agents/skills/specgit-native/SKILL.md");
        let guidance_bytes = fs::read(&guidance).unwrap();
        let skill_bytes = fs::read(&skill).unwrap();
        let mut receipt: Value = serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
        receipt["version"] = json!(2);
        receipt.as_object_mut().unwrap().remove("purposes");
        receipt.as_object_mut().unwrap().remove("generation");
        let legacy_bytes = serde_json::to_vec_pretty(&receipt).unwrap();
        options.agents.clear();
        options.uninstall = true;
        install(&options, &f).unwrap();
        // Two genuine legacy transaction histories reuse identical receipt bytes
        // across uninstall, while recording different permissions for the asset.
        let mut transactions = Vec::new();
        for mode in [0o644, 0o600] {
            let mut change = Change::new(guidance.clone(), Some(guidance_bytes.clone())).unwrap();
            change.permissions = Some(fs::Permissions::from_mode(mode));
            let result = AssetStore::lock(
                &f.private,
                &[f.root.clone(), f.private.clone()],
                std::time::Duration::from_secs(2),
            )
            .unwrap()
            .apply(vec![
                Change::new(skill.clone(), Some(skill_bytes.clone())).unwrap(),
                change,
                Change::new(receipt_path.clone(), Some(legacy_bytes.clone())).unwrap(),
            ])
            .unwrap();
            transactions.push(result.transaction);
            if mode == 0o644 {
                AssetStore::lock(
                    &f.private,
                    &[f.root.clone(), f.private.clone()],
                    std::time::Duration::from_secs(2),
                )
                .unwrap()
                .apply(vec![
                    Change::new(skill.clone(), None).unwrap(),
                    Change::new(guidance.clone(), None).unwrap(),
                    Change::new(receipt_path.clone(), None).unwrap(),
                ])
                .unwrap();
            }
        }
        for (index, transaction) in transactions.iter().enumerate() {
            let name = if (index == 0) == older_first {
                "tx-000-first"
            } else {
                "tx-999-last"
            };
            fs::rename(
                f.private.join("transactions").join(transaction),
                f.private.join("transactions").join(name),
            )
            .unwrap();
        }
        // Matching either permission cannot make ambiguous legacy proof safe.
        for mode in [0o600, 0o644] {
            fs::set_permissions(&guidance, fs::Permissions::from_mode(mode)).unwrap();
            let before = files(&f.base);
            for uninstall in [false, true] {
                options.uninstall = uninstall;
                for dry_run in [true, false] {
                    options.dry_run = dry_run;
                    let error = install(&options, &f).unwrap_err();
                    assert_eq!(error.code, Code::OwnershipConflict, "{error}");
                    assert!(error.message.contains("recorded unix_mode="), "{error}");
                    assert_eq!(files(&f.base), before);
                }
            }
            assert_eq!(
                health_plan(&f.root, &f.private, &f.source)
                    .err()
                    .unwrap()
                    .code,
                Code::OwnershipConflict
            );
            assert_eq!(files(&f.base), before);
            assert_eq!(
                fs::metadata(&guidance).unwrap().permissions().mode() & 0o777,
                mode
            );
        }
    }
}

#[test]
fn a_receipt_without_transaction_evidence_cannot_authorize_setup() {
    let (f, mut options) = fixture(vec![Agent::Generic]);
    install(&options, &f).unwrap();
    fs::remove_dir_all(f.private.parent().unwrap().join("assets/transactions")).unwrap();
    let before = files(&f.base);
    options.agents.clear();
    for uninstall in [false, true] {
        options.uninstall = uninstall;
        for dry_run in [true, false] {
            options.dry_run = dry_run;
            assert_eq!(
                install(&options, &f).unwrap_err().code,
                Code::OwnershipConflict
            );
            assert_eq!(files(&f.base), before);
        }
    }
    assert_eq!(
        health_plan(&f.root, &f.private, &f.source)
            .err()
            .unwrap()
            .code,
        Code::OwnershipConflict
    );
    assert_eq!(files(&f.base), before);
}

#[test]
fn coherent_receipt_cycles_keep_every_journal_as_a_lock_dependency() {
    use specgit::assets::{AssetStore, Change};
    let (f, mut options) = fixture(vec![Agent::Generic]);
    let installed = install(&options, &f).unwrap();
    let receipt_path = f.private.join("ownership.json");
    let original = fs::read(&receipt_path).unwrap();
    let receipt: Value = serde_json::from_slice(&original).unwrap();
    let compact = serde_json::to_vec(&receipt).unwrap();
    assert_ne!(original, compact);
    let mut transactions = vec![
        installed["transaction"]["transaction"]
            .as_str()
            .unwrap()
            .to_owned(),
    ];
    // A valid receipt can return to its previous bytes during refresh. Cycles
    // with consistent evidence remain usable and every candidate matters.
    for bytes in [compact, original] {
        let result = AssetStore::lock(
            &f.private,
            &[f.root.clone(), f.private.clone()],
            std::time::Duration::from_secs(2),
        )
        .unwrap()
        .apply(vec![
            Change::new(receipt_path.clone(), Some(bytes)).unwrap(),
        ])
        .unwrap();
        transactions.push(result.transaction);
    }
    options.agents.clear();
    assert_eq!(install(&options, &f).unwrap()["transaction"]["changes"], 0);
    let guidance_path = f.root.join("AGENTS.md");
    let guidance = fs::read_to_string(&guidance_path).unwrap();
    fs::write(
        &guidance_path,
        guidance.replace("specgit init", "Stale integration text"),
    )
    .unwrap();
    for transaction in transactions {
        let plan = health_plan(&f.root, &f.private, &f.source)
            .unwrap()
            .unwrap();
        assert!(!plan.assets().is_empty());
        let new_path = f
            .private
            .parent()
            .unwrap()
            .join("assets/transactions")
            .join(&transaction)
            .join("journal.json");
        let journal_path = if new_path.exists() {
            new_path
        } else {
            f.private
                .join("transactions")
                .join(transaction)
                .join("journal.json")
        };
        let before = fs::read(&journal_path).unwrap();
        let mut altered = before.clone();
        altered.push(b'\n');
        fs::write(&journal_path, &altered).unwrap();
        let unchanged = files(&f.base);
        assert_eq!(plan.apply().unwrap_err().code, Code::ConcurrentEdit);
        assert_eq!(files(&f.base), unchanged);
        fs::write(journal_path, before).unwrap();
    }
}

#[cfg(unix)]
#[test]
fn cli_setup_and_doctor_report_recorded_and_observed_hook_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let (f, mut options) = fixture(vec![Agent::Opencode]);
    options.opencode_claude_hooks = true;
    fs::write(
        f.root.join(".specgit.yaml"),
        "version: 2\nprovider: github\nremote: origin\ntarget: main\n",
    )
    .unwrap();
    git(
        &f.root,
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/fixture/repo.git",
        ],
    );
    install(&options, &f).unwrap();
    let path = f.root.join(".opencode/hooks.json");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    let before = files(&f.base);
    for args in [
        vec!["setup", "--dry-run"],
        vec!["setup"],
        vec!["setup", "--uninstall", "--dry-run"],
        vec!["setup", "--uninstall"],
        vec!["doctor", "--offline"],
        vec!["doctor", "--offline", "--fix", "--dry-run"],
        vec!["doctor", "--offline", "--fix"],
    ] {
        let output = executable::command()
            .current_dir(&f.root)
            .args(&args)
            .arg("--json")
            .output()
            .unwrap();
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(output.status.code(), Some(3), "{args:?}: {report}");
        let diagnostics = report["diagnostics"].to_string();
        for expected in [
            "ownership_conflict",
            "recorded unix_mode=0600",
            "observed unix_mode=0644",
            ".opencode/hooks.json",
        ] {
            assert!(diagnostics.contains(expected), "{args:?}: {report}");
        }
        assert_eq!(files(&f.base), before, "{args:?}");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o644
        );
    }
}

#[test]
fn health_plan_reports_orphan_project_assets_without_claiming_foreign_files() {
    let (f, _) = fixture(vec![]);
    let guidance = f.root.join("AGENTS.md");
    let foreign_hooks = f.root.join(".codex/hooks.json");
    fs::create_dir_all(foreign_hooks.parent().unwrap()).unwrap();
    fs::write(&guidance, "manual rules\n").unwrap();
    fs::write(&foreign_hooks, "{\"manual\":true}").unwrap();
    assert!(
        health_plan(&f.root, &f.private, &f.source)
            .unwrap()
            .is_none()
    );

    let skill = f.root.join(".agents/skills/specgit-native/SKILL.md");
    fs::create_dir_all(skill.parent().unwrap()).unwrap();
    fs::write(&skill, "orphaned skill").unwrap();
    let before = files(&f.base);
    assert_eq!(
        health_plan(&f.root, &f.private, &f.source)
            .err()
            .unwrap()
            .code,
        Code::OwnershipConflict
    );
    assert_eq!(files(&f.base), before);
    fs::remove_file(&skill).unwrap();

    fs::write(
        &guidance,
        "manual rules\n<!-- specgit:project:v2:start -->\n",
    )
    .unwrap();
    let before = files(&f.base);
    assert_eq!(
        health_plan(&f.root, &f.private, &f.source)
            .err()
            .unwrap()
            .code,
        Code::OwnershipConflict
    );
    assert_eq!(files(&f.base), before);
}

#[test]
fn health_plan_reports_exact_orphan_host_registration() {
    for agent in [Agent::Claude, Agent::Codex, Agent::Opencode] {
        let (f, mut options) = fixture(vec![agent]);
        if agent == Agent::Opencode {
            options.opencode_claude_hooks = true;
        }
        install(&options, &f).unwrap();
        let settings = f.root.join(match agent {
            Agent::Claude => ".claude/settings.json",
            Agent::Codex => ".codex/hooks.json",
            Agent::Opencode => ".opencode/hooks.json",
            Agent::Generic => unreachable!(),
        });
        fs::remove_file(f.private.join("ownership.json")).unwrap();
        fs::remove_file(f.root.join(".agents/skills/specgit-native/SKILL.md")).unwrap();
        if agent == Agent::Claude {
            fs::remove_file(f.root.join(".claude/skills/specgit-native/SKILL.md")).unwrap();
            fs::remove_file(f.root.join("CLAUDE.md")).unwrap();
        } else {
            fs::remove_file(f.root.join("AGENTS.md")).unwrap();
        }
        let before = files(&f.base);
        let error = health_plan(&f.root, &f.private, &f.source).err().unwrap();
        assert_eq!(error.code, Code::OwnershipConflict, "{agent:?}: {error}");
        assert!(error.message.contains("registration"), "{agent:?}: {error}");
        assert_eq!(files(&f.base), before, "{agent:?}");
        assert!(settings.exists());
    }
}

#[test]
fn health_plan_reports_legacy_codex_orphan_without_writing() {
    let (f, _) = fixture(vec![]);
    let settings = f.root.join(".codex/hooks.json");
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    // A surviving 2.9.2 Codex registration, with its ownership record and
    // guidance absent. Do not derive this old protocol from the new generator.
    let legacy = json!({"hooks":{"SessionStart":[{"matcher":"","hooks":[{
        "type":"command", "command":f.source,
        "args":["hook", "--event", "SessionStart"], "timeout":5
    }]}]}});
    fs::write(&settings, serde_json::to_vec_pretty(&legacy).unwrap()).unwrap();
    let replacement = f.base.join("replacement");
    fs::create_dir(&replacement).unwrap();
    let moved_source = source_fixture(&replacement);
    let before = files(&f.base);
    for current_source in [&f.source, &moved_source] {
        let error = health_plan(&f.root, &f.private, current_source)
            .err()
            .expect("legacy Codex registration must remain an ownership conflict");
        assert_eq!(error.code, Code::OwnershipConflict);
        assert!(error.message.contains("registration"), "{error}");
        assert_eq!(files(&f.base), before);
    }
}

#[test]
fn health_plan_reports_receiptless_retired_event_registrations_without_panicking() {
    // 2.12 wrote PostToolUse (guard + async observer) and Stop groups. Build
    // them literally rather than from the current generator.
    let (f, _) = fixture(vec![]);
    let source = f.source.to_str().unwrap();
    let hook = |event: &str, observe: bool| {
        let mut args = vec!["hook", "--event", event];
        if observe {
            args.push("--observe");
        }
        let mut hook = json!({"type":"command","command":source,"args":args,"timeout":if observe {1830} else {5}});
        if observe {
            hook["async"] = json!(true);
        }
        hook
    };
    let quoted = format!("'{}'", source.replace('\'', "'\\''"));
    let opencode = |event: &str| json!({"type":"command","shell":"bash","command":format!("{quoted} hook --event {event}"),"inputFormat":"claude-code","timeout":5});
    let cases = [
        (
            ".claude/settings.json",
            json!({"hooks":{"PostToolUse":[{"matcher":"*","hooks":[hook("PostToolUse", false), hook("PostToolUse", true)]}]}}),
        ),
        (
            ".claude/settings.json",
            json!({"hooks":{"PostToolUse":[{"matcher":"*","hooks":[hook("PostToolUse", false)]}]}}),
        ),
        (
            ".claude/settings.json",
            json!({"hooks":{"Stop":[{"matcher":"","hooks":[hook("Stop", false)]}]}}),
        ),
        (
            ".opencode/hooks.json",
            json!({"Stop":[{"matcher":"*","hooks":[opencode("Stop")]}]}),
        ),
        (
            ".opencode/hooks.json",
            json!({"PostToolUse":[{"matcher":"*","hooks":[opencode("PostToolUse")]}]}),
        ),
    ];
    for (relative, settings) in cases {
        let path = f.root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, serde_json::to_vec_pretty(&settings).unwrap()).unwrap();
        let before = files(&f.base);
        let error = health_plan(&f.root, &f.private, &f.source)
            .err()
            .unwrap_or_else(|| panic!("{relative}: retired registration must stay an orphan"));
        assert_eq!(error.code, Code::OwnershipConflict, "{relative}: {error}");
        assert!(
            error.message.contains("registration"),
            "{relative}: {error}"
        );
        assert_eq!(files(&f.base), before);
        fs::remove_file(&path).unwrap();
    }
}

#[test]
fn health_plan_reports_orphan_hook_after_shared_cli_moves() {
    for agent in [Agent::Claude, Agent::Codex, Agent::Opencode] {
        let (f, mut options) = fixture(vec![agent]);
        if agent == Agent::Opencode {
            options.opencode_claude_hooks = true;
        }
        install(&options, &f).unwrap();
        fs::remove_file(f.private.join("ownership.json")).unwrap();
        fs::remove_file(f.root.join(".agents/skills/specgit-native/SKILL.md")).unwrap();
        if agent == Agent::Claude {
            fs::remove_file(f.root.join(".claude/skills/specgit-native/SKILL.md")).unwrap();
            fs::remove_file(f.root.join("CLAUDE.md")).unwrap();
        } else {
            fs::remove_file(f.root.join("AGENTS.md")).unwrap();
        }
        let replacement = f.base.join("replacement");
        fs::create_dir(&replacement).unwrap();
        let moved_source = source_fixture(&replacement);
        let before = files(&f.base);
        let error = health_plan(&f.root, &f.private, &moved_source)
            .err()
            .unwrap();
        assert_eq!(error.code, Code::OwnershipConflict, "{agent:?}: {error}");
        assert!(error.message.contains("registration"), "{agent:?}: {error}");
        assert_eq!(files(&f.base), before);
    }
}

#[test]
fn health_plan_does_not_claim_unrelated_host_settings_without_receipt() {
    let (f, _) = fixture(vec![]);
    for relative in [
        ".claude/settings.json",
        ".codex/hooks.json",
        ".opencode/hooks.json",
    ] {
        let path = f.root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{\"hooks\":{\"PreToolUse\":[{\"hooks\":[{\"command\":\"other-tool\",\"args\":[\"hook\",\"--event\",\"PreToolUse\"]}]}]},\"manual\":true}").unwrap();
    }
    let before = files(&f.base);
    assert!(
        health_plan(&f.root, &f.private, &f.source)
            .unwrap()
            .is_none()
    );
    assert_eq!(files(&f.base), before);
}

fn install(
    options: &project::Options,
    f: &Fixture,
) -> Result<Value, specgit::diagnostic::Diagnostic> {
    install_with_hooks(
        options,
        &specgit::setup::HookOptions::default(),
        &f.root,
        &f.private,
        &f.source,
    )
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
                if relative == ".claude/settings.json" {
                    assert_eq!(entry["command"], json!(f.source.to_str().unwrap()));
                    assert_eq!(entry["args"], json!(["hook", "--event", "SessionStart"]));
                } else {
                    assert!(entry.get("args").is_none(), "{entry}");
                    assert!(
                        entry["command"]
                            .as_str()
                            .unwrap()
                            .ends_with(" hook --event SessionStart"),
                        "{entry}"
                    );
                }
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
fn codex_refresh_migrates_owned_argv_hooks_without_changing_claude_or_foreign_hooks() {
    for through_doctor in [false, true] {
        let (f, mut options) = fixture(vec![Agent::Codex, Agent::Claude]);
        install(&options, &f).unwrap();
        let settings_path = f.root.join(".codex/hooks.json");
        let receipt_path = f.private.join("ownership.json");
        let claude = fs::read(f.root.join(".claude/settings.json")).unwrap();
        let mut settings: Value =
            serde_json::from_slice(&fs::read(&settings_path).unwrap()).unwrap();
        let mut receipt: Value = serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
        // Reconstruct the old four-event Codex protocol, including the
        // historical write matcher and paired PostToolUse handlers. This
        // fixture represents an actual v3 receipt, so it has no purposes map.
        let mut old_events = serde_json::Map::new();
        for event in ["SessionStart", "PreToolUse", "PostToolUse", "Stop"] {
            let handler = json!({
                "type":"command",
                "command":f.source,
                "args":["hook", "--event", event],
                "timeout":5
            });
            let mut handlers = vec![handler.clone()];
            if event == "PostToolUse" {
                handlers.push(json!({
                    "type":"command",
                    "command":f.source,
                    "args":["hook", "--event", event, "--observe"],
                    "timeout":1830,
                    "async":true
                }));
            }
            let group = json!({
                "matcher": if matches!(event, "PreToolUse" | "PostToolUse") {
                    "Write|Edit|MultiEdit|Bash|PowerShell|apply_patch|functions.apply_patch|mcp__functions__apply_patch"
                } else {
                    ""
                },
                "hooks":handlers
            });
            receipt["hooks"]["codex"]["entries"][event] = group.clone();
            old_events.insert(event.into(), json!([group]));
        }
        receipt["hooks"]["codex"]["created_event_keys"] =
            json!(["SessionStart", "PreToolUse", "PostToolUse", "Stop"]);
        settings["hooks"] = Value::Object(old_events);
        receipt["version"] = json!(3);
        receipt.as_object_mut().unwrap().remove("purposes");
        let foreign = json!({"matcher":"Read","hooks":[{"type":"command","command":"foreign-hook","unknown":true}]});
        settings["hooks"]["PreToolUse"]
            .as_array_mut()
            .unwrap()
            .push(foreign.clone());
        // Retain a real ownership transaction for the older receipt/registration,
        // as doctor must verify the journal as well as matching registration bytes.
        specgit::assets::AssetStore::lock(
            &f.private,
            &[f.root.clone(), f.private.clone()],
            std::time::Duration::from_secs(2),
        )
        .unwrap()
        .apply(vec![
            specgit::assets::Change::new(
                settings_path.clone(),
                Some(serde_json::to_vec_pretty(&settings).unwrap()),
            )
            .unwrap(),
            specgit::assets::Change::new(
                receipt_path.clone(),
                Some(serde_json::to_vec_pretty(&receipt).unwrap()),
            )
            .unwrap(),
        ])
        .unwrap();
        let legacy = fs::read(&settings_path).unwrap();
        let before = files(&f.base);
        options.agents.clear();
        let transaction = if through_doctor {
            let preview = health_plan(&f.root, &f.private, &f.source)
                .unwrap()
                .unwrap();
            assert!(
                preview
                    .assets()
                    .iter()
                    .any(|asset| asset.path == settings_path)
            );
            assert_eq!(files(&f.base), before);
            preview.apply().unwrap().transaction
        } else {
            options.dry_run = true;
            let preview = install(&options, &f).unwrap();
            assert_eq!(preview["written"], false);
            assert_eq!(files(&f.base), before);
            options.dry_run = false;
            install(&options, &f).unwrap()["transaction"]["transaction"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        let after: Value = serde_json::from_slice(&fs::read(&settings_path).unwrap()).unwrap();
        for event in ["SessionStart", "PreToolUse"] {
            for handler in after["hooks"][event][0]["hooks"].as_array().unwrap() {
                assert!(handler.get("args").is_none(), "{handler}");
                let suffix = if handler["async"] == true {
                    format!(" hook --event {event} --observe")
                } else {
                    format!(" hook --event {event}")
                };
                assert!(handler["command"].as_str().unwrap().ends_with(&suffix));
            }
        }
        assert_eq!(after["hooks"]["PreToolUse"][1], foreign);
        assert_eq!(after["hooks"]["PreToolUse"].as_array().unwrap().len(), 2);
        for retired in ["PostToolUse", "Stop"] {
            assert!(
                after["hooks"]
                    .get(retired)
                    .is_none_or(|groups| groups.as_array().is_some_and(Vec::is_empty)),
                "{retired}: {after}"
            );
        }
        assert_eq!(
            fs::read(f.root.join(".claude/settings.json")).unwrap(),
            claude
        );
        if through_doctor {
            let settled = health_plan(&f.root, &f.private, &f.source)
                .unwrap()
                .unwrap();
            assert!(settled.assets().is_empty());
            assert_eq!(settled.apply().unwrap().changes, 0);
        } else {
            assert_eq!(install(&options, &f).unwrap()["transaction"]["changes"], 0);
        }
        options.rollback = Some(transaction);
        let rolled_back = cli(
            &f.root,
            &["--rollback", options.rollback.as_deref().unwrap()],
        );
        assert_eq!(rolled_back["exit"], 0, "{rolled_back}");
        assert_eq!(fs::read(&settings_path).unwrap(), legacy);
        options.rollback = None;
        install(&options, &f).unwrap();
        options.uninstall = true;
        install(&options, &f).unwrap();
        let remaining: Value = serde_json::from_slice(&fs::read(&settings_path).unwrap()).unwrap();
        assert_eq!(remaining, json!({"hooks":{"PreToolUse":[foreign]}}));
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
    let executable = f.source.to_string_lossy();
    #[cfg(windows)]
    let executable = if let Some(unc) = executable.strip_prefix("\\\\?\\UNC\\") {
        format!("//{}", unc.replace('\\', "/"))
    } else {
        executable
            .strip_prefix("\\\\?\\")
            .unwrap_or(&executable)
            .replace('\\', "/")
    };
    let quoted = executable.replace('\'', "'\\''");
    for event in ["SessionStart", "PreToolUse"] {
        let entry = &hooks[event][0]["hooks"][0];
        assert_eq!(entry["shell"], "bash", "{event}: {hooks}");
        assert_eq!(
            entry["command"],
            json!(format!("'{quoted}' hook --event {event}")),
            "{event}: {hooks}"
        );
        assert_eq!(entry["inputFormat"], "claude-code", "{event}: {hooks}");
        if event == "PreToolUse" {
            assert_eq!(hooks[event][0]["matcher"], "*", "{event}: {hooks}");
        }
    }
    let receipt: Value =
        serde_json::from_slice(&fs::read(f.private.join("ownership.json")).unwrap()).unwrap();
    assert_eq!(receipt["version"], 4);
    assert_eq!(receipt["agents"], json!(["opencode"]), "{receipt}");
    assert!(receipt["hooks"].get("opencode").is_some(), "{receipt}");
    // The custom choice persists: a plain refresh keeps the recorded hooks.
    let before = fs::read(&path).unwrap();
    options.opencode_claude_hooks = false;
    assert_eq!(install(&options, &f).unwrap()["transaction"]["changes"], 0);
    assert_eq!(fs::read(&path).unwrap(), before);
    options.agents.clear();
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
fn guidance_slimming_refreshes_recorded_2_6_2_setup_without_overwriting_manual_text() {
    for edited in [false, true] {
        let (f, mut options) = fixture(vec![Agent::Generic]);
        install(&options, &f).unwrap();
        let receipt_path = f.private.join("ownership.json");
        let mut receipt: Value = serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
        let old = include_str!("fixtures/managed-setup-2.6.2.txt");
        receipt["instructions"]["generic"]["block"] = json!(old);
        let path = f.root.join("AGENTS.md");
        // An older registration must have real transaction evidence; replacing
        // only its receipt bytes is not a legitimate migration fixture.
        specgit::assets::AssetStore::lock(
            &f.private,
            &[f.root.clone(), f.private.clone()],
            std::time::Duration::from_secs(2),
        )
        .unwrap()
        .apply(vec![
            specgit::assets::Change::new(
                receipt_path,
                Some(serde_json::to_vec_pretty(&receipt).unwrap()),
            )
            .unwrap(),
            specgit::assets::Change::new(path.clone(), Some(old.as_bytes().to_vec())).unwrap(),
        ])
        .unwrap();
        let old = if edited {
            old.replace("Read this project's", "User changed project's")
        } else {
            old.to_owned()
        };
        let before = format!("Manual rules\r\n{old}\nManual tail\r\n");
        fs::write(&path, &before).unwrap();
        options.agents.clear();
        assert!(install(&options, &f).is_ok());
        let after = fs::read_to_string(&path).unwrap();
        assert!(after.starts_with("Manual rules\r\n"));
        assert!(after.ends_with("\nManual tail\r\n"));
        assert!(after.contains(".agents/skills/specgit-native/SKILL.md"));
        assert!(after.contains("specgit init"));
        assert!(!after.contains("Before tracked product edits"));
        assert_eq!(install(&options, &f).unwrap()["transaction"]["changes"], 0);
    }
}

#[test]
fn project_receipt_v4_is_written_and_legacy_receipts_stay_readable() {
    // New integrations identify one installation and contain no shared root.
    let (f, options) = fixture(vec![Agent::Generic]);
    install(&options, &f).unwrap();
    let receipt: Value =
        serde_json::from_slice(&fs::read(f.private.join("ownership.json")).unwrap()).unwrap();
    assert_eq!(receipt["version"], 4, "{receipt}");
    assert_eq!(receipt["generation"].as_str().unwrap().len(), 64);
    assert!(receipt.get("shared_root").is_none(), "{receipt}");
    assert_eq!(receipt["root"], json!(f.root.canonicalize().unwrap()));
    assert_eq!(receipt["agents"], json!(["generic"]));
    assert_eq!(receipt["purposes"]["generic"], json!([]), "{receipt}");
    assert!(
        receipt["skills"]
            .get(".agents/skills/specgit-native/SKILL.md")
            .is_some()
    );
    assert!(receipt["instructions"].get("generic").is_some());

    // Both historical formats remain readable when transaction evidence is
    // complete. Setup and doctor migrate without losing manual text.
    for version in [1, 2] {
        for through_doctor in [false, true] {
            let (f, mut options) = fixture(vec![]);
            let skill = skill_text();
            let skill_path = f.root.join(".agents/skills/specgit-native/SKILL.md");
            let block = "<!-- specgit:global:v2:start -->\n## SpecGit 2\n\nlegacy 2.3 guidance\n<!-- specgit:global:v2:end -->\n";
            let user = "user rules\n\n";
            let mut legacy = json!({
                "version": version,
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
            if version == 2 {
                legacy.as_object_mut().unwrap().remove("shared_root");
            }
            specgit::assets::AssetStore::lock(
                &f.private,
                &[f.root.clone(), f.private.clone()],
                std::time::Duration::from_secs(2),
            )
            .unwrap()
            .apply(vec![
                specgit::assets::Change::new(skill_path.clone(), Some(skill.as_bytes().to_vec()))
                    .unwrap(),
                specgit::assets::Change::new(
                    f.root.join("AGENTS.md"),
                    Some(format!("{user}{block}").into_bytes()),
                )
                .unwrap(),
                specgit::assets::Change::new(
                    f.private.join("ownership.json"),
                    Some(serde_json::to_vec_pretty(&legacy).unwrap()),
                )
                .unwrap(),
            ])
            .unwrap();
            if through_doctor {
                let plan = health_plan(&f.root, &f.private, &f.source)
                    .unwrap()
                    .unwrap();
                assert_eq!(plan.apply().unwrap().changes, 2);
            } else {
                let result = install(&options, &f).unwrap();
                assert_eq!(result["agents"], json!(["generic"]));
                assert_eq!(result["transaction"]["changes"], 2, "{result}");
            }
            let guidance = fs::read_to_string(f.root.join("AGENTS.md")).unwrap();
            assert!(guidance.starts_with(user), "{guidance}");
            assert!(
                guidance.contains("<!-- specgit:project:v2:start -->"),
                "{guidance}"
            );
            assert!(!guidance.contains("specgit:global:v2"), "{guidance}");
            let receipt: Value =
                serde_json::from_slice(&fs::read(f.private.join("ownership.json")).unwrap())
                    .unwrap();
            assert_eq!(receipt["version"], 4, "{receipt}");
            assert_eq!(receipt["generation"].as_str().unwrap().len(), 64);
            assert!(receipt.get("shared_root").is_none(), "{receipt}");
            options.agents.clear();
            assert_eq!(install(&options, &f).unwrap()["transaction"]["changes"], 0);
            options.uninstall = true;
            install(&options, &f).unwrap();
            assert_eq!(fs::read_to_string(f.root.join("AGENTS.md")).unwrap(), user);
            assert!(!skill_path.exists());
            assert!(!f.private.join("ownership.json").exists());
        }
    }
}

#[test]
fn source_executable_faults_are_rejected_before_any_writes() {
    for fault in [
        "relative",
        "inside project",
        "inside project canonical",
        "missing",
        "empty",
        "mode",
    ] {
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
            "inside project canonical" => {
                let path = f.root.join("copied-fixture");
                fs::copy(&f.source, &path).unwrap();
                path.canonicalize().unwrap()
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
            "inside project" | "inside project canonical" => {
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
    let user = "user guidance\r\n";
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
fn recorded_project_skill_and_guidance_edits_refresh_without_touching_manual_text() {
    let (f, mut options) = fixture(vec![Agent::Claude]);
    fs::write(f.root.join("CLAUDE.md"), "manual prefix\n").unwrap();
    install(&options, &f).unwrap();
    // A later host selection advances the receipt without rewriting the
    // existing Claude assets. Their older journal must remain usable proof.
    let mut add_codex = options.clone();
    add_codex.agents = vec![Agent::Codex];
    install(&add_codex, &f).unwrap();
    let skill = f.root.join(".agents/skills/specgit-native/SKILL.md");
    let guidance = f.root.join("CLAUDE.md");
    fs::write(&skill, "edited managed Skill\n").unwrap();
    let before = fs::read_to_string(&guidance).unwrap();
    fs::write(
        &guidance,
        before.replace("SpecGit 2", "edited managed block"),
    )
    .unwrap();
    let edited = files(&f.base);
    options.dry_run = true;
    install(&options, &f).unwrap();
    assert_eq!(files(&f.base), edited);
    options.dry_run = false;
    install(&options, &f).unwrap();
    let skill_text = fs::read_to_string(&skill).unwrap();
    assert!(skill_text.contains(env!("CARGO_PKG_VERSION")));
    assert!(!skill_text.contains("edited managed Skill"));
    let after = fs::read_to_string(&guidance).unwrap();
    assert!(after.starts_with("manual prefix\n"));
    assert!(after.contains("## SpecGit 2"));
    assert!(!after.contains("edited managed block"));
    assert_eq!(install(&options, &f).unwrap()["transaction"]["changes"], 0);
    fs::write(&skill, "edited again").unwrap();
    options.uninstall = true;
    options.agents.clear();
    assert_eq!(
        install(&options, &f).unwrap_err().code,
        Code::OwnershipConflict
    );
}

#[test]
fn edited_guidance_needs_a_matching_receipt_and_unique_markers() {
    for fault in ["forged receipt", "duplicate marker", "missing marker"] {
        let (f, options) = fixture(vec![Agent::Generic]);
        install(&options, &f).unwrap();
        let path = f.root.join("AGENTS.md");
        let before = fs::read_to_string(&path).unwrap();
        let edited = before.replace("SpecGit 2", "edited managed block");
        match fault {
            "forged receipt" => {
                let receipt_path = f.private.join("ownership.json");
                let mut receipt: Value =
                    serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
                receipt["instructions"]["generic"]["block"] = json!(
                    "<!-- specgit:project:v2:start -->\nforged\n<!-- specgit:project:v2:end -->"
                );
                fs::write(receipt_path, serde_json::to_vec(&receipt).unwrap()).unwrap();
                fs::write(&path, edited).unwrap();
            }
            "duplicate marker" => fs::write(
                &path,
                format!("{edited}\n<!-- specgit:project:v2:start -->"),
            )
            .unwrap(),
            _ => fs::write(&path, edited.replace("<!-- specgit:project:v2:end -->", "")).unwrap(),
        }
        let state = files(&f.base);
        assert_eq!(
            install(&options, &f).unwrap_err().code,
            Code::OwnershipConflict,
            "{fault}"
        );
        assert_eq!(files(&f.base), state, "{fault}");
    }
}

#[test]
fn project_conflicts_preserve_edited_duplicate_and_foreign_assets() {
    for fault in ["foreign skill", "foreign tracked skill", "duplicate hooks"] {
        let (f, mut options) = fixture(vec![Agent::Claude]);
        let skill = f.root.join(".agents/skills/specgit-native/SKILL.md");
        if fault.starts_with("foreign") {
            fs::create_dir_all(skill.parent().unwrap()).unwrap();
            fs::write(&skill, "private foreign text").unwrap();
            if fault == "foreign tracked skill" {
                git(
                    &f.root,
                    &["add", "-f", ".agents/skills/specgit-native/SKILL.md"],
                );
            }
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
            error.message.contains(
                serde_json::to_string(f.root.to_string_lossy().as_ref())
                    .unwrap()
                    .trim_matches('"')
            ),
            "{fault}: {error}"
        );
        if fault.starts_with("foreign") {
            for clause in [
                "Preserve the file and manual content",
                "verify the original ownership record",
                "obtaining authorization",
                "remove that file from the Git index",
                "move the existing local copy to a safe location",
                "then run `specgit init`",
                "Untracking alone leaves the conflicting local file in place",
            ] {
                assert!(
                    error.remedy.contains(clause),
                    "{fault}: missing {clause}: {error}"
                );
            }
        } else {
            assert!(error.remedy.contains("Restore"), "{fault}: {error}");
        }
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
fn first_codex_override_install_ignores_foreign_agents_directory() {
    let (f, options) = fixture(vec![Agent::Codex]);
    fs::create_dir(f.root.join("AGENTS.md")).unwrap();
    fs::write(f.root.join("AGENTS.override.md"), "manual override\n").unwrap();
    let before = files(&f.base);
    let mut preview = options.clone();
    preview.dry_run = true;
    assert!(install(&preview, &f).is_ok());
    assert_eq!(files(&f.base), before);
    assert!(install(&options, &f).is_ok());
    assert!(f.root.join("AGENTS.md").is_dir());
    assert!(
        fs::read_to_string(f.root.join("AGENTS.override.md"))
            .unwrap()
            .contains("## SpecGit 2")
    );
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
        let health_error = match health_plan(&f.root, &f.private, &f.source) {
            Err(error) => error,
            Ok(_) => panic!("health planning must reject the shadowing Codex override"),
        };
        assert_eq!(health_error.code, Code::OwnershipConflict);
        assert!(health_error.message.contains("new Codex override shadows"));
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
fn cli_setup_refreshes_edited_owned_assets_and_converges() {
    let (f, _) = fixture(vec![]);
    fs::write(f.root.join("AGENTS.md"), "manual rules\n").unwrap();
    let args = ["--agent", "generic", "--hook-purpose", "none"];
    assert_eq!(cli(&f.root, &args)["ok"], true);
    let skill = f.root.join(".agents/skills/specgit-native/SKILL.md");
    let guidance = f.root.join("AGENTS.md");
    fs::write(&skill, "edited Skill").unwrap();
    let text = fs::read_to_string(&guidance).unwrap();
    fs::write(&guidance, text.replace("SpecGit 2", "edited managed block")).unwrap();
    let before = files(&f.base);
    assert_eq!(cli(&f.root, &["--dry-run"])["ok"], true);
    assert_eq!(files(&f.base), before);
    assert_eq!(cli(&f.root, &[])["ok"], true);
    let updated = fs::read_to_string(&guidance).unwrap();
    assert!(updated.starts_with("manual rules\n"));
    assert!(updated.contains("## SpecGit 2"));
    assert!(!updated.contains("edited managed block"));
    assert!(!fs::read_to_string(&skill).unwrap().contains("edited Skill"));
    assert_eq!(cli(&f.root, &["--dry-run"])["ok"], true);
    assert_eq!(cli(&f.root, &[])["evidence"]["transaction"]["changes"], 0);
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
fn setup_rejects_shared_executable_from_a_linked_checkout() {
    let (f, mut options) = fixture(vec![Agent::Claude]);
    git(
        &f.root,
        &["worktree", "add", "--detach", "../linked", "HEAD"],
    );
    let linked = f.root.parent().unwrap().join("linked");
    let source = source_fixture(&linked);
    options.dry_run = true;
    let before = files(&f.base);
    let error = project::install(&options, &f.root, &f.private, &source)
        .err()
        .unwrap();
    assert_eq!(error.code, Code::InvalidInput);
    assert_eq!(files(&f.base), before);
    fs::remove_file(linked.join(".git")).unwrap();
    let before = files(&f.base);
    let error = project::install(&options, &f.root, &f.private, &source)
        .err()
        .unwrap();
    assert_eq!(error.code, Code::InvalidInput);
    assert_eq!(files(&f.base), before);
    assert!(install(&options, &f).is_ok());
}

#[test]
fn cli_rejects_ambiguous_or_unsupported_choices_before_writes_and_exports_typed_schema() {
    let (f, _) = fixture(vec![]);
    for args in [
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
        "hook-purpose",
        "opencode-async-rewake",
    ] {
        assert!(text.contains(value), "{value}");
    }
}

#[test]
fn selective_preview_and_legacy_refresh_do_not_enable_wake() {
    use specgit::setup::HookPurpose::*;
    let (f, mut options) = fixture(vec![Agent::Opencode]);
    options.opencode_claude_hooks = true;
    install(&options, &f).unwrap();
    let path = f.root.join(".opencode/hooks.json");
    let legacy = fs::read(&path).unwrap();
    install(&options, &f).unwrap();
    assert_eq!(legacy, fs::read(&path).unwrap());
    assert!(
        !String::from_utf8(legacy.clone())
            .unwrap()
            .contains("asyncRewake")
    );
    let before = files(&f.root);
    options.dry_run = true;
    let hooks = selection(&[Context, Observe], true);
    let preview = install_with_hooks(&options, &hooks, &f.root, &f.private, &f.source).unwrap();
    assert_eq!(preview["written"], false);
    assert_eq!(before, files(&f.root));
    options.dry_run = false;
    let result = install_with_hooks(&options, &hooks, &f.root, &f.private, &f.source).unwrap();
    assert_eq!(result["host_delivery"]["idle_wake"], "not_supported");
    assert_eq!(legacy, fs::read(&path).unwrap());
    options.agents.clear();
    options.opencode_claude_hooks = false;
    options.uninstall = true;
    assert!(
        install_with_hooks(
            &options,
            &selection(&[None], false),
            &f.root,
            &f.private,
            &f.source
        )
        .is_err()
    );
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
            &f.private.parent().unwrap().join("assets"),
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
    let transaction = fs::read_dir(f.private.parent().unwrap().join("assets/transactions"))
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

#[cfg(feature = "test-fixtures")]
#[test]
fn health_plan_reports_prepared_first_install_without_a_receipt() {
    let (f, _) = fixture(vec![]);
    let output = Command::new(env!("CARGO_BIN_EXE_specgit"))
        .current_dir(&f.root)
        .args(["setup", "--agent", "opencode", "--json"])
        .env("SPECGIT_FIXTURE_ASSET_CRASH", "before-write:0")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(99));
    assert!(!f.private.join("ownership.json").exists());
    let journal = fs::read_dir(f.private.parent().unwrap().join("assets/transactions"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path()
        .join("journal.json");
    let journal: Value = serde_json::from_slice(&fs::read(journal).unwrap()).unwrap();
    assert_eq!(journal["state"], "prepared");
    let before = files(&f.base);
    let diagnostic = health_plan(&f.root, &f.private, &f.source).err().unwrap();
    assert_eq!(diagnostic.code, Code::OwnershipConflict);
    assert!(
        diagnostic
            .message
            .contains("interrupted project asset transaction")
    );
    assert_eq!(
        files(&f.base),
        before,
        "inspection attempted recovery or wrote state"
    );
}

#[test]
fn a_clone_adopts_only_the_exact_stable_entry_and_records_its_permissions() {
    let (f, mut options) = fixture(vec![Agent::Generic]);
    install(&options, &f).unwrap();
    let path = f.root.join("AGENTS.md");
    let original = fs::read(&path).unwrap();
    fs::remove_file(f.private.join("ownership.json")).unwrap();
    fs::remove_file(f.root.join(".agents/skills/specgit-native/SKILL.md")).unwrap();
    #[cfg(unix)]
    let inode = {
        use std::os::unix::fs::MetadataExt;
        fs::metadata(&path).unwrap().ino()
    };
    let adopted = install(&options, &f).unwrap();
    assert!(adopted["transaction"]["changes"].as_u64().unwrap() > 0);
    assert_eq!(fs::read(&path).unwrap(), original);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(
            fs::metadata(&path).unwrap().ino(),
            inode,
            "adoption must only record existing guidance"
        );
    }
    options.agents.clear();
    assert_eq!(install(&options, &f).unwrap()["transaction"]["changes"], 0);
    fs::remove_file(f.root.join(".agents/skills/specgit-native/SKILL.md")).unwrap();
    install(&options, &f).unwrap();
    assert_eq!(fs::read(&path).unwrap(), original);
    assert_eq!(install(&options, &f).unwrap()["transaction"]["changes"], 0);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        assert_eq!(
            install(&options, &f).unwrap_err().code,
            Code::OwnershipConflict
        );
    }
}

#[test]
fn fresh_clone_adopts_stable_guidance_with_mixed_line_endings() {
    let (f, mut options) = fixture(vec![Agent::Generic, Agent::Claude]);
    install(&options, &f).unwrap();
    let guidance = [
        ("generic", f.root.join("AGENTS.md")),
        ("claude", f.root.join("CLAUDE.md")),
    ];
    let manual = b"manual prefix\n\r\n\nmanual tail\r\n";
    for (_, path) in &guidance {
        let generated = fs::read_to_string(path).unwrap();
        let crlf = generated.replace('\n', "\r\n");
        fs::write(
            path,
            [
                b"manual prefix\n".as_slice(),
                crlf.as_bytes(),
                b"\nmanual tail\r\n",
            ]
            .concat(),
        )
        .unwrap();
    }
    fs::remove_file(f.private.join("ownership.json")).unwrap();
    fs::remove_file(f.root.join(".agents/skills/specgit-native/SKILL.md")).unwrap();
    fs::remove_file(f.root.join(".claude/skills/specgit-native/SKILL.md")).unwrap();
    // Host hook files are not part of a fresh checkout's guidance clone.
    fs::remove_file(f.root.join(".claude/settings.json")).unwrap();

    let adopted = install(&options, &f).unwrap();
    assert!(adopted["transaction"]["changes"].as_u64().unwrap() > 0);
    let receipt: Value =
        serde_json::from_slice(&fs::read(f.private.join("ownership.json")).unwrap()).unwrap();
    for (host, path) in &guidance {
        let bytes = fs::read(path).unwrap();
        let text = std::str::from_utf8(&bytes).unwrap();
        assert!(text.starts_with("manual prefix\n"), "{host}: {text}");
        assert!(text.ends_with("\nmanual tail\r\n"), "{host}: {text}");
        let block = receipt["instructions"][host]["block"].as_str().unwrap();
        assert!(block.contains("\r\n"), "{host}: {block:?}");
        assert!(text.contains(block), "{host}: receipt block missing");
    }

    assert_eq!(install(&options, &f).unwrap()["transaction"]["changes"], 0);
    options.agents.clear();
    options.uninstall = true;
    install(&options, &f).unwrap();
    for (_, path) in guidance {
        assert_eq!(fs::read(path).unwrap(), manual);
    }
}

#[test]
fn setup_merges_legacy_init_and_project_blocks_without_changing_manual_bytes() {
    let (f, mut options) = fixture(vec![Agent::Generic]);
    install(&options, &f).unwrap();
    let path = f.root.join("AGENTS.md");
    let project = fs::read_to_string(&path).unwrap();
    let old = include_str!("fixtures/stable-guidance/2.11.1-zh.txt");
    fs::write(
        &path,
        format!("manual prefix\r\n{old}\n{project}manual tail\n"),
    )
    .unwrap();
    options.agents.clear();
    install(&options, &f).unwrap();
    let merged = fs::read_to_string(&path).unwrap();
    assert!(merged.starts_with("manual prefix\r\n"));
    assert!(merged.ends_with("manual tail\n"));
    assert!(!merged.contains("<!-- specgit:v2:start -->"));
    assert_eq!(
        merged.matches("<!-- specgit:project:v2:start -->").count(),
        1
    );
    assert_eq!(install(&options, &f).unwrap()["transaction"]["changes"], 0);
}

#[test]
fn cli_setup_rollback_preserves_exclusions_used_by_a_setup_only_sibling() {
    let (f, _) = fixture(vec![]);
    git(
        &f.root,
        &["worktree", "add", "--detach", "../linked", "HEAD"],
    );
    let sibling = f.root.parent().unwrap().join("linked");
    let first = cli(&f.root, &["--agent", "generic", "--hook-purpose", "none"]);
    assert_eq!(first["ok"], true, "{first}");
    let transaction = first["evidence"]["transaction"]["transaction"]
        .as_str()
        .unwrap();
    assert_eq!(
        cli(&sibling, &["--agent", "generic", "--hook-purpose", "none"])["ok"],
        true
    );
    let exclude = PathBuf::from(git(
        &f.root,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "info/exclude",
        ],
    ));
    let before = fs::read(&exclude).unwrap();
    let sibling_before = files(&sibling);
    let rollback = cli(&f.root, &["--rollback", transaction]);
    assert_eq!(rollback["ok"], true, "{rollback}");
    assert_eq!(
        rollback["evidence"]["retained"].as_array().unwrap().len(),
        1
    );
    assert_eq!(fs::read(&exclude).unwrap(), before);
    assert_eq!(files(&sibling), sibling_before);
    assert_eq!(
        git(
            &sibling,
            &["check-ignore", ".agents/skills/specgit-native/SKILL.md"]
        ),
        ".agents/skills/specgit-native/SKILL.md"
    );
}

#[test]
fn setup_uninstall_preserves_a_later_edited_legacy_init_block() {
    let (f, mut options) = fixture(vec![Agent::Generic]);
    install(&options, &f).unwrap();
    let path = f.root.join("AGENTS.md");
    let project = fs::read_to_string(&path).unwrap();
    let legacy =
        include_str!("fixtures/stable-guidance/2.11.1-zh.txt").replace("新任务", "user edit");
    fs::write(&path, format!("{legacy}{project}")).unwrap();
    options.agents.clear();
    options.uninstall = true;
    install(&options, &f).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), legacy);
}

#[test]
fn adopting_a_clone_entry_rollback_preserves_later_manual_content() {
    let (f, mut options) = fixture(vec![Agent::Generic]);
    install(&options, &f).unwrap();
    fs::remove_file(f.private.join("ownership.json")).unwrap();
    fs::remove_file(f.root.join(".agents/skills/specgit-native/SKILL.md")).unwrap();
    let adopted = install(&options, &f).unwrap();
    let path = f.root.join("AGENTS.md");
    let manual = format!(
        "{}later manual bytes\r\n",
        fs::read_to_string(&path).unwrap()
    );
    fs::write(&path, &manual).unwrap();
    options.agents.clear();
    options.rollback = Some(
        adopted["transaction"]["transaction"]
            .as_str()
            .unwrap()
            .into(),
    );
    let before = files(&f.base);
    let error = cli(
        &f.root,
        &["--rollback", options.rollback.as_deref().unwrap()],
    );
    assert_ne!(error["exit"], 0, "{error}");
    assert_eq!(fs::read_to_string(&path).unwrap(), manual);
    assert_eq!(files(&f.base), before);
}

#[test]
fn first_codex_setup_preserves_override_when_migrating_legacy_init_guidance() {
    let (f, _) = fixture(vec![]);
    let legacy = include_str!("fixtures/stable-guidance/2.11.1-zh.txt");
    fs::write(
        f.root.join("AGENTS.md"),
        format!("agents manual\r\n{legacy}agents tail\n"),
    )
    .unwrap();
    let override_manual = "override manual\r\nkeep exact\n";
    fs::write(f.root.join("AGENTS.override.md"), override_manual).unwrap();
    let result = cli(&f.root, &["--agent", "codex", "--hook-purpose", "none"]);
    assert_eq!(result["ok"], true, "{result}");
    let agents = fs::read_to_string(f.root.join("AGENTS.md")).unwrap();
    let override_text = fs::read_to_string(f.root.join("AGENTS.override.md")).unwrap();
    assert!(
        override_text.starts_with(override_manual),
        "{override_text}"
    );
    assert!(agents.starts_with("agents manual\r\n"));
    assert!(agents.contains("agents tail\n"));
    for text in [&agents, &override_text] {
        assert_eq!(
            text.matches("<!-- specgit:project:v2:start -->").count(),
            1,
            "{text}"
        );
        assert!(!text.contains("<!-- specgit:v2:start -->"));
    }
    assert_eq!(cli(&f.root, &[])["evidence"]["transaction"]["changes"], 0);
}

#[test]
fn generic_setup_keeps_proven_legacy_claude_guidance_without_installing_hooks() {
    let (f, _) = fixture(vec![]);
    let legacy = include_str!("fixtures/stable-guidance/2.11.1-zh.txt");
    for name in ["AGENTS.md", "CLAUDE.md"] {
        fs::write(
            f.root.join(name),
            format!("{name} manual\r\n{legacy}{name} tail\n"),
        )
        .unwrap();
    }
    let result = cli(&f.root, &["--agent", "generic"]);
    assert_eq!(result["ok"], true, "{result}");
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
    assert_eq!(cli(&f.root, &[])["evidence"]["transaction"]["changes"], 0);
}

#[test]
fn generic_setup_does_not_claim_an_unproven_legacy_claude_marker() {
    let (f, _) = fixture(vec![]);
    let legacy = include_str!("fixtures/stable-guidance/2.11.1-zh.txt");
    fs::write(f.root.join("AGENTS.md"), legacy).unwrap();
    let edited = legacy.replace("新任务", "unproven manual edit");
    assert_ne!(edited, legacy);
    fs::write(f.root.join("CLAUDE.md"), edited).unwrap();
    let before = files(&f.base);
    let result = cli(&f.root, &["--agent", "generic"]);
    assert_eq!(
        result["diagnostics"][0]["code"], "ownership_conflict",
        "{result}"
    );
    assert_eq!(files(&f.base), before);
}

#[test]
fn cli_reversed_unowned_guidance_markers_return_conflict_without_writes() {
    let (f, _) = fixture(vec![]);
    fs::write(
        f.root.join("AGENTS.md"),
        "<!-- specgit:project:v2:end -->\nmanual\n<!-- specgit:project:v2:start -->",
    )
    .unwrap();
    let before = files(&f.base);
    let output = executable::command()
        .current_dir(&f.root)
        .args([
            "setup",
            "--agent",
            "generic",
            "--hook-purpose",
            "none",
            "--json",
        ])
        .output()
        .unwrap();
    let report: Value = serde_json::from_slice(&output.stdout)
        .expect("setup must return a JSON diagnostic instead of panicking");
    assert!(!output.status.success(), "{report}");
    assert_eq!(
        report["diagnostics"][0]["code"], "ownership_conflict",
        "{report}"
    );
    assert_eq!(files(&f.base), before);
}

#[test]
fn default_setup_previews_and_installs_only_the_shared_baseline() {
    let (f, _) = fixture(vec![]);
    let before = files(&f.base);
    let preview = cli(&f.root, &["--dry-run"]);
    assert_eq!(preview["ok"], true, "{preview}");
    assert_eq!(preview["evidence"]["agents"], json!(["generic"]));
    assert_eq!(files(&f.base), before);
    let applied = cli(&f.root, &[]);
    assert_eq!(applied["ok"], true, "{applied}");
    assert!(
        f.root
            .join(".agents/skills/specgit-native/SKILL.md")
            .is_file()
    );
    assert!(f.root.join("AGENTS.md").is_file());
    for path in [
        ".claude",
        ".codex",
        ".opencode",
        ".git/hooks/pre-commit",
        ".git/hooks/pre-push",
    ] {
        assert!(
            !f.root.join(path).exists(),
            "unexpected integration: {path}"
        );
    }
    let after = files(&f.base);
    let repeat = cli(&f.root, &["--dry-run"]);
    assert_eq!(repeat["ok"], true, "{repeat}");
    assert!(
        repeat["evidence"]["assets"]
            .as_array()
            .unwrap()
            .iter()
            .all(|asset| asset["state"] == "unchanged"),
        "{repeat}"
    );
    assert_eq!(files(&f.base), after);
}

#[test]
fn default_setup_refresh_preserves_existing_named_host_selection() {
    let (f, _) = fixture(vec![]);
    assert_eq!(
        cli(&f.root, &["--agent", "claude", "--hook-purpose", "none"])["ok"],
        true
    );
    let before = files(&f.base);
    let report = cli(&f.root, &["--dry-run"]);
    assert_eq!(report["ok"], true, "{report}");
    assert_eq!(report["evidence"]["agents"], json!(["claude"]));
    assert_eq!(files(&f.base), before);
    assert_eq!(cli(&f.root, &[])["ok"], true);
    assert!(
        f.root
            .join(".claude/skills/specgit-native/SKILL.md")
            .is_file()
    );
    assert!(f.root.join("CLAUDE.md").is_file());
    assert!(!f.root.join(".claude/settings.json").exists());
    assert!(!f.root.join("AGENTS.md").exists());
}

#[cfg(windows)]
#[test]
fn canonical_windows_library_setup_keeps_git_metadata_within_selected_roots() {
    for entry in ["init", "setup", "migrate"] {
        use specgit::setup::HookPurpose::{Context, Guard};
        let (f, mut options) = fixture(vec![Agent::Claude]);
        assert!(f.root.to_string_lossy().starts_with(r"\\?\"));
        let hooks = selection(&[Guard, Context], false);
        options.dry_run = true;
        let before = files(&f.base);
        let preview = install_with_hooks(&options, &hooks, &f.root, &f.private, &f.source).unwrap();
        assert_eq!(preview["written"], false, "{preview}");
        assert_eq!(files(&f.base), before);
        options.dry_run = false;
        let installed =
            install_with_hooks(&options, &hooks, &f.root, &f.private, &f.source).unwrap();
        assert_eq!(installed["written"], true, "{installed}");
        let owned: BTreeMap<_, _> = files(&f.root)
            .into_iter()
            .filter(|(path, _)| {
                !path
                    .components()
                    .any(|component| component.as_os_str() == "transactions")
            })
            .collect();
        options.agents.clear();
        options.uninstall = true;
        options.dry_run = true;
        let before = files(&f.base);
        let preview = install_with_hooks(
            &options,
            &selection(&[], false),
            &f.root,
            &f.private,
            &f.source,
        )
        .unwrap();
        assert_eq!(preview["written"], false, "{preview}");
        assert_eq!(files(&f.base), before);
        options.dry_run = false;
        let removed = install_with_hooks(
            &options,
            &selection(&[], false),
            &f.root,
            &f.private,
            &f.source,
        )
        .unwrap();
        let id = removed["transaction"]["transaction"].as_str().unwrap();
        let output = executable::command()
            .current_dir(&f.root)
            .args([entry, "--rollback", id, "--json"])
            .output()
            .unwrap();
        let rolled: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(output.status.success(), "{entry}: {rolled}");
        assert_eq!(rolled["status"], "rolled_back", "{entry}: {rolled}");
        if entry == "setup" {
            assert_eq!(rolled["evidence"]["scope"], "project", "{rolled}");
        }
        for (path, bytes) in owned {
            assert_eq!(fs::read(&path).unwrap(), bytes, "{}", path.display());
        }
    }
}
