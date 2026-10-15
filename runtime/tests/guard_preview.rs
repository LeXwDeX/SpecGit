#[path = "support/executable.rs"]
mod executable;
use std::{fs, process::Command};
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
    let result = specgit::guard::preview(&process, temp.path(), false)
        .await
        .unwrap();
    assert_eq!(result["dry_run"], true);
    assert_eq!(result["prepared"], true);
    assert!(result.get("installed").is_none());
    assert!(!temp.path().join(".git/hooks/pre-commit").exists());
    assert!(!temp.path().join(".git/specgit-v2").exists());
    let hook = temp.path().join(".git/hooks/pre-commit");
    fs::write(&hook, "#!/bin/sh\necho user\n").unwrap();
    specgit::guard::preview(&process, temp.path(), false)
        .await
        .unwrap();
    assert_eq!(fs::read_to_string(&hook).unwrap(), "#!/bin/sh\necho user\n");
    fs::write(&hook, "#!/usr/bin/python3\nprint(1)\n").unwrap();
    assert!(
        specgit::guard::preview(&process, temp.path(), false)
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
    specgit::guard::install(&process, temp.path(), false)
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
    let result = specgit::guard::preview(&process, temp.path(), true)
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
    specgit::guard::install(&process, root, false)
        .await
        .unwrap();
    let hook = root.join(".git/hooks/pre-commit");
    let before = fs::read(&hook).unwrap();
    let receipt = root.join(".git/specgit-v2/guard-hooks.json");
    let receipt_before = fs::read(&receipt).unwrap();
    let result = specgit::guard::preview(&process, root, true).await.unwrap();
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
