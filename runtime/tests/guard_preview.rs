#[path = "support/executable.rs"]
mod executable;
use specgit::diagnostic::{Code, Diagnostic};
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

const REPOSITORY_OVERRIDES: [&str; 3] = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"];

fn git(root: &Path, args: &[&str]) {
    let output = Command::new("git")
        .current_dir(root)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_COMMON_DIR")
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success(), "{args:?}: {output:?}");
}

fn repository(root: &Path, declaration: bool) {
    fs::create_dir_all(root).unwrap();
    for args in [
        vec!["init", "-q", "-b", "feature"],
        vec![
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "fixture",
        ],
        vec![
            "remote",
            "add",
            "origin",
            "https://github.com/owner/repo.git",
        ],
    ] {
        git(root, &args);
    }
    if declaration {
        fs::write(
            root.join(".specgit.yaml"),
            "version: 2\nremote: origin\ntarget: main\n",
        )
        .unwrap();
    }
}

fn repositories(declaration: bool) -> (tempfile::TempDir, PathBuf, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let a = base.join("repoA");
    let b = base.join("repoB");
    repository(&a, declaration);
    repository(&b, declaration);
    (temp, a, b)
}

fn inventory(root: &Path) -> Vec<(PathBuf, Option<Vec<u8>>, u32)> {
    fn visit(root: &Path, directory: &Path, entries: &mut Vec<(PathBuf, Option<Vec<u8>>, u32)>) {
        let mut paths: Vec<_> = fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        paths.sort();
        for path in paths {
            let relative = path.strip_prefix(root).unwrap().to_path_buf();
            let metadata = fs::symlink_metadata(&path).unwrap();
            #[cfg(unix)]
            let mode = {
                use std::os::unix::fs::PermissionsExt;
                metadata.permissions().mode()
            };
            #[cfg(not(unix))]
            let mode = u32::from(metadata.permissions().readonly());
            if metadata.is_dir() {
                entries.push((relative, None, mode));
                visit(root, &path, entries);
            } else {
                entries.push((relative, Some(fs::read(&path).unwrap()), mode));
            }
        }
    }
    let mut entries = vec![];
    visit(root, root, &mut entries);
    entries
}

fn override_value(variable: &str, b: &Path) -> OsString {
    match variable {
        "GIT_DIR" | "GIT_COMMON_DIR" => b.join(".git").into_os_string(),
        "GIT_WORK_TREE" => b.as_os_str().to_owned(),
        _ => panic!("unexpected repository override {variable}"),
    }
}

fn assert_environment_error(error: &Diagnostic, variable: &str) {
    assert_eq!(error.code, Code::InvalidInput, "{variable}: {error}");
    assert!(
        error
            .message
            .contains("GIT_DIR, GIT_WORK_TREE or GIT_COMMON_DIR overrides"),
        "{variable}: {error}"
    );
    assert!(
        error.remedy.contains("repository-location overrides"),
        "{variable}: {error}"
    );
}

fn command_clean(root: &Path, args: &[&str]) -> Command {
    let mut command = executable::command();
    command
        .current_dir(root)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_COMMON_DIR")
        .args(args);
    command
}

