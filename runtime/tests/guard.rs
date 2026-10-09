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

#[test]
fn deletion_only_requires_a_checkpoint() {
    let temp = fixture();
    let root = temp.path();
    fs::write(root.join("tracked.txt"), "tracked").unwrap();
    git(root, &["add", "tracked.txt"]);
    git(root, &["commit", "-m", "tracked"]);
    git(root, &["rm", "tracked.txt"]);
    assert!(!guard(root, "pre-commit", "").status.success());
    checkpoint(root, "feature");
    assert!(guard(root, "pre-commit", "").status.success());
}
#[cfg(unix)]
#[test]
fn type_change_only_requires_a_checkpoint() {
    let temp = fixture();
    let root = temp.path();
    fs::write(root.join("tracked.txt"), "tracked").unwrap();
    git(root, &["add", "tracked.txt"]);
    git(root, &["commit", "-m", "tracked"]);
    fs::remove_file(root.join("tracked.txt")).unwrap();
    std::os::unix::fs::symlink("target.txt", root.join("tracked.txt")).unwrap();
    git(root, &["add", "tracked.txt"]);
    assert!(!guard(root, "pre-commit", "").status.success());
    checkpoint(root, "feature");
    assert!(guard(root, "pre-commit", "").status.success());
}

/// Git with the tested `specgit` first on PATH, so installed hook blocks run it.
#[cfg(unix)]
fn hooked_git(root: &Path, args: &[&str]) -> std::process::Output {
    let mut paths = vec![
        executable::binary()
            .canonicalize()
            .unwrap()
            .parent()
            .unwrap()
            .to_owned(),
    ];
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    Command::new("git")
        .current_dir(root)
        .env("PATH", std::env::join_paths(paths).unwrap())
        .args(args)
        .output()
        .unwrap()
}

const OID: &str = "1111111111111111111111111111111111111111";
const ZERO: &str = "0000000000000000000000000000000000000000";

#[test]
fn installed_guard_fails_closed_when_an_initialized_declaration_is_lost() {
    let temp = fixture();
    let root = temp.path().canonicalize().unwrap();
    checkpoint(&root, "feature");
    assert!(manage(&root, "--install").status.success());
    fs::write(root.join("kept.txt"), "kept").unwrap();
    git(&root, &["add", "kept.txt"]);
    assert!(guard(&root, "pre-commit", "").status.success());
    git(&root, &["commit", "--no-verify", "-m", "kept"]);

    // A pulled commit that untracked the declaration deletes it here; the
    // checkpoint and guard receipt remain.
    fs::remove_file(root.join(".specgit.yaml")).unwrap();
    fs::write(root.join("source.rs"), "change").unwrap();
    git(&root, &["add", "source.rs"]);
    let denied = guard(&root, "pre-commit", "");
    assert_eq!(denied.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&denied.stderr);
    assert!(stderr.contains("no .specgit.yaml"), "{stderr}");
    assert!(stderr.contains("selection.json"), "{stderr}");
    assert!(stderr.contains("specgit init"), "{stderr}");
    let pushed = format!("refs/heads/feature {OID} refs/heads/feature {ZERO}\n");
    let denied = guard(&root, "pre-push", &pushed);
    assert_eq!(denied.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&denied.stderr).contains("private state"));
    // Ref updates outside the checkpoint rule keep their existing behavior.
    assert!(
        guard(
            &root,
            "pre-push",
            &format!("refs/tags/v1 {OID} refs/tags/v1 {ZERO}\n")
        )
        .status
        .success()
    );

    #[cfg(unix)]
    {
        let commit = hooked_git(&root, &["commit", "-m", "blocked"]);
        assert!(!commit.status.success());
        assert!(String::from_utf8_lossy(&commit.stderr).contains("private state"));
        let remote = tempfile::tempdir().unwrap();
        git(remote.path(), &["init", "--bare", "-q"]);
        git(
            &root,
            &["remote", "add", "local", remote.path().to_str().unwrap()],
        );
        let push = hooked_git(&root, &["push", "-q", "local", "feature"]);
        assert!(!push.status.success());
        assert!(String::from_utf8_lossy(&push.stderr).contains("private state"));
    }
}

