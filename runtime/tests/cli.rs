#[path = "support/executable.rs"]
mod executable;
use std::process::Command;

#[test]
fn discovery_precedes_explicit_input_and_preserves_input_dispatch() {
    let root = tempfile::tempdir().unwrap();
    let valid = root.path().join("request.json");
    std::fs::write(&valid, r#"{"command":"setup","options":{"catalog":true}}"#).unwrap();
    for path in [root.path().join("missing.json"), valid.clone()] {
        let output = executable::command()
            .args(["--help", "--input-file"])
            .arg(path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["operation"], "help");
    }
    let output = executable::command()
        .arg("--input-file")
        .arg(valid)
        .output()
        .unwrap();
    assert!(output.status.success());
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["operation"], "setup");
}

#[test]
fn discovery_and_input_diagnostics_follow_cli_boundaries() {
    let output = executable::command()
        .args(["--version", "--json"])
        .output()
        .unwrap();
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["operation"], "version");

    let output = executable::command()
        .args(["--cwd", "issue", "--schema"])
        .output()
        .unwrap();
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["evidence"]["command"]["name"], "specgit");

    let output = executable::command()
        .args(["--human", "--input-file", "/missing-specgit-input.json"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(3));
    assert!(serde_json::from_slice::<serde_json::Value>(&output.stdout).is_err());

    let output = executable::command()
        .args(["--human", "issue", "--", "--json"])
        .output()
        .unwrap();
    assert!(serde_json::from_slice::<serde_json::Value>(&output.stdout).is_err());

    let output = executable::command()
        .args(["issue", "accept", "--bad", "--json"])
        .output()
        .unwrap();
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_ne!(report["diagnostics"][0]["operation"], "major_version");
}

#[test]
fn schema_discovery_accepts_unknown_operands() {
    for args in [
        ["--schema", "frobnicate", "--json"],
        ["--schema", "issue", "--bogus"],
    ] {
        let output = executable::command().args(args).output().unwrap();
        assert!(output.status.success());
        let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["operation"], "schema");
    }
}

#[cfg(unix)]
#[test]
fn non_utf8_inline_input_file_is_not_ignored() {
    use std::os::unix::ffi::OsStringExt;
    let arg = std::ffi::OsString::from_vec(b"--input-file=\xff".to_vec());
    let output = executable::command()
        .args(["setup", "--catalog", "--json"])
        .arg(arg)
        .output()
        .unwrap();
    assert!(!output.status.success());
}

#[cfg(unix)]
#[test]
fn setup_preserves_newline_in_repository_path() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("repo\n");
    std::fs::create_dir(&root).unwrap();
    assert!(
        Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&root)
            .status()
            .unwrap()
            .success()
    );
    let output = executable::command()
        .args(["setup", "--dry-run", "--json"])
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
}