fn install_guard(root: &Path) {
    let output = command_clean(root, &["guard", "--install", "--json"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
}

fn doctor(root: &Path, fix: bool) -> Output {
    let mut args = vec!["doctor", "--offline", "--json"];
    if fix {
        args.insert(2, "--fix");
    }
    command_clean(root, &args).output().unwrap()
}

fn expose_guard_repair(root: &Path) {
    let receipt_path = root.join(".git/specgit-v2/guard-hooks.json");
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
    let hook_path = root.join(".git/hooks/pre-commit");
    let hook = fs::read_to_string(&hook_path).unwrap();
    fs::write(&hook_path, hook.replace(&old, &legacy)).unwrap();
}
#[tokio::test]
async fn install_preview_never_creates_hooks_or_private_state() {
    let temp = tempfile::tempdir().unwrap();
    assert!(
        Command::new("git")
            .current_dir(temp.path())
            .args(["init", "-b", "feature"])
            .output()
            .unwrap()
            .status
            .success()
    );
    let process = specgit::process::Process::default();
    let result = specgit::guard::preview_with_executable(
        &process,
        temp.path(),
        false,
        &executable::binary(),
    )
    .await
    .unwrap();
    assert_eq!(result["dry_run"], true);
    assert_eq!(result["prepared"], true);
    assert!(result.get("installed").is_none());
    assert!(!temp.path().join(".git/hooks/pre-commit").exists());
    assert!(!temp.path().join(".git/specgit-v2").exists());
    let hook = temp.path().join(".git/hooks/pre-commit");
    fs::write(&hook, "#!/bin/sh\necho user\n").unwrap();
    specgit::guard::preview_with_executable(&process, temp.path(), false, &executable::binary())
        .await
        .unwrap();
    assert_eq!(fs::read_to_string(&hook).unwrap(), "#!/bin/sh\necho user\n");
    fs::write(&hook, "#!/usr/bin/python3\nprint(1)\n").unwrap();
    assert!(
        specgit::guard::preview_with_executable(
            &process,
            temp.path(),
            false,
            &executable::binary()
        )
        .await
        .is_err()
    );
    assert_eq!(
        fs::read_to_string(hook).unwrap(),
        "#!/usr/bin/python3\nprint(1)\n"
    );
}

#[tokio::test]
async fn uninstall_preview_keeps_hooks_receipt_and_transaction_inventory() {
    let temp = tempfile::tempdir().unwrap();
    assert!(
        Command::new("git")
            .current_dir(temp.path())
            .args(["init", "-b", "feature"])
            .output()
            .unwrap()
            .status
            .success()
    );
    let process = specgit::process::Process::default();
    specgit::guard::install_with_executable(&process, temp.path(), false, &executable::binary())
        .await
        .unwrap();
    let paths = [
        ".git/hooks/pre-commit",
        ".git/hooks/pre-push",
        ".git/specgit-v2/guard-hooks.json",
    ];
    let before: Vec<_> = paths
        .iter()
        .map(|p| fs::read(temp.path().join(p)).unwrap())
        .collect();
    let journal = temp.path().join(".git/specgit-v2/assets");
    let entries = fs::read_dir(&journal).unwrap().count();
    let result =
        specgit::guard::preview_with_executable(&process, temp.path(), true, &executable::binary())
            .await
            .unwrap();
    assert_eq!(result["changes"].as_array().unwrap().len(), 3);
    for (path, before) in paths.iter().zip(before) {
        assert_eq!(fs::read(temp.path().join(path)).unwrap(), before);
    }
    assert_eq!(fs::read_dir(journal).unwrap().count(), entries);
}

#[tokio::test]
async fn uninstall_preview_reports_initialized_shared_consumers() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    for args in [
        vec!["init", "-b", "feature"],
        vec!["config", "user.name", "Fixture"],
        vec!["config", "user.email", "fixture@example.invalid"],
        vec!["commit", "--allow-empty", "-m", "fixture"],
    ] {
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
    let sibling_parent = tempfile::tempdir_in(root.parent().unwrap()).unwrap();
    let name = format!(
        "../{}/linked",
        sibling_parent.path().file_name().unwrap().to_str().unwrap()
    );
    assert!(
        Command::new("git")
            .current_dir(root)
            .args(["worktree", "add", "-b", "linked", &name])
            .output()
            .unwrap()
            .status
            .success()
    );
    fs::write(
        sibling_parent.path().join("linked/.specgit.yaml"),
        "version: 2\nremote: origin\ntarget: main\n",
    )
    .unwrap();
    let process = specgit::process::Process::default();
    specgit::guard::install_with_executable(&process, root, false, &executable::binary())
        .await
        .unwrap();
    let hook = root.join(".git/hooks/pre-commit");
    let before = fs::read(&hook).unwrap();
    let receipt = root.join(".git/specgit-v2/guard-hooks.json");
    let receipt_before = fs::read(&receipt).unwrap();
    let result =
        specgit::guard::preview_with_executable(&process, root, true, &executable::binary())
            .await
            .unwrap();
    assert_eq!(result["retained"]["reason"], "shared_initialized_worktree");
    assert_eq!(
        result["retained"]["shared_consumers"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(result["changes"].as_array().unwrap().is_empty());
    assert_eq!(fs::read(hook).unwrap(), before);
    assert_eq!(fs::read(receipt).unwrap(), receipt_before);
}

fn git_inventory(root: &std::path::Path) -> Vec<(std::path::PathBuf, Option<Vec<u8>>)> {
    fn visit(root: &std::path::Path, entries: &mut Vec<(std::path::PathBuf, Option<Vec<u8>>)>) {
        for entry in fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                entries.push((path.clone(), None));
                visit(&path, entries);
            } else {
                entries.push((path.clone(), Some(fs::read(&path).unwrap())));
            }
        }
    }
    let mut entries = vec![];
    visit(root, &mut entries);
    entries.sort();
    entries
}

#[test]
fn cli_install_and_uninstall_previews_preserve_git_assets() {
    let temp = tempfile::tempdir().unwrap();
    assert!(
        Command::new("git")
            .current_dir(temp.path())
            .args(["init", "-b", "feature"])
            .output()
            .unwrap()
            .status
            .success()
    );
    let git_dir = temp.path().join(".git");
    let before = git_inventory(&git_dir);
    let preview = executable::command()
        .current_dir(temp.path())
        .args(["guard", "--install", "--dry-run", "--json"])
        .output()
        .unwrap();
    assert!(preview.status.success(), "{preview:?}");
    let report: serde_json::Value = serde_json::from_slice(&preview.stdout).unwrap();
    assert_eq!(report["dry_run"], true);
    assert_eq!(report["prepared"], true);
    assert_eq!(git_inventory(&git_dir), before);
    assert!(!git_dir.join("hooks/pre-commit").exists());
    assert!(!git_dir.join("hooks/pre-push").exists());
    assert!(!git_dir.join("specgit-v2").exists());

    let installed = executable::command()
        .current_dir(temp.path())
        .args(["guard", "--install", "--json"])
        .output()
        .unwrap();
    assert!(installed.status.success(), "{installed:?}");
    assert!(git_dir.join("hooks/pre-commit").is_file());
    assert!(git_dir.join("hooks/pre-push").is_file());
    let installed_assets = git_inventory(&git_dir);
    let uninstall = executable::command()
        .current_dir(temp.path())
        .args(["guard", "--uninstall", "--dry-run", "--json"])
        .output()
        .unwrap();
    assert!(uninstall.status.success(), "{uninstall:?}");
    let report: serde_json::Value = serde_json::from_slice(&uninstall.stdout).unwrap();
    assert_eq!(report["dry_run"], true);
    assert_eq!(git_inventory(&git_dir), installed_assets);
}

#[test]
fn cli_guard_dry_run_requires_an_install_action_and_rejects_stage() {
    let temp = tempfile::tempdir().unwrap();
    for args in [
        vec!["guard", "--dry-run", "--json"],
        vec!["guard", "--stage", "pre-commit", "--dry-run", "--json"],
        vec![
            "guard",
            "--install",
            "--stage",
            "pre-push",
            "--dry-run",
            "--json",
        ],
    ] {
        let output = executable::command()
            .current_dir(temp.path())
            .args(&args)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2), "{args:?}: {output:?}");
        assert!(
            !output.stderr.is_empty() || !output.stdout.is_empty(),
            "{args:?}"
        );
    }
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
}

