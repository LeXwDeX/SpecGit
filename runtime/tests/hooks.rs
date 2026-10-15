#[cfg(feature = "test-fixtures")]
#[allow(dead_code)]
#[path = "support/delivery.rs"]
mod delivery;
#[cfg(not(feature = "test-fixtures"))]
#[path = "support/executable.rs"]
mod executable;
#[cfg(feature = "test-fixtures")]
use delivery::executable;
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

#[cfg(feature = "test-fixtures")]
#[test]
fn retired_host_events_are_quiet_without_observation_side_effects() {
    let f = delivery::Fixture::new("github");
    let calls = f.state()["calls"].clone();
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
        let malformed = run_command(f.command(&[]), event, b"{");
        assert!(malformed.status.success());
        assert!(malformed.stdout.is_empty());
        assert!(malformed.stderr.is_empty());
    }
    fs::remove_file(f.root.join(".specgit.yaml")).unwrap();
    for event in ["PostToolUse", "Stop"] {
        let payload = json!({"session_id":"legacy-session","hook_event_name":event,"cwd":f.root});
        let output = run_command(
            f.command(&[]),
            event,
            &serde_json::to_vec(&payload).unwrap(),
        );
        assert!(output.status.success());
        assert!(output.stdout.is_empty());
        assert!(output.stderr.is_empty());
    }
    assert_eq!(f.state()["calls"], calls);
}

