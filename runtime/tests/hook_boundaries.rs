#![cfg(feature = "test-fixtures")]
#[allow(dead_code)]
#[path = "support/delivery.rs"]
mod delivery;
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    process::Stdio,
    time::{Duration, Instant},
};

fn hook(f: &delivery::Fixture, event: &str, payload: Value) -> std::process::Output {
    let mut child = f
        .command(&["hook", "--event", event])
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
    child.wait_with_output().unwrap()
}

fn add_linked_worktree(
    root: &std::path::Path,
    branch: &str,
) -> (tempfile::TempDir, std::path::PathBuf) {
    // Git for Windows rejects Rust's verbatim absolute paths. Give the worktree
    // a unique sibling directory and pass its ordinary relative path instead.
    let parent = tempfile::tempdir_in(root.parent().unwrap()).unwrap();
    let parent_name = parent.path().file_name().unwrap().to_str().unwrap();
    let name = format!("../{parent_name}/linked");
    let output = std::process::Command::new("git")
        .current_dir(root)
        .args(["worktree", "add", "-b", branch, &name])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let linked = parent.path().join("linked").canonicalize().unwrap();
    (parent, linked)
}

#[test]
fn legacy_callbacks_return_before_reading_stalled_or_malformed_input() {
    let f = delivery::Fixture::new("github");
    for event in ["PostToolUse", "Stop"] {
        for observe in [false, true] {
            let mut command = f.command(&["hook", "--event", event]);
            if observe {
                command.arg("--observe");
            }
            let mut child = command
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let held_stdin = child.stdin.take().unwrap();
            let deadline = Instant::now() + Duration::from_secs(1);
            while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            if child.try_wait().unwrap().is_none() {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("{event} observe={observe} waited for stdin");
            }
            drop(held_stdin);
            let output = child.wait_with_output().unwrap();
            assert!(output.status.success());
            assert!(output.stdout.is_empty());
            assert!(output.stderr.is_empty());
        }
        let output = hook(&f, event, json!({"hook_event_name":"wrong"}));
        assert!(output.stdout.is_empty());
        assert!(output.stderr.is_empty());
    }
    assert!(f.state()["calls"].as_array().unwrap().is_empty());
}
#[test]
fn ordinary_edits_are_quiet_without_a_checkpoint() {
    let f = delivery::Fixture::new("github");
    fs::write(f.root.join("unrelated.txt"), "dirty").unwrap();
    for (tool, input) in [
        ("Write", json!({"file_path":f.root.join("src.rs")})),
        ("Bash", json!({"command":"cargo fmt && git add -A"})),
    ] {
        let output = hook(
            &f,
            "PreToolUse",
            json!({"session_id":"boundary","hook_event_name":"PreToolUse","cwd":f.root,"tool_name":tool,"tool_input":input}),
        );
        assert!(output.status.success());
        assert!(
            output.stdout.is_empty(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(output.stderr.is_empty());
    }
}
#[test]
fn setup_guard_installs_git_hooks_and_context_only_uses_allowed_events() {
    let f = delivery::Fixture::new("github");
    let report = f.run(&[
        "setup",
        "--agent",
        "codex",
        "--hook-purpose",
        "guard",
        "--hook-purpose",
        "context",
        "--hook-purpose",
        "observe",
    ]);
    assert_eq!(report["exit"], 0, "{report}");
    assert!(f.root.join(".git/hooks/pre-commit").is_file());
    assert!(f.root.join(".git/hooks/pre-push").is_file());
    let settings: Value =
        serde_json::from_slice(&fs::read(f.root.join(".codex/hooks.json")).unwrap()).unwrap();
    let events = settings["hooks"].as_object().unwrap();
    assert_eq!(events.len(), 2);
    assert!(events.contains_key("SessionStart"));
    assert!(events.contains_key("PreToolUse"));
    assert_eq!(
        report["evidence"]["host_delivery"]["idle_wake"],
        "not_supported"
    );
    assert!(
        !report["evidence"]["hook_purposes"]["codex"]["installed"]
            .as_array()
            .unwrap()
            .iter()
            .any(|purpose| purpose == "observe")
    );
}

fn guard(f: &delivery::Fixture, action: &str) -> Value {
    let output = f.command(&["guard", action]).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn setup_borrows_independent_guard_and_never_removes_its_assets() {
    let f = delivery::Fixture::new("github");
    guard(&f, "--install");
    let receipt = f.root.join(".git/specgit-v2/guard-hooks.json");
    let owned = fs::read(&receipt).unwrap();
    let hooks: Vec<_> = ["pre-commit", "pre-push"]
        .map(|name| fs::read(f.root.join(".git/hooks").join(name)).unwrap())
        .into();
    let installed = f.run(&["setup", "--agent", "generic", "--hook-purpose", "guard"]);
    assert_eq!(installed["exit"], 0, "{installed}");
    assert_eq!(
        installed["evidence"]["native_guard"]["ownership"],
        "borrowed"
    );
    assert!(
        !f.root
            .join(".git/specgit-v2/setup-guard-hooks.json")
            .exists()
    );
    assert_eq!(fs::read(&receipt).unwrap(), owned);
    let retained = guard(&f, "--uninstall");
    assert!(retained["retained"].is_object(), "{retained}");
    let removed = f.run(&["setup", "--uninstall"]);
    assert_eq!(removed["exit"], 0, "{removed}");
    assert_eq!(fs::read(&receipt).unwrap(), owned);
    for (index, stage) in ["pre-commit", "pre-push"].iter().enumerate() {
        assert_eq!(
            fs::read(f.root.join(".git/hooks").join(stage)).unwrap(),
            hooks[index]
        );
    }
    guard(&f, "--uninstall");
    assert!(!receipt.exists());
}

#[test]
fn explicit_guard_install_transfers_setup_source_atomically_and_remains_maintainable() {
    let f = delivery::Fixture::new("github");
    let installed = f.run(&["setup", "--agent", "generic", "--hook-purpose", "guard"]);
    assert_eq!(installed["exit"], 0, "{installed}");
    let private = f.root.join(".git/specgit-v2");
    assert!(private.join("setup-guard-hooks.json").is_file());
    let hook = f.root.join(".git/hooks/pre-commit");
    let before = fs::read(&hook).unwrap();
    let transferred = guard(&f, "--install");
    assert!(
        transferred["transaction"]["transaction"].is_string(),
        "{transferred}"
    );
    assert!(!private.join("setup-guard-hooks.json").exists());
    assert!(private.join("guard-hooks.json").is_file());
    assert_eq!(fs::read(&hook).unwrap(), before);
    assert_eq!(guard(&f, "--install")["transaction"]["changes"], 0);
    assert!(guard(&f, "--uninstall")["retained"].is_object());
    let refreshed = f.run(&["setup"]);
    assert_eq!(refreshed["exit"], 0, "{refreshed}");
    assert_eq!(
        refreshed["evidence"]["native_guard"]["ownership"],
        "borrowed"
    );
    assert_eq!(f.run(&["setup", "--uninstall"])["exit"], 0);
    guard(&f, "--uninstall");
    assert!(!hook.exists());
}

#[cfg(unix)]
#[test]
fn setup_guard_transfer_rejects_permission_changes_without_rewriting_any_source() {
    use std::os::unix::fs::PermissionsExt;
    let f = delivery::Fixture::new("github");
    assert_eq!(
        f.run(&["setup", "--agent", "generic", "--hook-purpose", "guard"])["exit"],
        0
    );
    let private = f.root.join(".git/specgit-v2");
    let receipt = fs::read(private.join("setup-guard-hooks.json")).unwrap();
    let hook = f.root.join(".git/hooks/pre-commit");
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o700)).unwrap();
    let output = f.command(&["guard", "--install"]).output().unwrap();
    assert!(!output.status.success());
    assert_eq!(
        fs::read(private.join("setup-guard-hooks.json")).unwrap(),
        receipt
    );
    assert!(!private.join("guard-hooks.json").exists());
    assert_eq!(
        fs::metadata(&hook).unwrap().permissions().mode() & 0o777,
        0o700
    );
}

#[test]
fn legacy_host_guard_migration_and_native_install_share_recoverable_transaction() {
    use specgit::assets::{AssetStore, Change};
    let f = delivery::Fixture::new("github");
    assert_eq!(
        f.run(&["setup", "--agent", "codex", "--hook-purpose", "context"])["exit"],
        0
    );
    let private = f.root.join(".git/specgit-v2");
    let settings = f.root.join(".codex/hooks.json");
    let receipt = private.join("agent-assets/ownership.json");
    let mut config: Value = serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
    let mut owner: Value = serde_json::from_slice(&fs::read(&receipt).unwrap()).unwrap();
    let command = config["hooks"]["SessionStart"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap()
        .to_owned();
    for event in ["SessionStart", "PreToolUse", "PostToolUse", "Stop"] {
        let group = json!({"matcher":if event == "PreToolUse" || event == "PostToolUse" {"Write|Bash"} else {""},"hooks":[{"type":"command","command":command.replace("--event SessionStart", &format!("--event {event}")),"timeout":5}]});
        config["hooks"][event] = json!([group.clone()]);
        owner["hooks"]["codex"]["entries"][event] = group;
    }
    owner["version"] = json!(3);
    owner.as_object_mut().unwrap().remove("purposes");
    owner["hooks"]["codex"]["created_event_keys"] =
        json!(["SessionStart", "PreToolUse", "PostToolUse", "Stop"]);
    let foreign = json!({"matcher":"*","hooks":[{"type":"command","command":"foreign-stop"}]});
    config["hooks"]["Stop"]
        .as_array_mut()
        .unwrap()
        .push(foreign.clone());
    AssetStore::lock(
        &private.join("assets"),
        &[f.root.clone(), private.clone()],
        Duration::from_secs(2),
    )
    .unwrap()
    .apply(vec![
        Change::new(
            settings.clone(),
            Some(serde_json::to_vec_pretty(&config).unwrap()),
        )
        .unwrap(),
        Change::new(
            receipt.clone(),
            Some(serde_json::to_vec_pretty(&owner).unwrap()),
        )
        .unwrap(),
    ])
    .unwrap();
    let legacy_settings = fs::read(&settings).unwrap();
    let legacy_receipt = fs::read(&receipt).unwrap();
    let crashed = f
        .feature_command(&["setup"])
        .env("SPECGIT_FIXTURE_ASSET_CRASH", "before-commit")
        .output()
        .unwrap();
    assert_eq!(
        crashed.status.code(),
        Some(99),
        "{}",
        String::from_utf8_lossy(&crashed.stdout)
    );
    let pending = AssetStore::lock(
        &private.join("assets"),
        &[f.root.clone(), private.clone()],
        Duration::from_secs(2),
    )
    .unwrap()
    .pending_transactions()
    .unwrap();
    assert_eq!(pending.len(), 1);
    let restored = f.run(&["setup", "--rollback", &pending[0]]);
    assert_eq!(restored["exit"], 0, "{restored}");
    assert_eq!(fs::read(&settings).unwrap(), legacy_settings);
    assert_eq!(fs::read(&receipt).unwrap(), legacy_receipt);
    assert!(!f.root.join(".git/hooks/pre-commit").exists());
    let migrated = f.run(&["setup"]);
    assert_eq!(migrated["exit"], 0, "{migrated}");
    assert!(f.root.join(".git/hooks/pre-commit").is_file());
    let config: Value = serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
    assert!(config["hooks"].get("PostToolUse").is_none());
    assert_eq!(config["hooks"]["Stop"], json!([foreign]));
    assert_eq!(
        config["hooks"]["PreToolUse"][0]["hooks"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(f.run(&["setup"])["evidence"]["transaction"]["changes"], 0);
}

#[test]
fn setup_rollback_keeps_native_guard_owned_for_a_linked_worktree() {
    let f = delivery::Fixture::new("github");
    let installed = f.run(&["setup", "--agent", "generic", "--hook-purpose", "guard"]);
    assert_eq!(installed["exit"], 0, "{installed}");
    let transaction = installed["evidence"]["transaction"]["transaction"]
        .as_str()
        .unwrap();
    let (_worktree_parent, sibling) = add_linked_worktree(&f.root, "linked");
    let hook = f.root.join(".git/hooks/pre-commit");
    let before = fs::read(&hook).unwrap();
    let rollback = f.run(&["setup", "--rollback", transaction]);
    assert_eq!(rollback["exit"], 0, "{rollback}");
    assert_eq!(fs::read(&hook).unwrap(), before);
    assert!(
        f.root
            .join(".git/specgit-v2/setup-guard-hooks.json")
            .is_file()
    );
    let retained = rollback["evidence"]["retained"].as_array().unwrap();
    for name in ["pre-commit", "pre-push", "setup-guard-hooks.json"] {
        assert!(
            retained.iter().any(|entry| entry["path"]
                .as_str()
                .is_some_and(|path| path.ends_with(name))),
            "{rollback}"
        );
    }
    let mut command = f.command(&["guard", "--stage", "pre-commit"]);
    let staged = std::process::Command::new("git")
        .current_dir(&sibling)
        .args(["add", "-N", ".specgit.yaml"])
        .output()
        .unwrap();
    assert!(staged.status.success());
    fs::write(
        sibling.join(".specgit.yaml"),
        "version: 2\nprovider: github\nremote: origin\n",
    )
    .unwrap();
    assert!(
        std::process::Command::new("git")
            .current_dir(&sibling)
            .args(["add", ".specgit.yaml"])
            .output()
            .unwrap()
            .status
            .success()
    );
    let denied = command.current_dir(&sibling).output().unwrap();
    assert!(!denied.status.success());
    assert!(
        String::from_utf8_lossy(&denied.stderr).contains("checkpoint"),
        "{denied:?}"
    );
}

#[tokio::test]
async fn typed_guard_plan_rejects_changed_git_layout_before_any_setup_write() {
    let f = delivery::Fixture::new("github");
    let process = specgit::process::Process::default();
    let native = specgit::guard::setup_plan_with_executable(
        &process,
        &f.root,
        true,
        &delivery::executable::binary(),
    )
    .await
    .unwrap();
    let options = specgit::setup::project::Options {
        agents: vec![specgit::setup::Agent::Generic],
        opencode_claude_hooks: false,
        uninstall: false,
        dry_run: false,
        rollback: None,
    };
    let hooks = specgit::setup::HookOptions {
        purposes: vec![specgit::setup::HookPurpose::Guard],
        opencode_async_rewake: false,
    };
    let changed = std::process::Command::new("git")
        .current_dir(&f.root)
        .args(["config", "core.hooksPath", "different-hooks"])
        .output()
        .unwrap();
    assert!(changed.status.success());
    let result = specgit::setup::project::install_with_guard_plan(
        &options,
        &hooks,
        &f.root,
        &f.root.join(".git/specgit-v2/agent-assets"),
        &delivery::executable::binary(),
        native,
    );
    assert!(result.is_err());
    assert!(!f.root.join("AGENTS.md").exists());
    assert!(!f.root.join(".git/hooks/pre-commit").exists());
    assert!(
        !f.root
            .join(".git/specgit-v2/agent-assets/ownership.json")
            .exists()
    );
}

#[test]
fn session_rules_state_the_declared_label_mode() {
    let f = delivery::Fixture::new("github");
    let tags = "tags:\n- name: area::cli\n  color: 0e8a16\n";
    for (language, labels, extra, rule) in [
        (
            "en",
            "off",
            "",
            "Label mode off: pass --tags only when the user or project asks.",
        ),
        (
            "en",
            "kind",
            "",
            "Label mode kind: omit --tags so the title derives one kind::<type>",
        ),
        (
            "en",
            "project",
            tags,
            "Label mode project: pass --tags only from declared tags.",
        ),
        (
            "zh",
            "off",
            "",
            "Label 模式 off：仅在用户或项目要求时传 --tags。",
        ),
        (
            "zh",
            "kind",
            "",
            "Label 模式 kind：省略 --tags，由标题派生唯一 kind::<type>",
        ),
        (
            "zh",
            "project",
            tags,
            "Label 模式 project：--tags 只能取声明的 tags。",
        ),
    ] {
        fs::write(
            f.root.join(".specgit.yaml"),
            format!(
                "version: 2\nremote: origin\nprovider: github\nlanguage: {language}\nvalidation:\n  labels: {labels}\n{extra}"
            ),
        )
        .unwrap();
        let session = format!("labels-{language}-{labels}");
        let out = hook(
            &f,
            "SessionStart",
            json!({"session_id":session,"hook_event_name":"SessionStart","cwd":f.root}),
        );
        assert!(out.status.success(), "{out:?}");
        let context: Value = serde_json::from_slice(&out.stdout).unwrap();
        let text = context["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap();
        assert!(text.contains(rule), "{language}/{labels}: {text}");
        let others = ["off", "kind", "project"]
            .into_iter()
            .filter(|m| *m != labels);
        for other in others {
            assert!(!text.contains(&format!("mode {other}")), "{text}");
            assert!(!text.contains(&format!("模式 {other}")), "{text}");
        }
    }
}

#[test]
fn context_offer_cache_rolls_over_and_deduplicates_without_losing_new_sessions() {
    let f = delivery::Fixture::new("github");
    let directory = f.root.join(".git/specgit-v2/hook-context");
    fs::create_dir_all(&directory).unwrap();
    let entries: Vec<_> = (0..128).map(|index| json!({"key":specgit::assets::hash(format!("older-session-{index}").as_bytes()),"digest":specgit::assets::hash(b"old context")})).collect();
    fs::write(
        directory.join("offers.json"),
        serde_json::to_vec(&json!({"version":1,"entries":entries})).unwrap(),
    )
    .unwrap();
    let payload = json!({"session_id":"new-session","hook_event_name":"SessionStart","cwd":f.root});
    let first = hook(&f, "SessionStart", payload.clone());
    assert!(first.status.success());
    let offered: Value = serde_json::from_slice(&first.stdout).unwrap();
    assert!(
        offered["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap()
            .contains("SKILL.md")
    );
    let repeated = hook(&f, "SessionStart", payload);
    assert!(repeated.status.success());
    assert!(repeated.stdout.is_empty());
    let retained: Value =
        serde_json::from_slice(&fs::read(directory.join("offers.json")).unwrap()).unwrap();
    assert_eq!(retained["entries"].as_array().unwrap().len(), 128);
}

#[tokio::test]
async fn failed_pending_context_read_can_retry_all_offers_in_the_same_session() {
    use specgit::{
        identity::Provider,
        process::Process,
        selection::{IssueIntent, Locked, Selection},
        watch_store::{EventState, Goal, Identity, Revision, Store},
    };
    let f = delivery::Fixture::new("github");
    let context = specgit::config::resolve(
        &Process::default(),
        &f.root,
        None,
        Some(Provider::Github),
        None,
    )
    .await
    .unwrap();
    Locked::acquire(&context)
        .unwrap()
        .save(&Selection {
            version: 2,
            repository: context.repository.clone(),
            project_id: 7,
            branch: context.branch.clone().unwrap(),
            target: "main".into(),
            issues: vec![],
            intents: vec![IssueIntent {
                title: "feat: interrupted issue creation".into(),
                body: "Specification awaiting native reconciliation.".into(),
                labels: vec![],
                issue: None,
                write_started: true,
            }],
            adopted: vec![],
            request: Some(7),
            request_write_started: false,
            request_intent: None,
            delivered_request: None,
        })
        .unwrap();
    let session = "retry-context";
    let identity = Identity::new(&context, session, 7, Goal::Lifecycle).unwrap();
    Store::new(identity.clone())
        .unwrap()
        .publish(
            Revision {
                head: "a".repeat(40),
                local_head: "a".repeat(40),
                target: "main".into(),
                declaration: "b".repeat(64),
                evidence_digest: "c".repeat(64),
            },
            EventState::Unknown,
            "Evidence needs refresh.".into(),
            "Inspect native evidence.".into(),
            1,
        )
        .unwrap();
    let state = context
        .git_dir
        .join("specgit-v2/subscriptions")
        .join(identity.key())
        .join("state.json");
    let valid = fs::read(&state).unwrap();
    fs::write(&state, "malformed watch state").unwrap();
    let offers = context.git_dir.join("specgit-v2/hook-context/offers.json");
    let payload = json!({"session_id":session,"hook_event_name":"SessionStart","cwd":f.root});
    let failed = hook(&f, "SessionStart", payload.clone());
    assert!(failed.stdout.is_empty());
    assert!(!failed.stderr.is_empty());
    assert!(
        !offers.exists(),
        "failed context delivery consumed advisory offers"
    );

    fs::write(&state, &valid).unwrap();
    let retried = hook(&f, "SessionStart", payload.clone());
    assert!(retried.status.success());
    assert!(retried.stderr.is_empty());
    let output: Value = serde_json::from_slice(&retried.stdout).unwrap();
    let text = output["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap();
    for expected in [
        "SKILL.md",
        "uncertain native write",
        "unverified event receipts",
    ] {
        assert!(text.contains(expected), "missing {expected}: {text}");
    }
    let offered: Value = serde_json::from_slice(&fs::read(&offers).unwrap()).unwrap();
    assert_eq!(offered["entries"].as_array().unwrap().len(), 3);
    let repeated = hook(&f, "SessionStart", payload);
    assert!(repeated.status.success());
    assert!(repeated.stdout.is_empty());
    assert!(repeated.stderr.is_empty());
    assert_eq!(fs::read(&state).unwrap(), valid);
    assert!(f.state()["calls"].as_array().unwrap().is_empty());

    // The first write is adopted and a different native write becomes uncertain
    // in the same host session; its recovery must still be delivered.
    Locked::acquire(&context)
        .unwrap()
        .save(&Selection {
            version: 2,
            repository: context.repository.clone(),
            project_id: 7,
            branch: context.branch.clone().unwrap(),
            target: "main".into(),
            issues: vec![],
            intents: vec![
                IssueIntent {
                    title: "feat: interrupted issue creation".into(),
                    body: "Specification awaiting native reconciliation.".into(),
                    labels: vec![],
                    issue: Some(11),
                    write_started: true,
                },
                IssueIntent {
                    title: "feat: second interrupted issue".into(),
                    body: "Another specification awaiting reconciliation.".into(),
                    labels: vec![],
                    issue: None,
                    write_started: true,
                },
            ],
            adopted: vec![],
            request: Some(7),
            request_write_started: false,
            request_intent: None,
            delivered_request: None,
        })
        .unwrap();
    let later = hook(
        &f,
        "SessionStart",
        json!({"session_id":session,"hook_event_name":"SessionStart","cwd":f.root}),
    );
    assert!(later.status.success());
    let output: Value = serde_json::from_slice(&later.stdout).unwrap();
    let text = output["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap();
    assert!(text.contains("uncertain native write"), "{text}");
}

#[tokio::test]
async fn branch_mismatched_checkpoint_keeps_its_uncertain_write_visible() {
    use specgit::{
        identity::Provider,
        process::Process,
        selection::{IssueIntent, Locked, Selection},
    };
    let f = delivery::Fixture::new("github");
    let context = specgit::config::resolve(
        &Process::default(),
        &f.root,
        None,
        Some(Provider::Github),
        None,
    )
    .await
    .unwrap();
    let recorded = context.branch.clone().unwrap();
    Locked::acquire(&context)
        .unwrap()
        .save(&Selection {
            version: 2,
            repository: context.repository.clone(),
            project_id: 7,
            branch: recorded.clone(),
            target: "main".into(),
            issues: vec![],
            intents: vec![IssueIntent {
                title: "feat: interrupted issue creation".into(),
                body: "Specification awaiting native reconciliation.".into(),
                labels: vec![],
                issue: None,
                write_started: true,
            }],
            adopted: vec![],
            request: None,
            request_write_started: false,
            request_intent: None,
            delivered_request: None,
        })
        .unwrap();
    let switched = std::process::Command::new("git")
        .current_dir(&f.root)
        .args(["switch", "-q", "-c", "elsewhere"])
        .output()
        .unwrap();
    assert!(switched.status.success(), "{switched:?}");
    let output = hook(
        &f,
        "SessionStart",
        json!({"session_id":"mismatch","hook_event_name":"SessionStart","cwd":f.root}),
    );
    assert!(output.status.success(), "{output:?}");
    let delivered: Value = serde_json::from_slice(&output.stdout).unwrap();
    let text = delivered["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap();
    assert!(text.contains("uncertain native write"), "{text}");
    assert!(text.contains(&format!("\"{recorded}\"")), "{text}");
    assert!(text.contains("not the current checkpoint"), "{text}");
    // The foreign checkpoint's Issues are not presented as current.
    assert!(text.contains("elsewhere"), "{text}");
}

#[test]
fn concurrent_session_start_callbacks_deliver_rules_to_both_sessions() {
    let f = delivery::Fixture::new("github");
    let sessions = ["concurrent-left", "concurrent-right"];
    let start = std::sync::Barrier::new(2);
    std::thread::scope(|scope| {
        let threads: Vec<_> = sessions
            .iter()
            .map(|session| {
                let f = &f;
                let start = &start;
                scope.spawn(move || {
                    start.wait();
                    hook(
                        f,
                        "SessionStart",
                        json!({"session_id":session,"hook_event_name":"SessionStart","cwd":f.root}),
                    )
                })
            })
            .collect();
        for thread in threads {
            let output = thread.join().unwrap();
            assert!(output.status.success());
            assert!(
                output.stderr.is_empty(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let delivered: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert!(
                delivered["hookSpecificOutput"]["additionalContext"]
                    .as_str()
                    .unwrap()
                    .contains("SKILL.md")
            );
        }
    });
    for session in sessions {
        let repeated = hook(
            &f,
            "SessionStart",
            json!({"session_id":session,"hook_event_name":"SessionStart","cwd":f.root}),
        );
        assert!(repeated.status.success());
        assert!(repeated.stdout.is_empty());
        assert!(repeated.stderr.is_empty());
    }
    assert!(f.state()["calls"].as_array().unwrap().is_empty());
}

#[test]
fn interrupted_explicit_guard_source_transfer_can_be_rolled_back_without_manual_receipt_edits() {
    use specgit::assets::AssetStore;
    let f = delivery::Fixture::new("github");
    assert_eq!(
        f.run(&["setup", "--agent", "generic", "--hook-purpose", "guard"])["exit"],
        0
    );
    let private = f.root.join(".git/specgit-v2");
    let source = fs::read(private.join("setup-guard-hooks.json")).unwrap();
    let hook = fs::read(f.root.join(".git/hooks/pre-commit")).unwrap();
    let crashed = f
        .feature_command(&["guard", "--install"])
        .env("SPECGIT_FIXTURE_ASSET_CRASH", "before-commit")
        .output()
        .unwrap();
    assert_eq!(crashed.status.code(), Some(99), "{crashed:?}");
    let pending = AssetStore::lock(
        &private.join("assets"),
        &[f.root.clone(), private.clone()],
        Duration::from_secs(2),
    )
    .unwrap()
    .pending_transactions()
    .unwrap();
    assert_eq!(pending.len(), 1);
    let restored = f.run(&["setup", "--rollback", &pending[0]]);
    assert_eq!(restored["exit"], 0, "{restored}");
    assert_eq!(
        fs::read(private.join("setup-guard-hooks.json")).unwrap(),
        source
    );
    assert!(!private.join("guard-hooks.json").exists());
    assert_eq!(
        fs::read(f.root.join(".git/hooks/pre-commit")).unwrap(),
        hook
    );
    guard(&f, "--install");
    assert!(private.join("guard-hooks.json").is_file());
}

#[test]
fn rollback_retains_a_guard_borrowed_by_setup_in_the_same_worktree() {
    let f = delivery::Fixture::new("github");
    let installed = guard(&f, "--install");
    let transaction = installed["transaction"]["transaction"].as_str().unwrap();
    assert_eq!(
        f.run(&["setup", "--agent", "generic", "--hook-purpose", "guard"])["exit"],
        0
    );
    let receipt = f.root.join(".git/specgit-v2/guard-hooks.json");
    let before = fs::read(&receipt).unwrap();
    for command in ["init", "setup"] {
        let rollback = f.run(&[command, "--rollback", transaction]);
        assert_eq!(rollback["exit"], 0, "{rollback}");
        assert_eq!(fs::read(&receipt).unwrap(), before);
        assert!(f.root.join(".git/hooks/pre-push").exists());
        assert!(
            rollback["evidence"]["retained"]
                .as_array()
                .unwrap()
                .iter()
                .any(|path| path["reason"] == "setup_guard_purpose"),
            "{rollback}"
        );
    }
    assert_eq!(f.run(&["setup", "--uninstall"])["exit"], 0);
    let completed = f.run(&["setup", "--rollback", transaction]);
    assert_eq!(completed["exit"], 0, "{completed}");
    assert!(!receipt.exists());
    assert!(!f.root.join(".git/hooks/pre-commit").exists());
}

#[test]
fn a_setup_transaction_that_withdraws_its_own_guard_demand_can_roll_back_all_assets() {
    let f = delivery::Fixture::new("github");
    let installed = f.run(&["setup", "--agent", "generic", "--hook-purpose", "guard"]);
    let transaction = installed["evidence"]["transaction"]["transaction"]
        .as_str()
        .unwrap();
    let rollback = f.run(&["setup", "--rollback", transaction]);
    assert_eq!(rollback["exit"], 0, "{rollback}");
    assert!(!f.root.join(".git/hooks/pre-commit").exists());
    assert!(
        !f.root
            .join(".git/specgit-v2/setup-guard-hooks.json")
            .exists()
    );
    assert!(
        !f.root
            .join(".git/specgit-v2/agent-assets/ownership.json")
            .exists()
    );
}

#[test]
fn changed_hooks_path_rejects_refresh_before_changing_any_project_asset() {
    let f = delivery::Fixture::new("github");
    let configure = |path| {
        assert!(
            std::process::Command::new("git")
                .current_dir(&f.root)
                .args(["config", "core.hooksPath", path])
                .output()
                .unwrap()
                .status
                .success()
        );
    };
    configure(".husky");
    assert_eq!(
        f.run(&[
            "setup",
            "--agent",
            "codex",
            "--hook-purpose",
            "guard",
            "--hook-purpose",
            "context",
        ])["exit"],
        0
    );
    let paths = [
        "AGENTS.md",
        ".agents/skills/specgit-native/SKILL.md",
        ".codex/hooks.json",
        ".git/specgit-v2/agent-assets/ownership.json",
        ".git/specgit-v2/setup-guard-hooks.json",
        ".husky/pre-commit",
        ".husky/pre-push",
    ];
    let before: Vec<_> = paths
        .iter()
        .map(|path| fs::read(f.root.join(path)).unwrap())
        .collect();
    configure(".newhooks");
    let result = f.run(&["setup"]);
    assert_ne!(result["exit"], 0, "{result}");
    assert!(
        result["diagnostics"][0]["message"]
            .as_str()
            .unwrap()
            .contains("effective hooks path"),
        "{result}"
    );
    for (path, bytes) in paths.iter().zip(before) {
        assert_eq!(fs::read(f.root.join(path)).unwrap(), bytes);
    }
    assert!(!f.root.join(".newhooks/pre-commit").exists());
}

#[test]
fn doctor_verifies_retained_setup_guard_after_its_project_receipt_is_rolled_back() {
    let damages = if cfg!(unix) {
        vec!["missing", "permissions"]
    } else {
        vec!["missing"]
    };
    for damage in damages {
        let f = delivery::Fixture::new("github");
        let installed = f.run(&["setup", "--agent", "generic", "--hook-purpose", "guard"]);
        let transaction = installed["evidence"]["transaction"]["transaction"]
            .as_str()
            .unwrap();
        let (_worktree_parent, sibling) = add_linked_worktree(&f.root, "consumer");
        let borrowed = f
            .command(&["setup", "--agent", "generic", "--hook-purpose", "guard"])
            .current_dir(&sibling)
            .output()
            .unwrap();
        assert!(borrowed.status.success(), "{borrowed:?}");
        assert_eq!(f.run(&["setup", "--rollback", transaction])["exit"], 0);
        assert!(
            !f.root
                .join(".git/specgit-v2/agent-assets/ownership.json")
                .exists()
        );
        let current = f.run(&["doctor", "--offline"]);
        let guard_check = |report: &Value| {
            report["evidence"]["health"]["checks"]
                .as_array()
                .unwrap()
                .iter()
                .find(|check| check["id"] == "guard")
                .unwrap()
                .clone()
        };
        assert_eq!(guard_check(&current)["status"], "current", "{current}");
        let hook = f.root.join(".git/hooks/pre-push");
        if damage == "missing" {
            fs::remove_file(&hook).unwrap();
        }
        #[cfg(unix)]
        if damage == "permissions" {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&hook, fs::Permissions::from_mode(0o644)).unwrap();
        }
        let damaged = f.run(&["doctor", "--offline"]);
        assert_eq!(
            guard_check(&damaged)["status"],
            "unknown",
            "{damage}: {damaged}"
        );
        assert_eq!(guard_check(&damaged)["severity"], "error");
        assert!(!f.root.join(".git/specgit-v2/guard-hooks.json").exists());
    }
}

#[tokio::test]
async fn typed_install_rollback_is_rejected_without_side_effects_for_plain_and_guard_transactions()
{
    for purposes in ["none", "guard"] {
        let f = delivery::Fixture::new("github");
        let installed = f.run(&["setup", "--agent", "generic", "--hook-purpose", purposes]);
        let transaction = installed["evidence"]["transaction"]["transaction"]
            .as_str()
            .unwrap()
            .to_owned();
        let options = specgit::setup::project::Options {
            agents: vec![],
            opencode_claude_hooks: false,
            uninstall: false,
            dry_run: false,
            rollback: Some(transaction),
        };
        let process = specgit::process::Process::default();
        let private = f.root.join(".git/specgit-v2/agent-assets");
        let before = fs::read(private.join("ownership.json")).unwrap();
        let hook = fs::read(f.root.join(".git/hooks/pre-commit")).ok();
        let result = specgit::setup::project::install_with_context(
            &options,
            &Default::default(),
            &f.root,
            &private,
            &delivery::executable::binary(),
            &process,
        )
        .await;
        assert!(result.is_err());
        let native = specgit::guard::setup_plan_with_executable(
            &process,
            &f.root,
            purposes == "guard",
            &delivery::executable::binary(),
        )
        .await
        .unwrap();
        let result = specgit::setup::project::install_with_guard_plan(
            &options,
            &Default::default(),
            &f.root,
            &private,
            &delivery::executable::binary(),
            native,
        );
        assert!(result.is_err());
        assert_eq!(fs::read(private.join("ownership.json")).unwrap(), before);
        assert_eq!(fs::read(f.root.join(".git/hooks/pre-commit")).ok(), hook);
    }
}

fn released_init_guidance() -> String {
    include_str!("fixtures/stable-guidance/2.11.1-zh.txt").replace("\r\n", "\n")
}

#[test]
fn setup_migration_preserves_the_only_initialization_marker_and_lost_declaration_guard() {
    let f = delivery::Fixture::new("github");
    let private = f.root.join(".git/specgit-v2");
    fs::create_dir_all(&private).unwrap();
    let legacy = released_init_guidance();
    fs::write(f.root.join("AGENTS.md"), format!("Manual rules\n{legacy}")).unwrap();
    fs::write(private.join("guidance.json"), json!({"version":1,"generator":"2.11.1","blocks":{"AGENTS.md":specgit::assets::hash(legacy.trim_end_matches('\n').as_bytes())}}).to_string()).unwrap();
    assert!(
        specgit::config::worktree::private_state(&private)
            .unwrap()
            .is_initialized()
    );
    let migrated = f.run(&["setup", "--agent", "generic", "--hook-purpose", "guard"]);
    assert_eq!(migrated["exit"], 0, "{migrated}");
    assert!(
        specgit::config::worktree::private_state(&private)
            .unwrap()
            .is_initialized(),
        "setup migration lost the only init marker"
    );
    let marker: Value =
        serde_json::from_slice(&fs::read(private.join("guidance.json")).unwrap()).unwrap();
    assert_eq!(marker["blocks"], json!({}));
    fs::remove_file(f.root.join(".specgit.yaml")).unwrap();
    assert!(
        std::process::Command::new("git")
            .current_dir(&f.root)
            .args(["add", "-u"])
            .output()
            .unwrap()
            .status
            .success()
    );
    let denied = f
        .command(&["guard", "--stage", "pre-commit"])
        .output()
        .unwrap();
    assert!(
        !denied.status.success(),
        "a previously initialized project must fail closed when its declaration disappears"
    );
    assert!(
        String::from_utf8_lossy(&denied.stderr).contains("no .specgit.yaml"),
        "{denied:?}"
    );
    let setup_only = delivery::Fixture::new("github");
    assert_eq!(setup_only.run(&["setup", "--agent", "generic"])["exit"], 0);
    assert!(
        !specgit::config::worktree::private_state(&setup_only.root.join(".git/specgit-v2"))
            .unwrap()
            .is_initialized()
    );
}

#[test]
fn an_empty_init_marker_does_not_hide_claude_legacy_guidance_after_branch_switch() {
    let f = delivery::Fixture::new("github");
    assert_eq!(f.run(&["setup", "--agent", "generic"])["exit"], 0);
    let private = f.root.join(".git/specgit-v2");
    fs::write(
        private.join("guidance.json"),
        json!({"version":1,"generator":"2.12.0","blocks":{}}).to_string(),
    )
    .unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("git")
            .current_dir(&f.root)
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
    };
    git(&["switch", "-c", "legacy-claude"]);
    fs::write(
        f.root.join("CLAUDE.md"),
        format!("Manual Claude rules\n{}", released_init_guidance()),
    )
    .unwrap();
    git(&["add", "CLAUDE.md"]);
    git(&["commit", "-m", "fixture: legacy Claude branch"]);
    git(&["switch", "feature"]);
    assert!(!f.root.join("CLAUDE.md").exists());
    git(&["switch", "legacy-claude"]);
    let health = specgit::guidance::health_plan(
        &f.root,
        &private,
        &specgit::config::read(&f.root).unwrap().unwrap(),
    );
    assert!(
        health.is_err(),
        "doctor must report legacy Claude guidance instead of treating an empty receipt as no selection"
    );
    let refreshed = f.run(&["setup"]);
    assert_eq!(refreshed["exit"], 0, "{refreshed}");
    let claude = fs::read_to_string(f.root.join("CLAUDE.md")).unwrap();
    assert!(
        claude
            .replace("\r\n", "\n")
            .starts_with("Manual Claude rules\n"),
        "{claude:?}"
    );
    assert!(!claude.contains("<!-- specgit:v2:start -->"), "{claude}");
    assert_eq!(
        claude.matches("<!-- specgit:project:v2:start -->").count(),
        1
    );
    assert!(
        !f.root.join(".claude/settings.json").exists(),
        "migration must not infer a new hook choice"
    );
}

#[tokio::test]
async fn locked_save_rejects_malformed_checkpoints_before_writing_bytes() {
    use specgit::{
        delivery_model::Issue,
        diagnostic::Code,
        identity::Provider,
        process::Process,
        selection::{IssueIntent, Locked, RequestIntent, Selection, path, read_path},
    };
    let f = delivery::Fixture::new("github");
    let context = specgit::config::resolve(
        &Process::default(),
        &f.root,
        None,
        Some(Provider::Github),
        None,
    )
    .await
    .unwrap();
    let checkpoint = path(&context);
    let issue = |id: u64| Issue {
        id,
        title: format!("fix: checkpoint {id}"),
        body: "Specification WHY".into(),
        labels: vec!["kind::fix".into()],
        state: "open".into(),
        updated_at: "2026-10-01T00:00:00Z".into(),
    };
    let intent = |issue: Option<u64>| IssueIntent {
        title: format!("fix: checkpoint {issue:?}"),
        body: "Specification WHY".into(),
        labels: vec!["kind::fix".into()],
        issue,
        write_started: false,
    };
    let selection = |issues: Vec<u64>, adopted: Vec<Issue>, intents: Vec<IssueIntent>| Selection {
        version: 2,
        repository: context.repository.clone(),
        project_id: 7,
        branch: context.branch.clone().unwrap(),
        target: "main".into(),
        issues,
        intents,
        adopted,
        request: None,
        request_write_started: false,
        request_intent: None,
        delivered_request: None,
    };
    Locked::acquire(&context)
        .unwrap()
        .save(&selection(vec![1], vec![issue(1)], vec![intent(Some(1))]))
        .unwrap();
    let before = fs::read(&checkpoint).unwrap();
    let mut too_many_intents = vec![];
    for id in 1..=101 {
        too_many_intents.push(intent(Some(id)));
    }
    let mut too_many_adopted = vec![];
    for _ in 0..101 {
        too_many_adopted.push(issue(1));
    }
    let mut zero_request = selection(vec![1], vec![issue(1)], vec![]);
    zero_request.request = Some(0);
    let mut zero_delivered = selection(vec![1], vec![issue(1)], vec![]);
    zero_delivered.delivered_request = Some(0);
    let invalid = vec![
        selection((1..=101).collect(), vec![issue(1)], vec![]),
        selection(vec![1, 1], vec![issue(1)], vec![]),
        selection(vec![0], vec![], vec![]),
        selection(vec![], vec![issue(1)], vec![]),
        selection(vec![1], too_many_adopted, vec![]),
        selection(vec![1], vec![issue(1)], too_many_intents),
        selection(vec![1], vec![issue(1)], vec![intent(Some(0))]),
        selection(
            vec![1],
            vec![issue(1)],
            vec![IssueIntent {
                title: " ".into(),
                ..intent(Some(1))
            }],
        ),
        zero_request,
        zero_delivered,
    ];
    for malformed in invalid {
        let diagnostic = Locked::acquire(&context)
            .unwrap()
            .save(&malformed)
            .expect_err("malformed checkpoint was saved");
        assert_eq!(diagnostic.code, Code::OwnershipConflict, "{diagnostic:?}");
        assert_eq!(fs::read(&checkpoint).unwrap(), before);
    }

    let mut provisional = selection(vec![], vec![], vec![]);
    provisional.request_write_started = true;
    provisional.request_intent = Some(RequestIntent {
        head: "a".repeat(40),
        title: "feat: provisional request".into(),
        body: "Specification WHY".into(),
        labels: vec![],
    });
    Locked::acquire(&context)
        .unwrap()
        .save(&provisional)
        .unwrap();
    let reread = read_path(&checkpoint).unwrap().unwrap();
    assert!(reread.request_intent.is_some());
    assert!(reread.request_write_started);

    let mut delivered = selection(vec![1], vec![issue(1)], vec![]);
    delivered.delivered_request = Some(7);
    Locked::acquire(&context).unwrap().save(&delivered).unwrap();
    assert_eq!(
        read_path(&checkpoint).unwrap().unwrap().delivered_request,
        Some(7)
    );
}