#[test]
fn cli_setup_guard_transfer_and_retained_previews_preserve_the_project_tree() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    assert!(
        Command::new("git")
            .current_dir(root)
            .args(["init", "-b", "feature"])
            .output()
            .unwrap()
            .status
            .success()
    );
    let setup = executable::command()
        .current_dir(root)
        .args(["setup", "--hook-purpose", "guard", "--json"])
        .output()
        .unwrap();
    assert!(setup.status.success(), "{setup:?}");
    let setup_receipt = root.join(".git/specgit-v2/setup-guard-hooks.json");
    let independent_receipt = root.join(".git/specgit-v2/guard-hooks.json");
    assert!(setup_receipt.is_file());
    assert!(!independent_receipt.exists());
    let before_transfer = git_inventory(root);
    let preview = executable::command()
        .current_dir(root)
        .args(["guard", "--install", "--dry-run", "--json"])
        .output()
        .unwrap();
    assert!(preview.status.success(), "{preview:?}");
    let report: serde_json::Value = serde_json::from_slice(&preview.stdout).unwrap();
    assert_eq!(report["dry_run"], true);
    assert_eq!(report["prepared"], true);
    let changes = report["changes"].as_array().unwrap();
    for (path, operation) in [(&setup_receipt, "remove"), (&independent_receipt, "create")] {
        assert!(
            changes.iter().any(|change| {
                change["path"].as_str().is_some_and(|value| {
                    let planned = std::path::Path::new(value);
                    planned.file_name() == path.file_name()
                        && planned.parent().unwrap().canonicalize().unwrap()
                            == path.parent().unwrap().canonicalize().unwrap()
                }) && change["operation"] == operation
            }),
            "{report}"
        );
    }
    assert_eq!(git_inventory(root), before_transfer);

    let transfer = executable::command()
        .current_dir(root)
        .args(["guard", "--install", "--json"])
        .output()
        .unwrap();
    assert!(transfer.status.success(), "{transfer:?}");
    assert!(independent_receipt.is_file());
    assert!(!setup_receipt.exists());
    let before_uninstall = git_inventory(root);
    let uninstall = executable::command()
        .current_dir(root)
        .args(["guard", "--uninstall", "--dry-run", "--json"])
        .output()
        .unwrap();
    assert!(uninstall.status.success(), "{uninstall:?}");
    let report: serde_json::Value = serde_json::from_slice(&uninstall.stdout).unwrap();
    assert_eq!(report["dry_run"], true);
    assert_eq!(report["retained"]["reason"], "setup_guard_purpose");
    assert!(report["changes"].as_array().unwrap().is_empty());
    assert_eq!(git_inventory(root), before_uninstall);
}

