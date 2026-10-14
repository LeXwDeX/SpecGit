#[path = "support/executable.rs"]
mod executable;
use serde_json::json;
use std::{
    fs,
    io::Write,
    path::Path,
    process::{Command, Stdio},
};

#[tokio::test]
async fn guard_health_requires_receipt_and_live_executable_hooks() {
    let temp = fixture();
    let root = temp.path();
    let process = specgit::process::Process::default();
    assert!(
        specgit::guard::health_plan(&process, root)
            .await
            .unwrap()
            .is_none()
    );
    assert!(manage(root, "--install").status.success());
    let current = specgit::guard::health_plan(&process, root)
        .await
        .unwrap()
        .unwrap();
    assert!(current.assets().is_empty());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let hook = root.join(".git/hooks/pre-commit");
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(specgit::guard::health_plan(&process, root).await.is_err());
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    git(root, &["config", "core.hooksPath", ".alternate-hooks"]);
    assert!(specgit::guard::health_plan(&process, root).await.is_err());
}

#[tokio::test]
async fn guard_health_refresh_rechecks_the_hook_after_preview() {
    let temp = fixture();
    let root = temp.path().canonicalize().unwrap();
    let process = specgit::process::Process::default();
    assert!(manage(&root, "--install").status.success());
    let receipt_path = root.join(".git/specgit-v2/guard-hooks.json");
    let hook_path = root.join(".git/hooks/pre-commit");
    let mut receipt: serde_json::Value =
        serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
    let old = receipt["hooks"]["pre-commit"]["block"]
        .as_str()
        .unwrap()
        .to_owned();
    let legacy = old.replace(
        "# <<< specgit-v2:pre-commit:end <<<",
        "# legacy generated line\n# <<< specgit-v2:pre-commit:end <<<",
    );
    receipt["hooks"]["pre-commit"]["block"] = legacy.clone().into();
    fs::write(&receipt_path, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
    fs::write(
        &hook_path,
        fs::read_to_string(&hook_path)
            .unwrap()
            .replace(&old, &legacy),
    )
    .unwrap();
    let declaration_path = root.join(".specgit.yaml");
    let declaration_before = specgit::assets::Snapshot::read(&declaration_path).unwrap();
    let mut preview = specgit::guard::health_plan(&process, &root)
        .await
        .unwrap()
        .unwrap();
    preview.depend_on_snapshot(&declaration_path, &declaration_before);
    assert!(!preview.assets().is_empty());
    let concurrent = format!("{}# user edit\n", fs::read_to_string(&hook_path).unwrap());
    fs::write(&hook_path, &concurrent).unwrap();
    assert!(preview.apply(&process).await.is_err());
    assert_eq!(fs::read_to_string(&hook_path).unwrap(), concurrent);
    let mut stale = specgit::guard::health_plan(&process, &root)
        .await
        .unwrap()
        .unwrap();
    stale.depend_on_snapshot(&declaration_path, &declaration_before);
    fs::write(
        &declaration_path,
        "version: 2\nremote: origin\ntarget: main\n# changed\n",
    )
    .unwrap();
    assert!(stale.apply(&process).await.is_err());
    fs::write(&declaration_path, declaration_before.bytes.unwrap()).unwrap();
    let fresh = specgit::guard::health_plan(&process, &root)
        .await
        .unwrap()
        .unwrap();
    fresh.apply(&process).await.unwrap();
    let refreshed = fs::read_to_string(&hook_path).unwrap();
    assert!(!refreshed.contains("# legacy generated line"));
    assert!(refreshed.ends_with("# user edit\n"));
}

#[tokio::test]
async fn guard_health_stops_shared_hook_refresh_for_a_sibling_consumer() {
    let temp = fixture();
    let root = temp.path().canonicalize().unwrap();
    let parent = tempfile::tempdir_in(root.parent().unwrap()).unwrap();
    let name = format!(
        "../{}/linked",
        parent.path().file_name().unwrap().to_str().unwrap()
    );
    git(&root, &["worktree", "add", "-b", "linked", &name]);
    let sibling = parent.path().join("linked");
    fs::write(
        sibling.join(".specgit.yaml"),
        "version: 2\nremote: origin\ntarget: main\n",
    )
    .unwrap();
    assert!(manage(&root, "--install").status.success());
    assert!(
        specgit::guard::health_plan(&specgit::process::Process::default(), &sibling)
            .await
            .unwrap()
            .is_none()
    );
    let receipt_path = root.join(".git/specgit-v2/guard-hooks.json");
    let hook_path = root.join(".git/hooks/pre-commit");
    let mut receipt: serde_json::Value =
        serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
    let old = receipt["hooks"]["pre-commit"]["block"]
        .as_str()
        .unwrap()
        .to_owned();
    let legacy = old.replace(
        "# <<< specgit-v2:pre-commit:end <<<",
        "# legacy generated line\n# <<< specgit-v2:pre-commit:end <<<",
    );
    receipt["hooks"]["pre-commit"]["block"] = legacy.clone().into();
    fs::write(&receipt_path, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
    fs::write(
        &hook_path,
        fs::read_to_string(&hook_path)
            .unwrap()
            .replace(&old, &legacy),
    )
    .unwrap();
    assert!(
        specgit::guard::health_plan(&specgit::process::Process::default(), &root)
            .await
            .is_err()
    );
    assert!(
        fs::read_to_string(&hook_path)
            .unwrap()
            .contains("# legacy generated line")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn guard_health_preserves_a_repository_path_ending_in_newline() {
    let temp = fixture();
    let original = temp.path().canonicalize().unwrap();
    let renamed = original.with_file_name(format!(
        "{}-newline\n",
        original.file_name().unwrap().to_string_lossy()
    ));
    fs::rename(&original, &renamed).unwrap();
    let process = specgit::process::Process::default();
    assert!(
        specgit::guard::health_plan(&process, &renamed)
            .await
            .unwrap()
            .is_none()
    );
    let installed = manage(&renamed, "--install");
    assert!(installed.status.success(), "{installed:?}");
    let health = specgit::guard::health_plan(&process, &renamed)
        .await
        .unwrap()
        .unwrap();
    assert!(health.assets().is_empty());
    fs::rename(&renamed, &original).unwrap();
}

#[cfg(feature = "test-fixtures")]
#[tokio::test]
async fn guard_health_reports_crashed_transactions_before_declaring_current_or_absent() {
    for crash_point in ["before-write:0", "before-commit"] {
        let temp = fixture();
        let root = temp.path().canonicalize().unwrap();
        // Fault injection belongs to the fixture build, even when the public
        // entrypoint regressions target a separately installed production binary.
        let crashed = Command::new(env!("CARGO_BIN_EXE_specgit"))
            .current_dir(&root)
            .args(["guard", "--install"])
            .env("SPECGIT_FIXTURE_ASSET_CRASH", crash_point)
            .output()
            .unwrap();
        assert_eq!(crashed.status.code(), Some(99), "{crashed:?}");
        let private = root.join(".git/specgit-v2");
        let receipt = private.join("guard-hooks.json");
        let before = fs::read(&receipt).ok();
        let journal_root = private.join("transactions/transactions");
        let id = fs::read_dir(&journal_root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .find(|name| name.starts_with("tx-"))
            .unwrap();
        let error = specgit::guard::health_plan(&specgit::process::Process::default(), &root)
            .await
            .err()
            .unwrap();
        assert_eq!(error.code, specgit::diagnostic::Code::RollbackConflict);
        assert!(error.message.contains(&id));
        assert_eq!(fs::read(&receipt).ok(), before);
        let hooks = specgit::config::worktree::hooks(&specgit::process::Process::default(), &root)
            .await
            .unwrap();
        let store = specgit::assets::AssetStore::lock(
            &private.join("transactions"),
            &[hooks, private.clone()],
            std::time::Duration::from_secs(2),
        )
        .unwrap();
        store.rollback(&id).unwrap();
        assert!(
            specgit::guard::health_plan(&specgit::process::Process::default(), &root)
                .await
                .unwrap()
                .is_none()
        );
    }
}

#[tokio::test]
async fn guard_health_reports_orphan_markers_without_taking_ownership() {
    let temp = fixture();
    let root = temp.path().canonicalize().unwrap();
    assert!(manage(&root, "--install").status.success());
    let receipt = root.join(".git/specgit-v2/guard-hooks.json");
    let hook = root.join(".git/hooks/pre-commit");
    let before = fs::read(&hook).unwrap();
    fs::remove_file(receipt).unwrap();
    let error = specgit::guard::health_plan(&specgit::process::Process::default(), &root)
        .await
        .err()
        .unwrap();
    assert_eq!(error.code, specgit::diagnostic::Code::OwnershipConflict);
    assert_eq!(fs::read(&hook).unwrap(), before);
}

#[tokio::test]
async fn guard_health_reads_external_effective_hooks_without_writing() {
    let temp = fixture();
    let root = temp.path().canonicalize().unwrap();
    let external_dir = tempfile::tempdir().unwrap();
    let external = external_dir.path().canonicalize().unwrap();
    fs::write(
        external.join("pre-commit"),
        b"#!/bin/sh\n# >>> specgit-v2:pre-commit:start >>>\n",
    )
    .unwrap();
    git(
        &root,
        &["config", "core.hooksPath", external.to_str().unwrap()],
    );
    let before = fs::read(external.join("pre-commit")).unwrap();
    let error = specgit::guard::health_plan(&specgit::process::Process::default(), &root)
        .await
        .err()
        .unwrap();
    assert_eq!(error.code, specgit::diagnostic::Code::OwnershipConflict);
    assert_eq!(fs::read(external.join("pre-commit")).unwrap(), before);
}

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