#[cfg(unix)]
#[test]
fn guard_reads_ownership_receipt_from_git_directory_ending_in_newline() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("repo");
    let git_dir = temp.path().join("git-dir\n");
    std::fs::create_dir(&root).unwrap();
    assert!(
        Command::new("git")
            .args(["init", "--quiet", "--separate-git-dir"])
            .arg(&git_dir)
            .current_dir(&root)
            .status()
            .unwrap()
            .success()
    );
    std::fs::remove_file(root.join(".git")).unwrap();
    std::os::unix::fs::symlink(&git_dir, root.join(".git")).unwrap();
    std::fs::write(root.join(".specgit.yaml"), "version: 2\nremote: origin\n").unwrap();
    std::fs::write(root.join("staged"), "content").unwrap();
    assert!(
        Command::new("git")
            .args(["add", "staged"])
            .current_dir(&root)
            .status()
            .unwrap()
            .success()
    );
    let private = git_dir.join("specgit-v2/agent-assets");
    std::fs::create_dir_all(&private).unwrap();
    std::fs::write(private.join("ownership.json"), "invalid").unwrap();
    let output = executable::command()
        .args(["guard", "--stage", "pre-commit"])
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("ownership receipt"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
#[cfg(all(windows, feature = "test-fixtures"))]
#[test]
fn console_interrupt_preserves_native_cancellation_json_through_the_installed_entrypoint() {
    use std::{fs, os::windows::process::CommandExt};
    use windows_sys::Win32::System::Threading::CREATE_NEW_CONSOLE;
    let root = tempfile::tempdir().unwrap();
    fs::copy(
        env!("CARGO_BIN_EXE_specgit-process-fixture"),
        root.path().join("git.exe"),
    )
    .unwrap();
    let entry = executable::command();
    let mut helper = Command::new(env!("CARGO_BIN_EXE_specgit-process-fixture"));
    helper
        .creation_flags(CREATE_NEW_CONSOLE)
        .arg("console-interrupt")
        .arg(entry.get_program())
        .args(entry.get_args())
        .args(["status", "--json"])
        .current_dir(root.path())
        .env("PATH", root.path())
        .env("SPECGIT_FIXTURE_GIT_TIMEOUT", "1")
        .env("SPECGIT_FIXTURE_READY_PID", root.path().join("ready"));
    let out = helper.output().unwrap();
    assert_eq!(
        out.status.code(),
        Some(130),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&out.stdout).unwrap()["exit"],
        130
    );
    assert!(out.stderr.is_empty());
}
#[cfg(all(unix, feature = "test-fixtures"))]
#[test]
fn interrupts_preserve_json_and_reap_the_native_child_through_the_installed_entrypoint() {
    use std::{
        fs,
        process::Stdio,
        time::{Duration, Instant},
    };
    for signal in [libc::SIGINT, libc::SIGTERM, libc::SIGHUP] {
        let root = tempfile::tempdir().unwrap();
        fs::copy(
            env!("CARGO_BIN_EXE_specgit-process-fixture"),
            root.path().join("git"),
        )
        .unwrap();
        let ready = root.path().join("ready");
        let mut child = executable::command()
            .current_dir(root.path())
            .env("PATH", root.path())
            .env("SPECGIT_FIXTURE_GIT_TIMEOUT", "1")
            .env("SPECGIT_FIXTURE_READY_PID", &ready)
            .args(["status", "--json"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !ready.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        if !ready.exists() {
            let _ = child.kill();
            panic!("native Git child never became ready");
        }
        // SAFETY: this is the exact child spawned and still owned by this test.
        assert_eq!(unsafe { libc::kill(child.id() as i32, signal) }, 0);
        while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        if child.try_wait().unwrap().is_none() {
            let _ = child.kill();
            panic!("cancellation did not finish within its bound");
        }
        let out = child.wait_with_output().unwrap();
        assert_eq!(
            out.status.code(),
            Some(130),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&out.stdout).unwrap()["exit"],
            130
        );
        assert!(out.stderr.is_empty());
        let pid: i32 = fs::read_to_string(ready).unwrap().parse().unwrap();
        assert_eq!(
            // SAFETY: signal zero only probes whether the recorded owned child remains.
            unsafe { libc::kill(pid, 0) },
            -1,
            "native child outlived cancelled entrypoint"
        );
    }
}
#[test]
fn json_invalid_arguments_have_one_document_and_matching_exit() {
    let output = executable::command()
        .args(["doctor", "--dry-run", "--json"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["exit"], 2);
    assert_eq!(value["schema_version"], 2);
    assert!(output.stderr.is_empty());
}
#[test]
fn binary_version_matches_package() {
    let output = executable::command().arg("--version").output().unwrap();
    assert!(output.status.success());
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains(env!("CARGO_PKG_VERSION"))
    );
}

#[test]
fn offline_status_does_not_discard_an_existing_declaration() {
    let root = tempfile::tempdir().unwrap();
    for args in [
        vec!["init"],
        vec!["config", "user.name", "Fixture"],
        vec!["config", "user.email", "fixture@example.invalid"],
        vec!["commit", "--allow-empty", "-m", "fixture"],
        vec![
            "remote",
            "add",
            "origin",
            "https://github.com/fixture/repo.git",
        ],
    ] {
        assert!(
            Command::new("git")
                .current_dir(root.path())
                .args(args)
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    let run = || {
        executable::command()
            .current_dir(root.path())
            .args(["status", "--json"])
            .output()
            .unwrap()
    };
    let initial = run();
    assert!(initial.status.success());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&initial.stdout).unwrap()["status"],
        "uninitialized"
    );
    let declaration = b"version: 1\nforeign: preserve exactly\n";
    std::fs::write(root.path().join(".specgit.yaml"), declaration).unwrap();
    let existing = run();
    assert_eq!(existing.status.code(), Some(3));
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&existing.stdout).unwrap()["diagnostics"][0]["code"],
        "migration_required"
    );
    assert_eq!(
        std::fs::read(root.path().join(".specgit.yaml")).unwrap(),
        declaration
    );
    std::fs::write(
        root.path().join(".specgit.yaml"),
        b"version: 2\nremote: origin\nlanguage: zh\n",
    )
    .unwrap();
    let initialized = run();
    assert!(initialized.status.success());
    let report: serde_json::Value = serde_json::from_slice(&initialized.stdout).unwrap();
    assert_eq!(report["status"], "initialized");
    assert_eq!(report["evidence"]["remote_state"], "not_checked");
    assert_eq!(report["evidence"]["declaration"]["language"], "zh");
}