#[test]
fn transferred_guard_rejects_incomplete_setup_demand_without_writes() {
    for field in [
        "purposes",
        "agents",
        "skills",
        "instructions",
        "hooks",
        "generation",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        assert!(
            Command::new("git")
                .current_dir(root)
                .args(["init", "-b", "feature"])
                .output()
                .unwrap()
                .status
                .success()
        );
        for args in [
            vec!["setup", "--hook-purpose", "guard", "--json"],
            vec!["guard", "--install", "--json"],
        ] {
            let result = executable::command()
                .current_dir(root)
                .args(args)
                .output()
                .unwrap();
            assert!(result.status.success(), "{result:?}");
        }
        let receipt = root.join(".git/specgit-v2/agent-assets/ownership.json");
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&receipt).unwrap()).unwrap();
        value.as_object_mut().unwrap().remove(field);
        fs::write(&receipt, serde_json::to_vec(&value).unwrap()).unwrap();
        let before = git_inventory(root);
        for preview in [true, false] {
            let mut command = executable::command();
            command
                .current_dir(root)
                .args(["guard", "--uninstall", "--json"]);
            if preview {
                command.arg("--dry-run");
            }
            let result = command.output().unwrap();
            assert!(
                !result.status.success(),
                "missing {field}, preview={preview}: {result:?}"
            );
            assert_eq!(git_inventory(root), before, "missing {field}");
        }
    }
}

#[tokio::test]
async fn explicit_guard_executable_must_exist_and_be_executable_before_installation() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    assert!(
        Command::new("git")
            .current_dir(&root)
            .args(["init", "-b", "feature"])
            .output()
            .unwrap()
            .status
            .success()
    );
    let process = specgit::process::Process::default();
    for source in [
        root.join("missing"),
        root.clone(),
        std::path::PathBuf::from("relative-cli"),
    ] {
        assert!(
            specgit::guard::preview_with_executable(&process, &root, false, &source)
                .await
                .is_err(),
            "{}",
            source.display()
        );
        assert!(!root.join(".git/hooks/pre-commit").exists());
        assert!(!root.join(".git/specgit-v2").exists());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let source = root.join("non-executable");
        fs::write(&source, "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(
            specgit::guard::preview_with_executable(&process, &root, false, &source)
                .await
                .is_err()
        );
        assert!(!root.join(".git/hooks/pre-commit").exists());
    }
}

