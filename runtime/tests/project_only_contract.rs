use serde_json::{Value, json};
use specgit::{
    assets::{AssetStore, Change},
    diagnostic::Code,
    setup::{Agent, project},
};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};
#[path = "support/executable.rs"]
mod executable;

fn git(root: &Path, args: &[&str]) {
    let out = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}
fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let root = base.join("checkout");
    fs::create_dir(&root).unwrap();
    git(&root, &["init", "--initial-branch=main"]);
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
    git(
        &root,
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/owner/repo.git",
        ],
    );
    fs::write(
        root.join(".specgit.yaml"),
        "version: 2\nremote: origin\ntarget: main\nlanguage: en\n",
    )
    .unwrap();
    let source_dir = base.join("cli's $ literal");
    fs::create_dir(&source_dir).unwrap();
    let source = source_dir.join(if cfg!(windows) {
        "specgit.exe"
    } else {
        "specgit"
    });
    fs::copy(executable::binary(), &source).unwrap();
    let private = root.join(".git/specgit-v2/agent-assets");
    (temp, root, private, source)
}
fn options(agents: Vec<Agent>, custom: bool) -> project::Options {
    project::Options {
        agents,
        opencode_claude_hooks: custom,
        uninstall: false,
        dry_run: false,
        rollback: None,
    }
}
fn value(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}
fn checkpoint(root: &Path) {
    fs::write(root.join(".git/specgit-v2/selection.json"), serde_json::to_vec(&json!({
        "version":2,"repository":{"provider":"github","host":"github.com","path":"owner/repo"},
        "project_id":7,"branch":"main","target":"main","issues":[41],
        "intents":[{"title":"feat: fixture","body":"## Why\nfixture\n\n## Scope\nfixture\n\n## Approach\nfixture\n\n## Acceptance\nfixture","labels":[],"issue":41,"write_started":true}],
        "request":null,"request_intent":null,"request_write_started":false
    })).unwrap()).unwrap();
}
fn invoke(entry: &Value, payload: Value) -> Value {
    let hook = &entry["hooks"][0];
    let mut child = Command::new(hook["shell"].as_str().unwrap())
        .args(["-c", hook["command"].as_str().unwrap()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&payload).unwrap())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    if out.stdout.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&out.stdout).unwrap()
    }
}

#[test]
fn custom_hooks_reject_host_expansion_tokens_before_asset_writes() {
    for token in ["${CLAUDE_PLUGIN_ROOT}", "${CLAUDE_PLUGIN_DATA}"] {
        let (_temp, root, private, source) = fixture();
        let directory = source.parent().unwrap().join(token);
        fs::create_dir(&directory).unwrap();
        let reserved_source = directory.join(source.file_name().unwrap());
        fs::copy(&source, &reserved_source).unwrap();
        assert!(
            project::install(
                &options(vec![Agent::Opencode], true),
                &root,
                &private,
                &reserved_source
            )
            .is_err()
        );
        assert!(!private.exists());
        assert!(!root.join(".opencode").exists());
        assert!(!root.join("AGENTS.md").exists());
    }
}

