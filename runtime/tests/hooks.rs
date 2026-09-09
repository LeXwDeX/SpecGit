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
fn run(event: &str, bytes: &[u8]) -> std::process::Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_specgit"))
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
    for event in ["SessionStart", "PreToolUse", "PostToolUse", "Stop"] {
        let p = json!({"session_id":"fixture-session","hook_event_name":event,"cwd":t.path(),"tool_name":"Edit","tool_input":{"file_path":"file","unknown":{"retain":[1,true]}},"future_field":"retained by host"});
        let original = p.clone();
        let out = run(event, &serde_json::to_vec(&p).unwrap());
        assert!(out.status.success());
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
    let mut child = Command::new(env!("CARGO_BIN_EXE_specgit"))
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
fn setup_installs_native_adapter_even_when_readiness_is_unavailable() {
    let t = tempfile::tempdir().unwrap();
    let root = t
        .path()
        .canonicalize()
        .unwrap()
        .join("installed 中文 $ literal");
    let out = Command::new(env!("CARGO_BIN_EXE_specgit"))
        .current_dir(t.path())
        .env("PATH", t.path())
        .args([
            "setup",
            "--provider",
            "github",
            "--root",
            root.to_str().unwrap(),
            "--json",
        ])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(3));
    let value: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["status"], "installed");
    assert_eq!(value["evidence"]["readiness"], "unknown");
    assert!(root.join("manifest.json").exists());
    let m: Value = serde_json::from_slice(&fs::read(root.join("manifest.json")).unwrap()).unwrap();
    let h = &m["hooks"]["SessionStart"][0]["hooks"][0];
    let mut child = Command::new(h["command"].as_str().unwrap())
        .args(
            h["args"]
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
fn native_write_commands_trigger_observation_context_but_observer_commands_do_not_recurse() {
    let t = fixture();
    fs::write(
        t.path().join(".specgit.yaml"),
        "version: 2\nremote: origin\n",
    )
    .unwrap();
    for (command, relevant) in [
        ("specgit pr --ready", true),
        (
            "specgit merge --request 41 --mode now --strategy squash",
            true,
        ),
        ("node bin/specgit.js issue 1", true),
        ("specgit watch --request 41", false),
        ("specgit inbox --request 41", false),
        ("specgit finish", false),
    ] {
        let payload = json!({"session_id":"fixture-session","hook_event_name":"PostToolUse","cwd":t.path(),"tool_name":"Bash","tool_input":{"command":command}});
        assert_eq!(
            !run("PostToolUse", &serde_json::to_vec(&payload).unwrap())
                .stdout
                .is_empty(),
            relevant,
            "{command}"
        );
    }
}