#[test]
fn project_diagnostics_keep_missing_executable_distinct_from_missing_repository() {
    let root = tempfile::tempdir().unwrap();
    let run = |missing_git| {
        let mut command = executable::command();
        command
            .current_dir(root.path())
            .env("LC_ALL", "zh_CN.UTF-8")
            .env("LANG", "zh_CN.UTF-8")
            .args(["doctor", "--provider", "github", "--json"]);
        if missing_git {
            command.env("PATH", root.path());
        }
        let out = command.output().unwrap();
        assert_eq!(out.status.code(), Some(3));
        serde_json::from_slice::<serde_json::Value>(&out.stdout).unwrap()
    };
    let missing = run(true);
    assert_eq!(missing["diagnostics"][0]["code"], "missing_executable");
    assert_eq!(
        missing["evidence"]["probes"][0]["diagnostic"]["code"],
        "missing_executable"
    );
    assert_eq!(run(false)["diagnostics"][0]["code"], "missing_project");
}

#[cfg(feature = "test-fixtures")]
#[test]
fn project_diagnostic_preserves_native_git_timeout() {
    let root = tempfile::tempdir().unwrap();
    let name = if cfg!(windows) { "git.exe" } else { "git" };
    std::fs::copy(
        env!("CARGO_BIN_EXE_specgit-process-fixture"),
        root.path().join(name),
    )
    .unwrap();
    let out = executable::command()
        .current_dir(root.path())
        .env("PATH", root.path())
        .env("SPECGIT_FIXTURE_GIT_TIMEOUT", "1")
        .args(["status", "--json"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(3));
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&out.stdout).unwrap()["diagnostics"][0]["code"],
        "timeout"
    );
}

#[cfg(feature = "test-fixtures")]
#[test]
fn successful_help_never_substitutes_for_account_api_evidence() {
    let root = tempfile::tempdir().unwrap();
    for name in ["git", "gh", "glab"] {
        let name = if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.into()
        };
        std::fs::copy(
            env!("CARGO_BIN_EXE_specgit-process-fixture"),
            root.path().join(name),
        )
        .unwrap();
    }
    for provider in ["github", "gitlab"] {
        for (response, code) in [
            ("unauth", "authentication_failed"),
            ("network", "network_failed"),
            ("forbidden", "permission_denied"),
            ("bad", "malformed_response"),
        ] {
            let out = executable::command()
                .current_dir(root.path())
                .env("PATH", root.path())
                .env("SPECGIT_FIXTURE_PROBE_MODE", "1")
                .env("SPECGIT_FIXTURE_RESPONSE", response)
                .args([
                    "doctor",
                    "--provider",
                    provider,
                    "--api-host",
                    "forge.example",
                    "--account-only",
                    "--json",
                ])
                .output()
                .unwrap();
            assert_eq!(out.status.code(), Some(3));
            let report: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
            let probes = report["evidence"]["probes"].as_array().unwrap();
            assert_eq!(probes[0]["status"], "available");
            assert_eq!(
                probes
                    .iter()
                    .find(|p| p["operation"] == "account_api")
                    .unwrap()["diagnostic"]["code"],
                code
            );
            assert_eq!(
                probes
                    .iter()
                    .find(|p| p["operation"] == "project_api")
                    .unwrap()["status"],
                "not_checked"
            );
            assert_eq!(report["evidence"]["write_permissions"], "not_checked");
            assert!(!String::from_utf8(out.stdout).unwrap().contains("secret"));
        }
    }
}