#[test]
fn cli_guard_management_rejects_repository_location_overrides_without_writes() {
    for (operation, arguments) in [
        ("install", vec!["guard", "--install", "--json"]),
        ("uninstall", vec!["guard", "--uninstall", "--json"]),
        (
            "install_preview",
            vec!["guard", "--install", "--dry-run", "--json"],
        ),
        (
            "uninstall_preview",
            vec!["guard", "--uninstall", "--dry-run", "--json"],
        ),
    ] {
        for variable in REPOSITORY_OVERRIDES {
            let (_temp, a, b) = repositories(false);
            if operation == "uninstall" || operation == "uninstall_preview" {
                install_guard(&b);
            }
            let before = (inventory(&a), inventory(&b));
            let output = command_clean(&a, &arguments)
                .env(variable, override_value(variable, &b))
                .output()
                .unwrap();
            assert_eq!(output.status.code(), Some(2), "{variable} {operation}");
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(
                stderr.contains("GIT_DIR, GIT_WORK_TREE or GIT_COMMON_DIR overrides"),
                "{variable} {operation}: {stderr}"
            );
            assert!(
                stderr.contains("repository-location overrides"),
                "{variable} {operation}: {stderr}"
            );
            assert_eq!(inventory(&a), before.0, "{variable} {operation}: repoA");
            assert_eq!(inventory(&b), before.1, "{variable} {operation}: repoB");
        }
    }
}

#[test]
fn cli_doctor_repair_rejects_repository_location_overrides_without_writes() {
    for variable in REPOSITORY_OVERRIDES {
        let (_temp, a, b) = repositories(true);
        install_guard(&b);
        expose_guard_repair(&b);
        let control = doctor(&b, false);
        assert!(control.status.success(), "{control:?}");
        let control: serde_json::Value = serde_json::from_slice(&control.stdout).unwrap();
        assert!(
            control["evidence"]["health"]["checks"]
                .as_array()
                .unwrap()
                .iter()
                .any(|check| check["id"] == "guard"
                    && check["status"] == "change_required"
                    && check["repairable"] == true),
            "{variable}: {control}"
        );
        let before = (inventory(&a), inventory(&b));
        let output = command_clean(&a, &["doctor", "--offline", "--fix", "--json"])
            .env(variable, override_value(variable, &b))
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2), "{variable}");
        let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["ok"], false, "{variable}: {report}");
        assert_eq!(report["exit"], 2, "{variable}: {report}");
        assert!(
            report["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|error| {
                    error["code"] == "invalid_input"
                        && error["message"]
                            .as_str()
                            .unwrap()
                            .contains("GIT_DIR, GIT_WORK_TREE or GIT_COMMON_DIR overrides")
                }),
            "{variable}: {report}"
        );
        assert!(
            report["evidence"]["repair"]["results"]
                .as_array()
                .unwrap()
                .is_empty(),
            "{variable}: {report}"
        );
        assert_eq!(inventory(&a), before.0, "{variable}: repoA");
        assert_eq!(inventory(&b), before.1, "{variable}: repoB");
    }
}

#[tokio::test]
async fn library_guard_entries_reject_process_environment_overrides_before_writes() {
    let (_temp, a, b) = repositories(false);
    let source = executable::binary();
    let before = (inventory(&a), inventory(&b));
    for variable in REPOSITORY_OVERRIDES {
        let mut process = specgit::process::Process::default();
        process
            .environment
            .insert(OsString::from(variable), override_value(variable, &b));
        let errors = [
            specgit::guard::preview_with_executable(&process, &a, false, &source)
                .await
                .unwrap_err(),
            specgit::guard::install_with_executable(&process, &a, false, &source)
                .await
                .unwrap_err(),
            specgit::guard::install_with_executable(&process, &a, true, &source)
                .await
                .unwrap_err(),
            specgit::guard::health_plan(&process, &a)
                .await
                .err()
                .unwrap(),
        ];
        for error in errors {
            assert_environment_error(&error, variable);
        }
        assert_eq!(inventory(&a), before.0, "{variable}: repoA");
        assert_eq!(inventory(&b), before.1, "{variable}: repoB");
    }
}

