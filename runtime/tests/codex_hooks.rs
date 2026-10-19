#![cfg(feature = "test-fixtures")]
#[allow(dead_code)]
#[path = "support/delivery.rs"]
mod delivery;
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    process::{Command, Output, Stdio},
};
fn setup(f: &delivery::Fixture) -> Value {
    let result = f.run(&[
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
    assert_eq!(result["exit"], 0, "{result}");
    serde_json::from_slice(&fs::read(f.root.join(".codex/hooks.json")).unwrap()).unwrap()
}
fn entry<'a>(settings: &'a Value, event: &str, observer: bool) -> &'a Value {
    settings["hooks"][event]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|group| group["hooks"].as_array().unwrap())
        .find(|hook| hook["async"].as_bool().unwrap_or(false) == observer)
        .unwrap_or_else(|| panic!("missing {event} observer={observer}: {settings}"))
}
// Codex executes only command, never the unrelated args extension.
fn execute(f: &delivery::Fixture, registration: &Value, bytes: &[u8]) -> Output {
    let command = if cfg!(windows) {
        registration["commandWindows"]
            .as_str()
            .or(registration["command"].as_str())
    } else {
        registration["command"].as_str()
    }
    .unwrap();
    #[cfg(unix)]
    let mut shell = {
        let mut c = Command::new("/bin/sh");
        c.args(["-c", command]);
        c
    };
    #[cfg(windows)]
    let mut shell = {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("cmd.exe");
        // cmd strips the outer pair before parsing the quoted executable.
        c.arg("/C");
        c.raw_arg(format!(r#""{command}""#));
        c
    };
    let env = f.command(&[]);
    shell.current_dir(&f.root);
    for (key, value) in env.get_envs() {
        if let Some(value) = value {
            shell.env(key, value);
        }
    }
    let mut child = shell
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(bytes).unwrap();
    child.wait_with_output().unwrap()
}
fn event(
    f: &delivery::Fixture,
    settings: &Value,
    name: &str,
    observer: bool,
    payload: Value,
) -> Output {
    execute(
        f,
        entry(settings, name, observer),
        &serde_json::to_vec(&payload).unwrap(),
    )
}
fn run_command(mut command: Command, name: &str, bytes: &[u8]) -> Output {
    let mut child = command
        .args(["hook", "--event", name])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(bytes).unwrap();
    child.wait_with_output().unwrap()
}
fn payload(f: &delivery::Fixture, name: &str) -> Value {
    json!({"session_id":"codex-lifecycle", "hook_event_name":name,"cwd":f.root})
}
fn value(out: &Output) -> Value {
    assert!(
        out.status.success(),
        "status={} stdout={} stderr={}",
        out.status,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}
#[test]
fn codex_generated_command_delivers_session_context() {
    let f = delivery::Fixture::new("github");
    let settings = setup(&f);
    let out = event(
        &f,
        &settings,
        "SessionStart",
        false,
        payload(&f, "SessionStart"),
    );
    let result = value(&out);
    assert!(
        result["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .is_some(),
        "{result}"
    );
}

#[test]
fn codex_pre_tool_use_never_denies_ordinary_tools_and_observers_are_absent() {
    let f = delivery::Fixture::new("github");
    let settings = setup(&f);
    for tool in [
        "Read",
        "Glob",
        "Grep",
        "Write",
        "Edit",
        "apply_patch",
        "Bash",
        "unknown",
    ] {
        let mut p = payload(&f, "PreToolUse");
        p["tool_name"] = json!(tool);
        p["tool_input"] = json!({"file_path":f.root.join(".specgit.yaml"),"command":"git push"});
        let out = event(&f, &settings, "PreToolUse", false, p);
        assert!(
            out.status.success(),
            "{tool}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
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
    for name in ["PostToolUse", "Stop"] {
        let out = run_command(
            f.command(&[]),
            name,
            &serde_json::to_vec(&payload(&f, name)).unwrap(),
        );
        assert!(out.status.success());
        assert!(out.stdout.is_empty());
        assert!(out.stderr.is_empty());
    }
    for event in ["SessionStart", "PreToolUse"] {
        let groups = settings["hooks"][event].as_array().unwrap();
        assert!(
            groups
                .iter()
                .flat_map(|g| g["hooks"].as_array().unwrap())
                .all(|hook| !hook["async"].as_bool().unwrap_or(false))
        );
    }
    assert_eq!(settings["hooks"].as_object().unwrap().len(), 2);
}

#[test]
fn codex_observation_purpose_is_declined_without_registering_observers() {
    let f = delivery::Fixture::new("github");
    let result = f.run(&[
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
    assert_eq!(result["exit"], 0, "{result}");
    let settings: Value =
        serde_json::from_slice(&fs::read(f.root.join(".codex/hooks.json")).unwrap()).unwrap();
    assert_eq!(settings["hooks"].as_object().unwrap().len(), 2);
    for event in ["SessionStart", "PreToolUse"] {
        assert!(settings["hooks"][event].as_array().is_some(), "{settings}");
        assert!(
            settings["hooks"][event]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|g| g["hooks"].as_array().unwrap())
                .all(|hook| !hook["async"].as_bool().unwrap_or(false))
        );
    }
    assert_eq!(
        result["evidence"]["host_delivery"]["idle_wake"],
        "not_supported"
    );
    assert!(
        result["evidence"]["hook_purposes"]["codex"]["declined"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["purpose"] == "observe"),
        "{result}"
    );
}

#[test]
fn codex_registered_input_failures_remain_nonblocking() {
    let f = delivery::Fixture::new("github");
    let settings = setup(&f);
    for input in [
        b"{".to_vec(),
        b"{\"cwd\":\"a\",\"cwd\":\"b\"}".to_vec(),
        vec![b'x'; 1_048_577],
    ] {
        let out = execute(&f, entry(&settings, "SessionStart", false), &input);
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
fn codex_setup_preview_refresh_uninstall_and_rollback_preserve_foreign_assets() {
    for rollback in [false, true] {
        let f = delivery::Fixture::new("github");
        let path = f.root.join(".codex/hooks.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let foreign = json!({"permissions":{"user":"keep"},"hooks":{"SessionStart":[{"matcher":"foreign","hooks":[{"type":"command","command":"foreign-tool"}]}]}});
        let original = serde_json::to_vec_pretty(&foreign).unwrap();
        fs::write(&path, &original).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        }
        let preview = f.run(&[
            "setup",
            "--agent",
            "codex",
            "--hook-purpose",
            "context",
            "--dry-run",
        ]);
        assert_eq!(preview["exit"], 0, "{preview}");
        assert_eq!(fs::read(&path).unwrap(), original);
        let installed = f.run(&["setup", "--agent", "codex", "--hook-purpose", "context"]);
        assert_eq!(installed["exit"], 0, "{installed}");
        let bytes = fs::read(&path).unwrap();
        let settings: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(settings["permissions"], foreign["permissions"]);
        assert_eq!(
            settings["hooks"]["SessionStart"][0],
            foreign["hooks"]["SessionStart"][0]
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o640
            );
        }
        // Find the owned registration; do not execute the user's foreign command.
        let owned = settings["hooks"]["SessionStart"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|group| group["hooks"].as_array().unwrap())
            .find(|hook| hook["command"] != "foreign-tool")
            .unwrap();
        let out = execute(
            &f,
            owned,
            &serde_json::to_vec(&payload(&f, "SessionStart")).unwrap(),
        );
        assert!(value(&out)["hookSpecificOutput"]["additionalContext"].is_string());
        let noop = f.run(&["setup", "--agent", "codex", "--hook-purpose", "context"]);
        assert_eq!(noop["exit"], 0, "{noop}");
        assert_eq!(noop["evidence"]["transaction"]["changes"], 0, "{noop}");
        assert_eq!(fs::read(&path).unwrap(), bytes);
        let removed = if rollback {
            let transaction = installed["evidence"]["transaction"]["transaction"]
                .as_str()
                .unwrap();
            f.run(&["setup", "--rollback", transaction])
        } else {
            f.run(&["setup", "--uninstall"])
        };
        assert_eq!(removed["exit"], 0, "{removed}");
        let restored: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(restored, foreign);
    }
}

#[test]
fn codex_generated_command_runs_shared_executable_with_shell_metacharacters() {
    use specgit::setup::{Agent, HookOptions, HookPurpose, project};
    let f = delivery::Fixture::new("github");
    let outside = tempfile::tempdir().unwrap();
    let filename = if cfg!(windows) {
        "specgit space ' & ^.exe"
    } else {
        "specgit space ' $ ` &"
    };
    let source = outside.path().canonicalize().unwrap().join(filename);
    fs::copy(delivery::executable::binary(), &source).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&source, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let options = project::Options {
        agents: vec![Agent::Codex],
        opencode_claude_hooks: false,
        uninstall: false,
        dry_run: false,
        rollback: None,
    };
    let hooks = HookOptions {
        purposes: vec![HookPurpose::Context, HookPurpose::Observe],
        opencode_async_rewake: false,
    };
    project::install_with_hooks(
        &options,
        &hooks,
        &f.root,
        &f.root.join(".git/specgit-v2/setup"),
        &source,
    )
    .unwrap();
    let settings: Value =
        serde_json::from_slice(&fs::read(f.root.join(".codex/hooks.json")).unwrap()).unwrap();
    let out = event(
        &f,
        &settings,
        "SessionStart",
        false,
        payload(&f, "SessionStart"),
    );
    assert!(value(&out)["hookSpecificOutput"]["additionalContext"].is_string());
    let mut p = payload(&f, "PreToolUse");
    p["tool_name"] = json!("Write");
    p["tool_input"] = json!({"file_path":f.root.join(".specgit.yaml")});
    let output = event(&f, &settings, "PreToolUse", false, p);
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
}