#[test]
fn never_initialized_repositories_with_installed_hooks_are_unaffected() {
    let temp = fixture();
    let root = temp.path().canonicalize().unwrap();
    fs::remove_file(root.join(".specgit.yaml")).unwrap();
    // A lone guard receipt does not prove initialization.
    assert!(manage(&root, "--install").status.success());
    fs::write(root.join("source.rs"), "change").unwrap();
    git(&root, &["add", "source.rs"]);
    assert!(guard(&root, "pre-commit", "").status.success());
    assert!(
        guard(
            &root,
            "pre-push",
            &format!("refs/heads/feature {OID} refs/heads/feature {ZERO}\n")
        )
        .status
        .success()
    );
    #[cfg(unix)]
    assert!(
        hooked_git(&root, &["commit", "-m", "plain"])
            .status
            .success()
    );
}

fn hook_path(root: &Path, stage: &str) -> std::path::PathBuf {
    let output = Command::new("git")
        .current_dir(root)
        .args([
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            &format!("hooks/{stage}"),
        ])
        .output()
        .unwrap();
    Path::new(std::str::from_utf8(&output.stdout).unwrap().trim()).to_owned()
}

#[test]
fn shared_hooks_stay_installed_for_sibling_worktrees_and_name_their_owner() {
    let temp = fixture();
    let root = temp.path().canonicalize().unwrap();
    // Resolve the sibling from cwd; Windows verbatim paths are not Git arguments.
    let parent = tempfile::tempdir_in(root.parent().unwrap()).unwrap();
    let name = format!(
        "../{}/linked",
        parent.path().file_name().unwrap().to_str().unwrap()
    );
    git(&root, &["worktree", "add", "-b", "linked", &name]);
    let sibling = parent.path().join("linked").canonicalize().unwrap();
    fs::write(
        sibling.join(".specgit.yaml"),
        "version: 2\nremote: origin\ntarget: main\n",
    )
    .unwrap();

    assert!(manage(&root, "--install").status.success());
    let hooks: Vec<_> = ["pre-commit", "pre-push"]
        .iter()
        .map(|stage| hook_path(&root, stage))
        .collect();
    assert_eq!(hooks[0], hook_path(&sibling, "pre-commit"));
    let installed: Vec<_> = hooks.iter().map(|h| fs::read(h).unwrap()).collect();

    // The sibling sees the owner's shared hooks and gets an actionable diagnostic.
    let denied = manage(&sibling, "--install");
    assert_eq!(denied.status.code(), Some(3));
    let stderr = String::from_utf8_lossy(&denied.stderr);
    // Git reports worktree paths with forward slashes; canonical Windows paths are verbatim.
    let comparable = |text: &str| {
        let text = text.replace('\\', "/");
        text.strip_prefix("//?/").map(str::to_owned).unwrap_or(text)
    };
    assert!(
        comparable(&stderr).contains(&comparable(&root.display().to_string())),
        "{stderr}"
    );
    assert!(stderr.contains("owns it"), "{stderr}");
    assert!(!stderr.contains("unowned"), "{stderr}");

    // Uninstall in the owner keeps the blocks the initialized sibling relies on.
    let kept = manage(&root, "--uninstall");
    assert!(kept.status.success(), "{kept:?}");
    let report: serde_json::Value = serde_json::from_slice(&kept.stdout).unwrap();
    assert_eq!(report["installed"], true);
    assert_eq!(report["retained"]["reason"], "shared_initialized_worktree");
    assert_eq!(
        Path::new(
            report["retained"]["shared_consumers"][0]["root"]
                .as_str()
                .unwrap()
        )
        .canonicalize()
        .unwrap(),
        sibling
    );
    for (hook, before) in hooks.iter().zip(&installed) {
        assert_eq!(&fs::read(hook).unwrap(), before);
    }

    // Once the sibling no longer relies on SpecGit, uninstall proceeds as before.
    fs::remove_file(sibling.join(".specgit.yaml")).unwrap();
    let removed = manage(&root, "--uninstall");
    assert!(removed.status.success(), "{removed:?}");
    let report: serde_json::Value = serde_json::from_slice(&removed.stdout).unwrap();
    assert_eq!(report["installed"], false);
    assert!(hooks.iter().all(|hook| !hook.exists()));
}
