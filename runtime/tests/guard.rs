#[path = "support/executable.rs"]
mod executable;
use serde_json::json;
use std::{
    fs,
    io::Write,
    path::Path,
    process::{Command, Stdio},
};

fn git(root: &Path, args: &[&str]) {
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
    let temp = tempfile::tempdir().unwrap();
    git(temp.path(), &["init", "-b", "feature"]);
    git(temp.path(), &["config", "user.name", "Fixture"]);
    git(
        temp.path(),
        &["config", "user.email", "fixture@example.invalid"],
    );
    git(temp.path(), &["commit", "--allow-empty", "-m", "fixture"]);
    git(
        temp.path(),
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/owner/repo.git",
        ],
    );
    fs::write(
        temp.path().join(".specgit.yaml"),
        "version: 2\nremote: origin\ntarget: main\n",
    )
    .unwrap();
    temp
}

fn checkpoint(root: &Path, branch: &str) {
    let output = Command::new("git")
        .current_dir(root)
        .args(["rev-parse", "--absolute-git-dir"])
        .output()
        .unwrap();
    let directory =
        Path::new(std::str::from_utf8(&output.stdout).unwrap().trim()).join("specgit-v2");
    fs::create_dir_all(&directory).unwrap();
    fs::write(
        directory.join("selection.json"),
        serde_json::to_vec(&json!({
            "version":2,
            "repository":{"provider":"github","host":"github.com","path":"owner/repo"},
            "project_id":7,
            "branch":branch,
            "target":"main",
            "issues":[41],
            "intents":[{"title":"feat: fixture","body":"complete","labels":[],"issue":41,"write_started":true}],
            "request":null,
            "request_write_started":false,
            "request_intent":null
        }))
        .unwrap(),
    )
    .unwrap();
}

fn guard(root: &Path, stage: &str, input: &str) -> std::process::Output {
    let mut child = executable::command()
        .current_dir(root)
        .args(["guard", "--stage", stage])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

fn manage(root: &Path, action: &str) -> std::process::Output {
    executable::command()
        .current_dir(root)
        .arg("guard")
        .arg(action)
        .output()
        .unwrap()
}

#[test]
fn pre_commit_requires_a_checkpoint_only_when_tracked_changes_are_staged() {
    let temp = fixture();
    assert!(guard(temp.path(), "pre-commit", "").status.success());
    fs::write(temp.path().join("source.rs"), "change").unwrap();
    git(temp.path(), &["add", "source.rs"]);
    let denied = guard(temp.path(), "pre-commit", "");
    assert_eq!(denied.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&denied.stderr).contains("No Issue checkpoint"));
    checkpoint(temp.path(), "feature");
    assert!(guard(temp.path(), "pre-commit", "").status.success());
}

#[test]
fn pre_push_checks_each_branch_but_allows_deletions_and_tags() {
    let temp = fixture();
    checkpoint(temp.path(), "feature");
    let oid = "1111111111111111111111111111111111111111";
    let zero = "0000000000000000000000000000000000000000";
    assert!(
        guard(
            temp.path(),
            "pre-push",
            &format!("refs/heads/feature {oid} refs/heads/feature {zero}\n")
        )
        .status
        .success()
    );
    let denied = guard(
        temp.path(),
        "pre-push",
        &format!(
            "refs/heads/feature {oid} refs/heads/feature {zero}\nrefs/heads/other {oid} refs/heads/other {zero}\n"
        ),
    );
    assert_eq!(denied.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&denied.stderr).contains("refs/heads/other"));
    assert!(
        guard(
            temp.path(),
            "pre-push",
            &format!(
                "(delete) {zero} refs/heads/old {oid}\nrefs/tags/v1 {oid} refs/tags/v1 {zero}\n"
            )
        )
        .status
        .success()
    );
}

#[test]
fn pre_push_rejects_malformed_and_unmatched_mirror_refs() {
    let temp = fixture();
    checkpoint(temp.path(), "feature");
    assert_eq!(
        guard(temp.path(), "pre-push", "malformed\n").status.code(),
        Some(2)
    );
    let oid = "1111111111111111111111111111111111111111";
    let zero = "0000000000000000000000000000000000000000";
    let denied = guard(
        temp.path(),
        "pre-push",
        &format!("refs/remotes/origin/x {oid} refs/heads/x {zero}\n"),
    );
    assert_eq!(denied.status.code(), Some(1));
}

#[test]
fn install_refresh_and_uninstall_preserve_native_and_custom_shell_hooks() {
    for custom in [false, true] {
        let temp = fixture();
        let hooks = if custom {
            git(temp.path(), &["config", "core.hooksPath", ".custom-hooks"]);
            temp.path().join(".custom-hooks")
        } else {
            let output = Command::new("git")
                .current_dir(temp.path())
                .args(["rev-parse", "--path-format=absolute", "--git-path", "hooks"])
                .output()
                .unwrap();
            Path::new(std::str::from_utf8(&output.stdout).unwrap().trim()).to_owned()
        };
        fs::create_dir_all(&hooks).unwrap();
        let original = "#!/bin/sh\necho user-pre-push\n";
        fs::write(hooks.join("pre-push"), original).unwrap();
        assert!(manage(temp.path(), "--install").status.success());
        let installed = fs::read_to_string(hooks.join("pre-push")).unwrap();
        assert!(installed.find("specgit guard").unwrap() < installed.find("echo user").unwrap());
        let first = installed.clone();
        assert!(manage(temp.path(), "--install").status.success());
        assert_eq!(fs::read_to_string(hooks.join("pre-push")).unwrap(), first);
        assert!(manage(temp.path(), "--uninstall").status.success());
        assert_eq!(
            fs::read_to_string(hooks.join("pre-push")).unwrap(),
            original
        );
        assert!(!hooks.join("pre-commit").exists());
    }
}

#[test]
fn install_uses_husky_user_scripts_and_rejects_non_shell_hooks() {
    let temp = fixture();
    git(temp.path(), &["config", "core.hooksPath", ".husky/_"]);
    fs::create_dir_all(temp.path().join(".husky/_")).unwrap();
    fs::write(
        temp.path().join(".husky/pre-commit"),
        "#!/bin/sh\necho husky\n",
    )
    .unwrap();
    assert!(manage(temp.path(), "--install").status.success());
    assert!(
        fs::read_to_string(temp.path().join(".husky/pre-commit"))
            .unwrap()
            .contains("specgit guard --stage pre-commit")
    );
    assert!(!temp.path().join(".husky/_/pre-commit").exists());
    assert!(manage(temp.path(), "--uninstall").status.success());

    git(temp.path(), &["config", "core.hooksPath", ".python-hooks"]);
    fs::create_dir_all(temp.path().join(".python-hooks")).unwrap();
    fs::write(
        temp.path().join(".python-hooks/pre-commit"),
        "#!/usr/bin/env python3\nprint('keep')\n",
    )
    .unwrap();
    let denied = manage(temp.path(), "--install");
    assert_eq!(denied.status.code(), Some(1));
    assert_eq!(
        fs::read_to_string(temp.path().join(".python-hooks/pre-commit")).unwrap(),
        "#!/usr/bin/env python3\nprint('keep')\n"
    );
    assert!(!temp.path().join(".python-hooks/pre-push").exists());
}
