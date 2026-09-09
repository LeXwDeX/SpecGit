use std::process::Command;
#[test]
fn json_invalid_arguments_have_one_document_and_matching_exit() {
    let output = Command::new(env!("CARGO_BIN_EXE_specgit"))
        .args(["doctor", "--json"])
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
    let output = Command::new(env!("CARGO_BIN_EXE_specgit"))
        .arg("--version")
        .output()
        .unwrap();
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
        Command::new(env!("CARGO_BIN_EXE_specgit"))
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
        let mut command = Command::new(env!("CARGO_BIN_EXE_specgit"));
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
    let out = Command::new(env!("CARGO_BIN_EXE_specgit"))
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
            let out = Command::new(env!("CARGO_BIN_EXE_specgit"))
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