#[test]
fn custom_hooks_are_project_owned_literal_commands_and_preserve_foreign_events() {
    let (_temp, root, private, source) = fixture();
    let path = root.join(".opencode/hooks.json");
    fs::create_dir(path.parent().unwrap()).unwrap();
    let foreign = json!({"SessionStart":[{"matcher":"*","hooks":[{"type":"command","command":"foreign command"}]}],"FileChanged":[]});
    fs::write(&path, serde_json::to_vec(&foreign).unwrap()).unwrap();
    let mut opts = options(vec![Agent::Opencode], true);
    opts.dry_run = true;
    let before = fs::read(&path).unwrap();
    project::install(&opts, &root, &private, &source).unwrap();
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(!private.exists());
    opts.dry_run = false;
    let result = project::install(&opts, &root, &private, &source).unwrap();
    assert_eq!(result["opencode_claude_hooks"], true);
    assert_eq!(result["host_delivery"]["imported_event"], "not_checked");
    let installed = value(&path);
    assert!(installed.get("hooks").is_none());
    assert_eq!(installed["SessionStart"][0], foreign["SessionStart"][0]);
    for event in ["SessionStart", "PreToolUse", "PostToolUse", "Stop"] {
        let entry = installed[event].as_array().unwrap().last().unwrap();
        let hook = &entry["hooks"][0];
        assert_eq!(hook["inputFormat"], "claude-code");
        assert_eq!(hook["shell"], "bash");
        assert!(hook.get("args").is_none());
        assert!(hook.get("async").is_none());
        assert!(!hook["command"].as_str().unwrap().contains("--state-root"));
    }
    opts.agents.clear();
    opts.opencode_claude_hooks = false;
    assert_eq!(
        project::install(&opts, &root, &private, &source).unwrap()["transaction"]["changes"],
        0
    );
    let context = invoke(
        installed["SessionStart"]
            .as_array()
            .unwrap()
            .last()
            .unwrap(),
        json!({"hook_event_name":"SessionStart","session_id":"ses_native-fork","cwd":root}),
    );
    assert!(
        context["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap()
            .contains("Remote state is not checked")
    );
    opts.uninstall = true;
    project::install(&opts, &root, &private, Path::new("missing-executable")).unwrap();
    assert_eq!(value(&path), foreign);
    assert!(!private.join("ownership.json").exists());
}

#[test]
fn custom_host_protocol_denies_patch_aliases_and_accepts_only_current_checkpoint() {
    let (_temp, root, private, source) = fixture();
    project::install(
        &options(vec![Agent::Opencode], true),
        &root,
        &private,
        &source,
    )
    .unwrap();
    let hooks = value(&root.join(".opencode/hooks.json"));
    let entry = &hooks["PreToolUse"][0];
    for tool in [
        "Write",
        "Edit",
        "apply_patch",
        "functions.apply_patch",
        "mcp__functions__apply_patch",
    ] {
        let payload = json!({"hook_event_name":"PreToolUse","session_id":"ses_native-fork","cwd":root,"tool_name":tool,
            "tool_input":{"file_path":root.join("src/lib.rs"),"patchText":format!("*** Begin Patch\n*** Add File: {}\n+x\n*** End Patch",root.join("src/lib.rs").display())}});
        assert_eq!(
            invoke(entry, payload)["hookSpecificOutput"]["permissionDecision"],
            "deny",
            "{tool}"
        );
    }
    let readonly = json!({"hook_event_name":"PreToolUse","session_id":"ses_native-fork","cwd":root,"tool_name":"Read","tool_input":{"file_path":"src/lib.rs"}});
    assert!(invoke(entry, readonly).is_null());
    checkpoint(&root);
    let allowed = json!({"hook_event_name":"PreToolUse","session_id":"ses_native-fork","cwd":root,"tool_name":"Edit","tool_input":{"file_path":"src/lib.rs"}});
    let result = invoke(entry, allowed.clone());
    assert!(
        result["hookSpecificOutput"]
            .get("permissionDecision")
            .is_none()
    );
    assert!(result["hookSpecificOutput"]["additionalContext"].is_string());
    git(&root, &["checkout", "-b", "other"]);
    assert_eq!(
        invoke(entry, allowed)["hookSpecificOutput"]["permissionDecision"],
        "deny"
    );
}

#[test]
fn patch_text_and_move_destination_resolve_the_actual_repository() {
    let (_temp, root, private, source) = fixture();
    let (_other_temp, other, _, _) = fixture();
    project::install(
        &options(vec![Agent::Opencode], true),
        &root,
        &private,
        &source,
    )
    .unwrap();
    checkpoint(&root);
    let entry = &value(&root.join(".opencode/hooks.json"))["PreToolUse"][0];
    let cross = json!({"hook_event_name":"PreToolUse","session_id":"ses_patch-target","cwd":root,"tool_name":"functions.apply_patch",
        "tool_input":{"patchText":format!("*** Begin Patch\n*** Update File: {}\n*** Move to: {}\n+x\n*** End Patch",root.join("a.rs").display(),other.join("b.rs").display())}});
    assert!(
        invoke(entry, cross)["hookSpecificOutput"]["permissionDecisionReason"]
            .as_str()
            .unwrap()
            .contains("multiple repositories")
    );
    let other_only = json!({"hook_event_name":"PreToolUse","session_id":"ses_patch-target","cwd":root,"tool_name":"apply_patch",
        "tool_input":{"patchText":format!("*** Begin Patch\n*** Add File: {}\n+x\n*** End Patch",other.join("b.rs").display())}});
    assert_eq!(
        invoke(entry, other_only)["hookSpecificOutput"]["permissionDecision"],
        "deny"
    );
}

#[test]
fn legacy_project_receipt_refresh_and_removal_never_require_the_global_root() {
    for refresh in [false, true] {
        let (temp, root, private, source) = fixture();
        let mut opts = options(vec![Agent::Claude, Agent::Opencode], false);
        project::install(&opts, &root, &private, &source).unwrap();
        let receipt_path = private.join("ownership.json");
        let mut receipt = value(&receipt_path);
        let global = temp
            .path()
            .canonicalize()
            .unwrap()
            .join("retired-global-data");
        fs::create_dir(&global).unwrap();
        fs::write(global.join("user-data"), b"retain legacy data exactly").unwrap();
        receipt["version"] = json!(1);
        receipt["shared_root"] = json!(global);
        let mut changes = vec![];
        for host in ["generic", "claude"] {
            let path = root.join(
                receipt["instructions"][host]["instructions"]
                    .as_str()
                    .unwrap(),
            );
            let block = receipt["instructions"][host]["block"]
                .as_str()
                .unwrap()
                .replace("specgit:project:v2:", "specgit:global:v2:");
            receipt["instructions"][host]["block"] = json!(block);
            changes.push(
                Change::new(
                    path.clone(),
                    Some(
                        fs::read_to_string(path)
                            .unwrap()
                            .replace("specgit:project:v2:", "specgit:global:v2:")
                            .into_bytes(),
                    ),
                )
                .unwrap(),
            );
        }
        let settings = root.join(".claude/settings.json");
        let mut hooks = value(&settings);
        for event in ["SessionStart", "PreToolUse", "PostToolUse", "Stop"] {
            let group = &mut hooks["hooks"][event][0];
            for hook in group["hooks"].as_array_mut().unwrap() {
                hook["command"] = json!(global.join("missing-2.3-executable"));
                hook["args"]
                    .as_array_mut()
                    .unwrap()
                    .extend([json!("--state-root"), json!(global)]);
            }
            receipt["hooks"]["claude"]["entries"][event] = group.clone();
        }
        changes.push(Change::new(settings, Some(serde_json::to_vec(&hooks).unwrap())).unwrap());
        changes.push(
            Change::new(
                receipt_path.clone(),
                Some(serde_json::to_vec(&receipt).unwrap()),
            )
            .unwrap(),
        );
        AssetStore::lock(
            &private,
            &[root.clone(), private.clone()],
            Duration::from_secs(1),
        )
        .unwrap()
        .apply(changes)
        .unwrap();
        opts.agents.clear();
        if refresh {
            project::install(&opts, &root, &private, &source).unwrap();
            let current = value(&receipt_path);
            assert_eq!(current["version"], 2);
            assert!(current.get("shared_root").is_none());
            assert!(
                !fs::read_to_string(root.join("AGENTS.md"))
                    .unwrap()
                    .contains("specgit:global:v2:")
            );
            assert!(
                !fs::read_to_string(root.join(".claude/settings.json"))
                    .unwrap()
                    .contains("--state-root")
            );
        }
        opts.uninstall = true;
        project::install(&opts, &root, &private, Path::new("unavailable-CLI")).unwrap();
        assert_eq!(
            fs::read(global.join("user-data")).unwrap(),
            b"retain legacy data exactly"
        );
        assert!(!root.join(".agents/skills/specgit-native/SKILL.md").exists());
        assert!(!root.join(".claude/settings.json").exists());
        assert!(!receipt_path.exists());
    }
}

#[test]
fn custom_mode_rejects_foreign_identical_edited_and_duplicate_groups_without_mutation() {
    for fault in ["identical", "edited", "duplicate"] {
        let (_temp, root, private, source) = fixture();
        let mut opts = options(vec![Agent::Opencode], true);
        project::install(&opts, &root, &private, &source).unwrap();
        let path = root.join(".opencode/hooks.json");
        let mut hooks = value(&path);
        match fault {
            "edited" => {
                hooks["SessionStart"][0]["hooks"][0]["command"] = json!("private edited text")
            }
            "duplicate" => {
                let entry = hooks["SessionStart"][0].clone();
                hooks["SessionStart"].as_array_mut().unwrap().push(entry);
            }
            _ => {
                fs::remove_file(private.join("ownership.json")).unwrap();
            }
        }
        fs::write(&path, serde_json::to_vec(&hooks).unwrap()).unwrap();
        let before = fs::read(&path).unwrap();
        opts.dry_run = true;
        let error = project::install(&opts, &root, &private, &source).unwrap_err();
        assert_eq!(error.code, Code::OwnershipConflict);
        assert!(!error.message.contains("private edited text"));
        assert_eq!(fs::read(&path).unwrap(), before);
    }
}