#[cfg(windows)]
#[tokio::test]
async fn windows_library_guard_rejects_case_insensitive_repository_environment() {
    let (_temp, a, b) = repositories(false);
    let source = executable::binary();
    let before = (inventory(&a), inventory(&b));
    for (key, variable) in [
        ("git_dir", "GIT_DIR"),
        ("Git_Work_Tree", "GIT_WORK_TREE"),
        ("git_common_dir", "GIT_COMMON_DIR"),
    ] {
        let mut process = specgit::process::Process::default();
        process
            .environment
            .insert(OsString::from(key), override_value(variable, &b));
        for error in [
            specgit::guard::install_with_executable(&process, &a, false, &source)
                .await
                .unwrap_err(),
            specgit::guard::health_plan(&process, &a)
                .await
                .err()
                .unwrap(),
        ] {
            assert_environment_error(&error, key);
        }
        assert_eq!(inventory(&a), before.0, "{key}: repoA");
        assert_eq!(inventory(&b), before.1, "{key}: repoB");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn unix_library_guard_keeps_repository_environment_names_case_sensitive() {
    let (_temp, a, b) = repositories(false);
    let source = executable::binary();
    let before = (inventory(&a), inventory(&b));
    let mut process = specgit::process::Process::default();
    process
        .environment
        .insert(OsString::from("git_dir"), b.join(".git").into_os_string());
    let preview = specgit::guard::preview_with_executable(&process, &a, false, &source)
        .await
        .unwrap();
    assert_eq!(preview["dry_run"], true);
    assert!(
        specgit::guard::health_plan(&process, &a)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(inventory(&a), before.0);
    assert_eq!(inventory(&b), before.1);
}

#[tokio::test]
async fn library_guard_plan_apply_rechecks_process_environment_before_locking() {
    let (_temp, _a, b) = repositories(false);
    install_guard(&b);
    expose_guard_repair(&b);
    let process = specgit::process::Process::default();
    let plan = specgit::guard::health_plan(&process, &b)
        .await
        .unwrap()
        .unwrap();
    assert!(!plan.assets().is_empty());
    let before = inventory(&b);
    let mut changed = specgit::process::Process::default();
    changed
        .environment
        .insert(OsString::from("GIT_DIR"), b.join(".git").into_os_string());
    let error = plan.apply(&changed).await.unwrap_err();
    assert_environment_error(&error, "GIT_DIR");
    assert_eq!(inventory(&b), before);
}

#[test]
fn library_guard_inherited_repository_environment_child() {
    let Some(root) = std::env::var_os("SPECGIT_TEST_GUARD_ENV_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let variable = std::env::var("SPECGIT_TEST_GUARD_ENV_VARIABLE").unwrap();
    let source = executable::binary();
    let process = specgit::process::Process::default();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    for error in [
        runtime
            .block_on(specgit::guard::preview_with_executable(
                &process, &root, false, &source,
            ))
            .unwrap_err(),
        runtime
            .block_on(specgit::guard::install_with_executable(
                &process, &root, false, &source,
            ))
            .unwrap_err(),
        runtime
            .block_on(specgit::guard::install_with_executable(
                &process, &root, true, &source,
            ))
            .unwrap_err(),
        runtime
            .block_on(specgit::guard::health_plan(&process, &root))
            .err()
            .unwrap(),
    ] {
        assert_environment_error(&error, &variable);
    }
    assert!(!root.join(".git/hooks/pre-commit").exists());
    assert!(!root.join(".git/specgit-v2").exists());
}

#[test]
fn library_guard_rejects_inherited_repository_environment_without_writes() {
    let (_temp, a, b) = repositories(false);
    install_guard(&b);
    let before = (inventory(&a), inventory(&b));
    for variable in REPOSITORY_OVERRIDES {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "library_guard_inherited_repository_environment_child",
                "--nocapture",
            ])
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_COMMON_DIR")
            .env("SPECGIT_TEST_GUARD_ENV_ROOT", &a)
            .env("SPECGIT_TEST_GUARD_ENV_VARIABLE", variable)
            .env(variable, override_value(variable, &b))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{variable}: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(inventory(&a), before.0, "{variable}: repoA");
        assert_eq!(inventory(&b), before.1, "{variable}: repoB");
    }
}