#[cfg(feature = "test-fixtures")]
#[test]
fn explicit_observe_mode_declines_with_a_bounded_recovery_path() {
    let f = delivery::Fixture::new("github");
    let output = f
        .command(&["hook", "--event", "PreToolUse", "--observe"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    let diagnostic = String::from_utf8_lossy(&output.stderr);
    assert!(
        diagnostic.contains("Automatic host observation is unsupported"),
        "{diagnostic}"
    );
    assert!(
        diagnostic.contains("watch") || diagnostic.contains("inbox"),
        "{diagnostic}"
    );
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
fn session_start_is_brief_context_and_pre_tool_use_does_not_gate_edits() {
    let t = fixture();
    fs::write(
        t.path().join(".specgit.yaml"),
        "version: 2\nremote: origin\nlanguage: en\n",
    )
    .unwrap();
    let session = json!({"session_id":"fixture-session","hook_event_name":"SessionStart","cwd":t.path(),"future_field":"retained by host"});
    let out = run("SessionStart", &serde_json::to_vec(&session).unwrap());
    assert!(out.status.success());
    let value: Value = serde_json::from_slice(&out.stdout).unwrap();
    let text = value["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap();
    assert!(
        text.contains(".agents/skills/specgit-native/SKILL.md"),
        "{text}"
    );
    assert!(text.contains("commit/push"), "{text}");
    assert!(text.contains("TDD") && text.contains("CI"), "{text}");
    assert!(
        text.len() < 1200,
        "SessionStart should stay concise: {text}"
    );
    assert!(value.get("decision").is_none());
    for (tool, input) in [
        (
            "Write",
            json!({"file_path":t.path().join("src/lib.rs"),"content":"x"}),
        ),
        (
            "Edit",
            json!({"file_path":t.path().join("src/lib.rs"),"old_string":"a","new_string":"b"}),
        ),
        (
            "apply_patch",
            json!({"patch":"*** Begin Patch\n*** Update File: src/lib.rs\n-x\n+y\n*** End Patch"}),
        ),
        (
            "Bash",
            json!({"command":"printf changed > src/lib.rs && git add -A"}),
        ),
    ] {
        let payload = json!({"session_id":"fixture-session","hook_event_name":"PreToolUse","cwd":t.path(),"tool_name":tool,"tool_input":input});
        let out = run("PreToolUse", &serde_json::to_vec(&payload).unwrap());
        assert!(out.status.success());
        assert!(
            out.stdout.is_empty(),
            "{tool}: {}",
            String::from_utf8_lossy(&out.stdout)
        );
        assert!(
            out.stderr.is_empty(),
            "{tool}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    for event in ["PostToolUse", "Stop"] {
        let payload =
            json!({"session_id":"fixture-session","hook_event_name":event,"cwd":t.path()});
        let out = run(event, &serde_json::to_vec(&payload).unwrap());
        assert!(out.status.success());
        assert!(out.stdout.is_empty());
        assert!(out.stderr.is_empty());
    }
}
#[test]
fn stale_selection_does_not_turn_pre_tool_use_into_a_write_gate() {
    let t = fixture();
    fs::write(
        t.path().join(".specgit.yaml"),
        "version: 2\nremote: origin\ntarget: main\nlanguage: en\n",
    )
    .unwrap();
    checkpoint(t.path(), "master");
    git(t.path(), &["checkout", "-b", "other"]);
    let payload = json!({"session_id":"fixture-session","hook_event_name":"PreToolUse","cwd":t.path(),"tool_name":"Write","tool_input":{"file_path":t.path().join("src/lib.rs")}});
    let out = run("PreToolUse", &serde_json::to_vec(&payload).unwrap());
    assert!(out.status.success());
    assert!(
        out.stdout.is_empty(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    assert!(
        out.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}
#[test]
fn malformed_supported_hook_inputs_remain_nonblocking() {
    for bytes in [
        b"{".to_vec(),
        b"{\"cwd\":\"a\",\"cwd\":\"b\"}".to_vec(),
        vec![b'x'; 1_048_577],
    ] {
        let out = run("SessionStart", &bytes);
        assert!(out.status.success());
        if !out.stdout.is_empty() {
            let value: Value = serde_json::from_slice(&out.stdout).unwrap();
            assert!(value.get("decision").is_none());
            assert!(
                value
                    .pointer("/hookSpecificOutput/permissionDecision")
                    .is_none()
            );
        }
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
    if !output.stdout.is_empty() {
        let v: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(
            v.pointer("/hookSpecificOutput/permissionDecision")
                .is_none()
        );
        assert!(v.get("decision").is_none());
    }
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
fn pre_tool_use_never_guards_native_writes_or_shell_segments() {
    let t = fixture();
    fs::write(
        t.path().join(".specgit.yaml"),
        "version: 2\nremote: origin\n",
    )
    .unwrap();
    for command in [
        "touch generated.rs",
        "specgit issue --inspect fix",
        "specgit issue fix",
        "specgit pr --ready",
        "gh pr merge 41",
        "git push",
        "printf data > output.txt",
        "cmd && git push",
    ] {
        let payload = shell_payload(t.path(), command);
        let out = run("PreToolUse", &serde_json::to_vec(&payload).unwrap());
        assert!(out.status.success(), "{command}");
        assert!(
            out.stdout.is_empty(),
            "{command}: {}",
            String::from_utf8_lossy(&out.stdout)
        );
        assert!(
            out.stderr.is_empty(),
            "{command}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}

fn shell_payload(root: &std::path::Path, command: &str) -> Value {
    json!({"session_id":"fixture-session","hook_event_name":"PreToolUse","cwd":root,"tool_name":"Bash","tool_input":{"command":command}})
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
    assert!(
        output.stdout.is_empty(),
        "stdout: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        output.stderr.is_empty(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
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

#[test]
fn pre_tool_use_stays_quiet_and_legacy_events_do_not_emit_pending_receipts() {
    let t = fixture();
    fs::write(
        t.path().join(".specgit.yaml"),
        "version: 2\nremote: origin\nlanguage: en\n",
    )
    .unwrap();
    checkpoint(t.path(), "master");
    for event in ["PreToolUse", "PostToolUse", "Stop"] {
        let payload = json!({"session_id":"fixture-session","hook_event_name":event,"cwd":t.path(),"tool_name":"Edit","tool_input":{"file_path":"file"}});
        let out = run(event, &serde_json::to_vec(&payload).unwrap());
        assert!(out.status.success());
        assert!(out.stdout.is_empty());
        assert!(out.stderr.is_empty());
    }
}