/// `--schema` must publish every option dependency, including one on a group,
/// so a machine client never builds an input that clap is certain to reject.
#[test]
fn schema_lists_init_and_setup_write_boundaries() {
    for (command, expected) in [
        (
            "init",
            &[
                "guard", "guidance", "routing", "receipt", "inspect", "dry_run",
            ][..],
        ),
        (
            "setup",
            &[
                "guard",
                "guidance",
                "routing",
                "receipt",
                "uninstall",
                "rollback",
                "dry_run",
            ][..],
        ),
    ] {
        let out = executable::command()
            .args([command, "--schema", "--json"])
            .output()
            .unwrap();
        let report: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        let writes = report["evidence"]["command"]["effects"]["local_writes"]
            .as_str()
            .unwrap();
        for item in expected {
            assert!(writes.contains(item), "{command}: missing {item}: {writes}");
        }
    }
}

#[test]
fn schema_publishes_option_requirements_and_the_groups_they_name() {
    let out = executable::command()
        .args(["--schema", "--json"])
        .output()
        .unwrap();
    assert!(out.status.success(), "{out:?}");
    let report: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let root = &report["evidence"]["command"];
    let find = |name: &str| {
        root["commands"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == name)
            .unwrap_or_else(|| panic!("{name} in schema"))
            .clone()
    };
    let requires = |command: &serde_json::Value, long: &str| {
        command["arguments"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["long"] == long)
            .unwrap_or_else(|| panic!("{long}"))["requires"]
            .clone()
    };
    let guard = find("guard");
    assert_eq!(
        requires(&guard, "dry-run"),
        serde_json::json!(["guard_operation"])
    );
    assert_eq!(requires(&guard, "install"), serde_json::json!([]));
    let group = guard["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["id"] == "guard_operation")
        .expect("the named group is published");
    assert_eq!(
        group["arguments"],
        serde_json::json!(["install", "uninstall"])
    );
    let doctor = find("doctor");
    assert_eq!(requires(&doctor, "dry-run"), serde_json::json!(["fix"]));
    assert_eq!(
        requires(&doctor, "account-only"),
        serde_json::json!(["provider"])
    );
    assert_eq!(group["required"], false);
    for (command, long, target) in [
        ("remove", "apply", "expect"),
        ("remove", "expect", "apply"),
        ("migrate", "apply", "expect"),
        ("migrate", "expect", "apply"),
        ("pr", "update-body", "body_file"),
    ] {
        assert_eq!(
            requires(&find(command), long),
            serde_json::json!([target]),
            "{command}"
        );
    }
}

#[test]
fn init_check_visible_alias_is_published_and_accepted_by_the_real_cli() {
    let schema_out = executable::command()
        .args(["--schema", "--json"])
        .output()
        .unwrap();
    assert!(schema_out.status.success());
    let schema: serde_json::Value = serde_json::from_slice(&schema_out.stdout).unwrap();
    let init = schema["evidence"]["command"]["commands"]
        .as_array()
        .unwrap()
        .iter()
        .find(|command| command["name"] == "init")
        .unwrap();
    let inspect = init["arguments"]
        .as_array()
        .unwrap()
        .iter()
        .find(|argument| argument["long"] == "inspect")
        .unwrap();
    assert_eq!(inspect["aliases"], serde_json::json!(["check"]));

    let temp = tempfile::tempdir().unwrap();
    let output = executable::command()
        .current_dir(temp.path())
        .args(["init", "--check", "--json"])
        .output()
        .unwrap();
    assert_ne!(
        output.status.code(),
        Some(2),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["operation"], "init");
}

/// Agents read `--tags` help to decide whether and which labels to pass.
#[test]
fn schema_explains_tags_by_label_mode_for_issue_and_request() {
    let out = executable::command()
        .args(["--schema", "--json"])
        .output()
        .unwrap();
    assert!(out.status.success(), "{out:?}");
    let report: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    for name in ["issue", "pr"] {
        let command = report["evidence"]["command"]["commands"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == name)
            .unwrap_or_else(|| panic!("{name} in schema"));
        let help = command["arguments"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["long"] == "tags")
            .unwrap_or_else(|| panic!("{name} --tags"))["help"]
            .as_str()
            .unwrap_or_else(|| panic!("{name} --tags help"));
        for rule in [
            "validation.labels",
            "kind derives one kind::<type> from the title",
            "explicit tags need exactly",
            "repository template labels",
            "project requires declared tags",
            "off: pass only when the user or project asks",
        ] {
            assert!(help.contains(rule), "{name}: {help}");
        }
    }
}
