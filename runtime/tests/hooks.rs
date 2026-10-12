#[path = "support/executable.rs"]
mod executable;
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
fn git(root: &std::path::Path, args: &[&str]) {
    assert!(
        Command::new("git")
            .current_dir(root)
            .args(args)
            .output()
            .unwrap()
            .status
            .success()
    );
}
fn fixture() -> tempfile::TempDir {
    let t = tempfile::tempdir().unwrap();
    git(t.path(), &["init"]);
    git(t.path(), &["config", "user.name", "Fixture"]);
    git(
        t.path(),
        &["config", "user.email", "fixture@example.invalid"],
    );
    git(t.path(), &["commit", "--allow-empty", "-m", "fixture"]);
    git(
        t.path(),
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/owner/repo.git",
        ],
    );
    t
}
fn checkpoint(root: &std::path::Path, branch: &str) {
    let git_dir = String::from_utf8(
        Command::new("git")
            .current_dir(root)
            .args(["rev-parse", "--absolute-git-dir"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    let directory = std::path::Path::new(git_dir.trim()).join("specgit-v2");
    fs::create_dir_all(&directory).unwrap();
    fs::write(
        directory.join("selection.json"),
        serde_json::to_vec_pretty(&json!({
            "version": 2,
            "repository": {"provider":"github","host":"github.com","path":"owner/repo"},
            "project_id": 7,
            "branch": branch,
            "target": "main",
            "issues": [41],
            "intents": [{
                "title":"feat: fixture",
                "body":"## Why\nfixture\n\n## Scope\nfixture\n\n## Approach\nfixture\n\n## Acceptance\nfixture",
                "labels": [],
                "issue": 41,
                "write_started": true
            }],
            "request": null,
            "request_write_started": false,
            "request_intent": null
        }))
        .unwrap(),
    )
    .unwrap();
}
fn run(event: &str, bytes: &[u8]) -> std::process::Output {
    run_command(executable::command(), event, bytes)
}
fn run_command(mut command: Command, event: &str, bytes: &[u8]) -> std::process::Output {
    let mut child = command
        .args(["hook", "--event", event])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let _ = stdin.write_all(bytes);
    drop(stdin);
    child.wait_with_output().unwrap()
}
#[test]
fn native_hook_is_silent_outside_initialized_projects_and_for_irrelevant_tools() {
    let t = fixture();
    let mut p =
        json!({"session_id":"fixture-session","hook_event_name":"SessionStart","cwd":t.path()});
    assert!(
        run("SessionStart", &serde_json::to_vec(&p).unwrap())
            .stdout
            .is_empty()
    );
    fs::write(t.path().join(".specgit.yaml"), "version: 1\n").unwrap();
    assert!(
        run("SessionStart", &serde_json::to_vec(&p).unwrap())
            .stdout
            .is_empty()
    );
    fs::write(
        t.path().join(".specgit.yaml"),
        "version: 2\nremote: origin\nlanguage: en\n",
    )
    .unwrap();
    for (name, command) in [
        ("Read", ""),
        ("Bash", "git status"),
        ("Bash", "specgit doctor --provider github"),
    ] {
        p["hook_event_name"] = json!("PostToolUse");
        p["tool_name"] = json!(name);
        p["tool_input"] = json!({"command":command});
        assert!(
            run("PostToolUse", &serde_json::to_vec(&p).unwrap())
                .stdout
                .is_empty()
        );
    }
}
#[test]
fn event_context_keeps_unknown_input_and_never_grants_permission_or_loops_stop() {
    let t = fixture();
    fs::write(
        t.path().join(".specgit.yaml"),
        "version: 2\nremote: origin\nlanguage: zh\n",
    )
    .unwrap();
    checkpoint(t.path(), "master");
    for event in ["SessionStart", "PreToolUse", "PostToolUse", "Stop"] {
        let p = json!({"session_id":"fixture-session","hook_event_name":event,"cwd":t.path(),"tool_name":"Edit","tool_input":{"file_path":"file","unknown":{"retain":[1,true]}},"future_field":"retained by host"});
        let original = p.clone();
        let out = run(event, &serde_json::to_vec(&p).unwrap());
        assert!(out.status.success());
        if matches!(event, "PreToolUse" | "PostToolUse") {
            assert!(out.stdout.is_empty(), "{event}: {:?}", out.stdout);
            assert_eq!(p, original);
            continue;
        }
        let v: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(p, original);
        assert!(v.get("continue").is_none());
        assert!(v.get("decision").is_none());
        assert!(
            v.pointer("/hookSpecificOutput/permissionDecision")
                .is_none()
        );
        assert!(v.pointer("/hookSpecificOutput/updatedInput").is_none());
        if event == "Stop" {
            assert!(v.get("systemMessage").is_some());
            assert!(v.get("hookSpecificOutput").is_none());
            let mut repeated = p;
            repeated["stop_hook_active"] = json!(true);
            assert!(
                run(event, &serde_json::to_vec(&repeated).unwrap())
                    .stdout
                    .is_empty()
            );
        } else {
            assert_eq!(v["hookSpecificOutput"]["hookEventName"], event);
            assert!(
                v["hookSpecificOutput"]["additionalContext"]
                    .as_str()
                    .unwrap()
                    .contains("远端状态尚未检查")
            );
        }
    }
}
#[test]
fn pre_tool_use_denies_tracked_edits_without_a_current_issue_checkpoint() {
    let t = fixture();
    fs::write(
        t.path().join(".specgit.yaml"),
        "version: 2\nremote: origin\nlanguage: en\n",
    )
    .unwrap();
    for payload in [
        json!({"session_id":"fixture-session","hook_event_name":"PreToolUse","cwd":t.path(),"tool_name":"Edit","tool_input":{"file_path":t.path().join("src/lib.rs")}}),
        json!({"session_id":"fixture-session","hook_event_name":"PreToolUse","cwd":t.path(),"tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch\n*** Add File: new/file.rs\n+x\n*** End Patch"}}),
    ] {
        let out = run("PreToolUse", &serde_json::to_vec(&payload).unwrap());
        assert!(out.status.success());
        let value: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(value["hookSpecificOutput"]["permissionDecision"], "deny");
        assert!(
            value["hookSpecificOutput"]["permissionDecisionReason"]
                .as_str()
                .unwrap()
                .contains("Issue checkpoint")
        );
    }
}

#[test]
fn a_lost_declaration_with_private_state_fails_closed_but_new_repositories_stay_silent() {
    let t = fixture();
    let edit = |event: &str| json!({"session_id":"fixture-session","hook_event_name":event,"cwd":t.path(),"tool_name":"Edit","tool_input":{"file_path":t.path().join("src/lib.rs")}});
    // Never initialized: no declaration and no private state.
    for event in ["SessionStart", "PreToolUse"] {
        assert!(
            run(event, &serde_json::to_vec(&edit(event)).unwrap())
                .stdout
                .is_empty()
        );
    }
    fs::write(
        t.path().join(".specgit.yaml"),
        "version: 2\nremote: origin\nlanguage: en\n",
    )
    .unwrap();
    checkpoint(t.path(), "master");
    fs::remove_file(t.path().join(".specgit.yaml")).unwrap();
    let out = run(
        "PreToolUse",
        &serde_json::to_vec(&edit("PreToolUse")).unwrap(),
    );
    assert!(out.status.success());
    let value: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["hookSpecificOutput"]["permissionDecision"], "deny");
    let reason = value["hookSpecificOutput"]["permissionDecisionReason"]
        .as_str()
        .unwrap();
    assert!(reason.contains("no .specgit.yaml"), "{reason}");
    assert!(reason.contains("specgit init"), "{reason}");
    for event in ["SessionStart", "PostToolUse", "Stop"] {
        let out = run(event, &serde_json::to_vec(&edit(event)).unwrap());
        let value: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert!(
            value["systemMessage"]
                .as_str()
                .unwrap()
                .contains("private state"),
            "{value}"
        );
    }
}

#[test]
fn pre_tool_use_allows_issue_lifecycle_commands_without_a_current_checkpoint() {
    let t = fixture();
    fs::write(
        t.path().join(".specgit.yaml"),
        "version: 2\nremote: origin\nlanguage: en\n",
    )
    .unwrap();
    for (tool_name, command) in [
        ("Bash", "specgit issue --inspect 'fix: first checkpoint'"),
        (
            "Bash",
            "specgit --json issue --dry-run 'fix: first checkpoint'",
        ),
        ("Bash", "specgit issue 'fix: first checkpoint'"),
        (
            "PowerShell",
            "specgit issue --inspect 'fix: first checkpoint'",
        ),
    ] {
        let payload = json!({
            "session_id":"fixture-session",
            "hook_event_name":"PreToolUse",
            "cwd":t.path(),
            "tool_name":tool_name,
            "tool_input":{"command":command}
        });
        let out = run("PreToolUse", &serde_json::to_vec(&payload).unwrap());
        assert!(out.status.success());
        assert!(
            out.stdout.is_empty(),
            "issue lifecycle command was blocked by the source-edit checkpoint guard: {command}"
        );
    }

    let compound_payload = json!({
        "session_id":"fixture-session",
        "hook_event_name":"PreToolUse",
        "cwd":t.path(),
        "tool_name":"Bash",
        "tool_input":{"command":"specgit issue --inspect 'fix: first checkpoint' && touch tracked-file"}
    });
    let compound = run(
        "PreToolUse",
        &serde_json::to_vec(&compound_payload).unwrap(),
    );
    let value: Value = serde_json::from_slice(&compound.stdout).unwrap();
    assert_eq!(value["hookSpecificOutput"]["permissionDecision"], "deny");
    assert!(
        value["hookSpecificOutput"]["permissionDecisionReason"]
            .as_str()
            .unwrap()
            .contains("Issue checkpoint")
    );
}

#[test]
fn pre_tool_use_accepts_only_the_checkpoint_branch_and_rejects_cross_repository_patches() {
    let t = fixture();
    fs::write(
        t.path().join(".specgit.yaml"),
        "version: 2\nremote: origin\ntarget: main\nlanguage: en\n",
    )
    .unwrap();
    checkpoint(t.path(), "master");
    let payload = json!({"session_id":"fixture-session","hook_event_name":"PreToolUse","cwd":t.path(),"tool_name":"Edit","tool_input":{"file_path":t.path().join("src/lib.rs")}});
    assert!(
        run("PreToolUse", &serde_json::to_vec(&payload).unwrap())
            .stdout
            .is_empty()
    );
    git(t.path(), &["checkout", "-b", "other"]);
    let value: Value =
        serde_json::from_slice(&run("PreToolUse", &serde_json::to_vec(&payload).unwrap()).stdout)
            .unwrap();
    assert_eq!(value["hookSpecificOutput"]["permissionDecision"], "deny");

    let other = fixture();
    fs::write(
        other.path().join(".specgit.yaml"),
        "version: 2\nremote: origin\n",
    )
    .unwrap();
    let payload = json!({"session_id":"fixture-session","hook_event_name":"PreToolUse","cwd":t.path(),"tool_name":"apply_patch","tool_input":{"command":format!("*** Begin Patch\n*** Update File: {}\n+x\n*** Update File: {}\n+y\n*** End Patch",t.path().join("a").display(),other.path().join("b").display())}});
    let value: Value =
        serde_json::from_slice(&run("PreToolUse", &serde_json::to_vec(&payload).unwrap()).stdout)
            .unwrap();
    assert_eq!(value["hookSpecificOutput"]["permissionDecision"], "deny");
}

#[test]
fn stop_requests_at_most_one_checkpoint_recovery_turn() {
    let t = fixture();
    fs::write(
        t.path().join(".specgit.yaml"),
        "version: 2\nremote: origin\n",
    )
    .unwrap();
    let mut payload =
        json!({"session_id":"fixture-session","hook_event_name":"Stop","cwd":t.path()});
    let value: Value =
        serde_json::from_slice(&run("Stop", &serde_json::to_vec(&payload).unwrap()).stdout)
            .unwrap();
    assert_eq!(value["decision"], "block");
    payload["stop_hook_active"] = json!(true);
    assert!(
        run("Stop", &serde_json::to_vec(&payload).unwrap())
            .stdout
            .is_empty()
    );
}
#[test]
fn malformed_duplicate_and_oversized_hook_inputs_remain_nonblocking() {
    for bytes in [
        b"{".to_vec(),
        b"{\"cwd\":\"a\",\"cwd\":\"b\"}".to_vec(),
        vec![b'x'; 1_048_577],
    ] {
        let out = run("SessionStart", &bytes);
        assert!(out.status.success());
        let v: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert!(v.get("systemMessage").is_some());
    }
}
#[test]
fn stalled_stdin_cannot_hold_runtime_shutdown() {
    let start = Instant::now();
    let mut child = executable::command()
        .args(["hook", "--event", "SessionStart"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let _held_input = child.stdin.take().unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert!(start.elapsed() < Duration::from_secs(5));
    let v: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(v.get("systemMessage").is_some());
}
#[test]
fn project_setup_registers_a_working_native_hook_adapter() {
    let t = fixture();
    let out = executable::command()
        .current_dir(t.path())
        .args(["setup", "--agent", "claude", "--json"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0));
    let value: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["status"], "installed", "{value}");
    assert_eq!(value["evidence"]["scope"], "project", "{value}");
    let text = fs::read_to_string(t.path().join(".claude/settings.json")).unwrap();
    assert!(!text.contains("--state-root"), "{text}");
    let settings: Value = serde_json::from_str(&text).unwrap();
    let entry = &settings["hooks"]["SessionStart"][0]["hooks"][0];
    // The registered adapter runs the native CLI: silent outside initialized projects.
    let mut child = Command::new(entry["command"].as_str().unwrap())
        .args(
            entry["args"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap()),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(serde_json::to_string(&json!({"session_id":"native-copy","hook_event_name":"SessionStart","cwd":t.path()})).unwrap().as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    assert!(out.stdout.is_empty());
}

#[test]
fn state_root_is_not_a_supported_hook_argument() {
    let out = executable::command()
        .args(["hook", "--event", "SessionStart", "--state-root", "x"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    let value: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["exit"], 2, "{value}");
}

#[test]
fn native_write_commands_require_checkpoint_but_observer_commands_do_not_recurse() {
    let t = fixture();
    fs::write(
        t.path().join(".specgit.yaml"),
        "version: 2\nremote: origin\n",
    )
    .unwrap();
    for (command, relevant) in [
        ("touch generated.rs", true),
        ("sed -i.bak 's/a/b/' source.rs", true),
        ("printf data > output.txt", true),
        ("printf 'a > b'", false),
        ("specgit pr --ready", true),
        ("specgit --json pr --ready", true),
        ("specgit --cwd '/tmp/project space' --json pr --ready", true),
        ("specgit --cwd=\"/tmp/project space\" --json issue 1", false),
        ("specgit --json --cwd /tmp/project finish", false),
        (
            "specgit merge --request 41 --mode now --strategy squash",
            true,
        ),
        ("node bin/specgit.js issue 1", true),
        ("specgit watch --request 41", false),
        ("specgit inbox --request 41", false),
        ("specgit finish", false),
    ] {
        let payload = json!({"session_id":"fixture-session","hook_event_name":"PreToolUse","cwd":t.path(),"tool_name":"Bash","tool_input":{"command":command}});
        assert_eq!(
            !run("PreToolUse", &serde_json::to_vec(&payload).unwrap())
                .stdout
                .is_empty(),
            relevant,
            "{command}"
        );
    }
}

fn shell_payload(root: &std::path::Path, command: &str) -> Value {
    json!({"session_id":"fixture-session","hook_event_name":"PreToolUse","cwd":root,"tool_name":"Bash","tool_input":{"command":command}})
}

#[test]
fn readonly_commands_and_non_repository_redirects_do_not_need_checkpoint() {
    let t = fixture();
    fs::write(
        t.path().join(".specgit.yaml"),
        "version: 2\nremote: origin\n",
    )
    .unwrap();
    for command in [
        "gh pr view 41",
        "gh pr list",
        "gh pr checks 41",
        "gh pr diff 41",
        "gh pr status",
        "gh issue view 41",
        "gh issue list",
        "glab mr view 41",
        "glab mr list",
        "glab mr diff 41",
        "glab issue view 41",
        "glab issue list",
        "specgit pr --status",
        "specgit --json pr --status --request 41",
        "specgit status",
        "specgit doctor",
        "specgit watch",
        "specgit inbox",
        "cmd 2>&1",
        "cmd >&2",
        "cmd &>/dev/null",
        "cmd 2>/dev/null",
        "cmd >/dev/null",
        "cmd 2> /dev/null",
        "cmd >>/dev/null 2>&1",
        "cmd 2>&1 | gh pr view 41",
        "printf 'rm x; touch y && cp z q | mv a b & mkdir c\n git push'",
        "printf \"a > b\"",
        "printf git push",
        "env FOO=1 gh pr checks 41",
        "sudo command gh issue view 41",
    ] {
        let out = run(
            "PreToolUse",
            &serde_json::to_vec(&shell_payload(t.path(), command)).unwrap(),
        );
        assert!(out.status.success());
        assert!(
            out.stdout.is_empty(),
            "{command}: {}",
            String::from_utf8_lossy(&out.stdout)
        );
    }
}

#[test]
fn shell_segments_and_leading_wrappers_cannot_hide_tracked_writes() {
    let t = fixture();
    fs::write(
        t.path().join(".specgit.yaml"),
        "version: 2\nremote: origin\n",
    )
    .unwrap();
    for command in [
        "cd x && rm y",
        "cd x;rm y",
        "cd x || rm y",
        "pwd | rm y",
        "pwd & rm y",
        "pwd\nrm y",
        "FOO=1 rm y",
        "sudo rm y",
        "env rm y",
        "command rm y",
        "nohup rm y",
        "time rm y",
        "FOO='a b' sudo env BAR=2 command nohup time rm y",
        "sudo -u root rm y",
        "env -i FOO=1 rm y",
        "cmd 2>&1 && rm y",
        "cmd &>/dev/null; rm y",
        "gh pr view 41 && git push",
        "specgit pr --status;touch x",
        "gh pr create",
        "gh pr merge",
        "gh issue edit 41",
        "glab mr approve 41",
        "glab issue close 41",
        "specgit pr --ready",
        "printf data > output.txt",
        "cmd 2>&1 >output",
        "cmd &>output",
        "cmd >/dev/null.txt",
        "specgit issue --inspect x && pwd",
        "FOO=1 specgit issue 41",
        "sudo specgit issue 41",
        "specgit issue --inspect \"$(touch x)\"",
    ] {
        let out = run(
            "PreToolUse",
            &serde_json::to_vec(&shell_payload(t.path(), command)).unwrap(),
        );
        assert!(out.status.success());
        assert!(!out.stdout.is_empty(), "missed write: {command}");
        let value: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(
            value["hookSpecificOutput"]["permissionDecision"], "deny",
            "{command}: {value}"
        );
    }
}

#[tokio::test]
async fn batched_project_resolution_preserves_identity_and_reduces_git_processes() {
    use specgit::{process::Process, project::resolve};
    let t = fixture();
    let process = Process::default().with_inspection_budget(Duration::from_secs(30));
    let context = resolve(&process, t.path(), None, None, None).await.unwrap();
    assert_eq!(process.inspection_summary().unwrap().activities.len(), 4);
    let field = |args: &[&str]| {
        String::from_utf8(
            Command::new("git")
                .current_dir(t.path())
                .args(args)
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim_end_matches(['\r', '\n'])
        .to_owned()
    };
    assert_eq!(
        context.root,
        std::path::PathBuf::from(field(&["rev-parse", "--show-toplevel"]))
    );
    assert_eq!(
        context.git_dir,
        std::path::PathBuf::from(field(&["rev-parse", "--absolute-git-dir"]))
    );
    assert_eq!(
        context.common_dir,
        std::path::PathBuf::from(field(&[
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir"
        ]))
    );
    assert_eq!(context.head, field(&["rev-parse", "--verify", "HEAD"]));
    assert_eq!(
        context.branch.as_deref(),
        Some(field(&["rev-parse", "--abbrev-ref", "HEAD"]).as_str())
    );
    assert!(!context.dirty);
    assert_eq!(context.remote, "origin");
    assert_eq!(context.repository.path, "owner/repo");
    git(t.path(), &["checkout", "--detach"]);
    let detached = resolve(&process, t.path(), None, None, None).await.unwrap();
    assert_eq!(detached.head, context.head);
    assert!(detached.branch.is_none());
}

#[cfg(feature = "test-fixtures")]
#[test]
fn hook_reuses_the_target_probe_instead_of_resolving_toplevel_again() {
    let t = fixture();
    fs::write(
        t.path().join(".specgit.yaml"),
        "version: 2\nremote: origin\n",
    )
    .unwrap();
    let proxy = tempfile::tempdir().unwrap();
    let name = if cfg!(windows) { "git.exe" } else { "git" };
    let real_git = specgit::process::resolve_executable("git").unwrap();
    fs::copy(
        env!("CARGO_BIN_EXE_specgit-process-fixture"),
        proxy.path().join(name),
    )
    .unwrap();
    let state_path = proxy.path().join("state.json");
    fs::write(&state_path, b"{}").unwrap();
    let path = std::env::var_os("PATH").unwrap();
    let paths = std::iter::once(proxy.path().to_owned()).chain(std::env::split_paths(&path));
    let mut command = executable::command();
    command
        .env("PATH", std::env::join_paths(paths).unwrap())
        .env("SPECGIT_FIXTURE_REAL_GIT", real_git)
        .env("SPECGIT_FIXTURE_API_FILE", &state_path);
    let payload = shell_payload(t.path(), "touch tracked-file");
    let output = run_command(
        command,
        "PreToolUse",
        &serde_json::to_vec(&payload).unwrap(),
    );
    assert!(output.status.success());
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["hookSpecificOutput"]["permissionDecision"], "deny");
    let state: Value = serde_json::from_slice(&fs::read(state_path).unwrap()).unwrap();
    let queries = state["git_proxy_cache"].as_object().unwrap();
    assert_eq!(queries.len(), 4, "{state}");
    assert_eq!(
        queries
            .keys()
            .filter(|key| key.contains("rev-parse"))
            .count(),
        1
    );
    assert!(state["observation_discovery_failed"].is_null());
}

#[cfg(unix)]
#[tokio::test]
async fn newline_paths_preserve_the_separate_query_contract() {
    let t = fixture();
    let linked = t.path().join("linked 空格\nline");
    git(
        t.path(),
        &[
            "worktree",
            "add",
            "--detach",
            linked.to_str().unwrap(),
            "HEAD",
        ],
    );
    let process = specgit::process::Process::default();
    let context = specgit::project::resolve(&process, &linked, None, None, None)
        .await
        .unwrap();
    assert_eq!(
        context.root.canonicalize().unwrap(),
        linked.canonicalize().unwrap()
    );
    assert!(context.branch.is_none());
    let field = |args: &[&str]| {
        String::from_utf8(
            Command::new("git")
                .current_dir(&linked)
                .args(args)
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim_end_matches(['\r', '\n'])
        .to_owned()
    };
    assert_eq!(
        context.git_dir,
        std::path::PathBuf::from(field(&["rev-parse", "--absolute-git-dir"]))
    );
    assert_eq!(
        context.common_dir,
        std::path::PathBuf::from(field(&[
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir"
        ]))
    );
}

#[tokio::test]
async fn batched_project_resolution_keeps_unborn_and_remote_error_categories() {
    use specgit::{diagnostic::Code, process::Process, project::resolve};
    let t = tempfile::tempdir().unwrap();
    let process = Process::default();
    assert_eq!(
        resolve(&process, t.path(), None, None, None)
            .await
            .unwrap_err()
            .code,
        Code::MissingProject
    );
    git(t.path(), &["init"]);
    assert_eq!(
        resolve(&process, t.path(), None, None, None)
            .await
            .unwrap_err()
            .code,
        Code::AmbiguousRemote
    );
    assert_eq!(
        resolve(&process, t.path(), Some("origin"), None, None)
            .await
            .unwrap_err()
            .code,
        Code::InvalidInput
    );
    git(
        t.path(),
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/owner/repo.git",
        ],
    );
    assert_eq!(
        resolve(&process, t.path(), None, None, None)
            .await
            .unwrap_err()
            .code,
        Code::ProcessFailed
    );
}

#[tokio::test]
async fn post_tool_use_emits_only_pending_receipts_without_acknowledging_them() {
    use specgit::{
        process::Process,
        project, selection,
        watch_store::{self, EventState, Goal, Identity, Revision, Store},
    };
    let t = fixture();
    fs::write(
        t.path().join(".specgit.yaml"),
        "version: 2\nremote: origin\nlanguage: en\n",
    )
    .unwrap();
    let context = project::resolve(&Process::default(), t.path(), None, None, None)
        .await
        .unwrap();
    checkpoint(t.path(), context.branch.as_deref().unwrap());
    let path = selection::path(&context);
    let mut selected: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    selected["request"] = json!(41);
    fs::write(path, serde_json::to_vec(&selected).unwrap()).unwrap();
    let identity = Identity::new(&context, "fixture-session", 41, Goal::Lifecycle).unwrap();
    let state = Store::new(identity.clone())
        .unwrap()
        .publish(
            Revision {
                head: context.head.clone(),
                local_head: context.head.clone(),
                target: "main".into(),
                declaration: "fixture".into(),
                evidence_digest: "fixture".into(),
            },
            EventState::Completed,
            "fixture".into(),
            "Refresh native evidence".into(),
            watch_store::now(),
        )
        .unwrap();
    let id = &state.events[0].id;
    for event in ["PostToolUse", "SessionStart", "PreToolUse"] {
        let payload = json!({"session_id":"fixture-session","hook_event_name":event,"cwd":t.path(),"tool_name":"Edit","tool_input":{"file_path":"file"}});
        let out = run(event, &serde_json::to_vec(&payload).unwrap());
        assert!(out.status.success());
        if event == "PreToolUse" {
            assert!(out.stdout.is_empty());
            continue;
        }
        let value: Value = serde_json::from_slice(&out.stdout).unwrap();
        let text = value["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap();
        assert!(
            text.contains(id) && text.contains("unverified event receipts"),
            "{value}"
        );
        assert_eq!(
            text.contains("Remote state is not checked"),
            event == "SessionStart"
        );
        assert_eq!(text.contains("SpecGit 2 ["), event == "SessionStart");
    }
    assert!(
        watch_store::read(&identity).unwrap().unwrap().events[0]
            .acknowledged_at
            .is_none()
    );
}
