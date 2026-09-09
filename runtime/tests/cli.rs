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
}
