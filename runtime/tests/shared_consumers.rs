#[path = "support/executable.rs"]
mod executable;

use serde_json::Value;
use specgit::{
    assets::{AssetStore, Change},
    local_exclude,
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    String::from_utf8(output.stdout).unwrap().trim().into()
}

fn cli(root: &Path, args: &[&str]) -> Value {
    let output = executable::command()
        .current_dir(root)
        .args(args)
        .arg("--json")
        .output()
        .unwrap();
    let report: Value =
        serde_json::from_slice(&output.stdout).unwrap_or_else(|_| panic!("{output:?}"));
    assert!(output.status.success(), "{report}: {output:?}");
    report
}

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    sibling: PathBuf,
    exclude: PathBuf,
    hooks: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let root = base.join("checkout");
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "-b", "feature"]);
        git(
            &root,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "fixture",
            ],
        );
        git(&root, &["worktree", "add", "-b", "sibling", "../linked"]);
        let sibling = base.join("linked");
        let exclude = PathBuf::from(git(
            &root,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "info/exclude",
            ],
        ));
        fs::create_dir_all(exclude.parent().unwrap()).unwrap();
        fs::write(&exclude, "# user exclusions\n").unwrap();
        let hooks = PathBuf::from(git(
            &root,
            &["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
        ));
        Self {
            _temp: temp,
            root,
            sibling,
            exclude,
            hooks,
        }
    }

    fn exclusion_transaction(&self) -> String {
        let private =
            PathBuf::from(git(&self.root, &["rev-parse", "--absolute-git-dir"])).join("specgit-v2");
        AssetStore::lock(
            &private.join("assets"),
            &[
                self.root.clone(),
                private.clone(),
                self.exclude.parent().unwrap().into(),
            ],
            Duration::from_secs(2),
        )
        .unwrap()
        .apply(vec![
            Change::new(
                self.root.join(".specgit.yaml"),
                Some(b"version: 2\n".to_vec()),
            )
            .unwrap(),
            local_exclude::change(&self.exclude, &[".specgit.yaml"]).unwrap(),
        ])
        .unwrap()
        .transaction
    }

    fn assert_guard(&self, installed: bool) {
        for stage in ["pre-commit", "pre-push"] {
            let bytes = fs::read_to_string(self.hooks.join(stage)).unwrap_or_default();
            assert_eq!(
                bytes.contains("specgit guard --stage"),
                installed,
                "{stage}: {bytes}"
            );
        }
    }

    fn assert_excluded(&self, root: &Path, path: &str, excluded: bool) {
        let output = Command::new("git")
            .current_dir(root)
            .args(["-c", "core.excludesFile=", "check-ignore", "-q", "--", path])
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(if excluded { 0 } else { 1 }),
            "{output:?}"
        );
    }
}

#[test]
fn guidance_only_sibling_keeps_exclusions_without_retaining_unselected_native_guard() {
    let f = Fixture::new();
    cli(
        &f.sibling,
        &["setup", "--agent", "generic", "--hook-purpose", "none"],
    );
    let skill = ".agents/skills/specgit-native/SKILL.md";
    assert!(f.sibling.join(skill).is_file());
    f.assert_excluded(&f.sibling, skill, true);
    cli(&f.root, &["guard", "--install"]);
    f.assert_guard(true);
    let result = cli(&f.root, &["guard", "--uninstall"]);
    assert_eq!(result["installed"], false, "{result}");
    f.assert_guard(false);
    f.assert_excluded(&f.sibling, skill, true);
}

#[test]
fn guard_only_sibling_does_not_retain_unrelated_exclusions_on_rollback_or_remove() {
    for action in ["rollback", "remove"] {
        let f = Fixture::new();
        cli(&f.sibling, &["guard", "--install"]);
        let original = fs::read(&f.exclude).unwrap();
        let transaction = f.exclusion_transaction();
        f.assert_excluded(&f.root, ".specgit.yaml", true);
        if action == "rollback" {
            cli(&f.root, &["init", "--rollback", &transaction]);
        } else {
            let preview = cli(&f.root, &["remove", "--dry-run"]);
            let digest = preview["evidence"]["preview_sha256"].as_str().unwrap();
            cli(&f.root, &["remove", "--apply", "--expect", digest]);
        }
        assert_eq!(fs::read(&f.exclude).unwrap(), original, "{action}");
        f.assert_excluded(&f.root, ".specgit.yaml", false);
        f.assert_guard(true);
    }
}

#[test]
fn declaration_or_initialization_marker_keeps_both_shared_asset_kinds_in_use() {
    for marker in ["declaration", "initialization"] {
        let f = Fixture::new();
        if marker == "declaration" {
            fs::write(f.sibling.join(".specgit.yaml"), "version: 2\n").unwrap();
        } else {
            let private = PathBuf::from(git(&f.sibling, &["rev-parse", "--absolute-git-dir"]))
                .join("specgit-v2");
            fs::create_dir_all(&private).unwrap();
            fs::write(
                private.join("guidance.json"),
                r#"{"version":1,"blocks":{}}"#,
            )
            .unwrap();
        }
        cli(&f.root, &["guard", "--install"]);
        assert_eq!(cli(&f.root, &["guard", "--uninstall"])["installed"], true);
        let transaction = f.exclusion_transaction();
        cli(&f.root, &["init", "--rollback", &transaction]);
        f.assert_guard(true);
        f.assert_excluded(&f.sibling, ".specgit.yaml", true);
    }
}

#[test]
fn malformed_or_unknown_setup_receipt_cannot_authorize_shared_hook_removal() {
    for corrupt in ["malformed", "unknown"] {
        let f = Fixture::new();
        cli(
            &f.sibling,
            &["setup", "--agent", "generic", "--hook-purpose", "none"],
        );
        cli(&f.root, &["guard", "--install"]);
        let receipt = PathBuf::from(git(&f.sibling, &["rev-parse", "--absolute-git-dir"]))
            .join("specgit-v2/agent-assets/ownership.json");
        if corrupt == "malformed" {
            fs::write(&receipt, b"not JSON").unwrap();
        } else {
            let mut content: Value = serde_json::from_slice(&fs::read(&receipt).unwrap()).unwrap();
            content["version"] = 99.into();
            fs::write(&receipt, serde_json::to_vec(&content).unwrap()).unwrap();
        }
        let before: Vec<_> = ["pre-commit", "pre-push"]
            .map(|stage| fs::read(f.hooks.join(stage)).unwrap())
            .into();
        let result = executable::command()
            .current_dir(&f.root)
            .args(["guard", "--uninstall", "--json"])
            .output()
            .unwrap();
        assert!(!result.status.success(), "{corrupt}: {result:?}");
        f.assert_guard(true);
        for (stage, expected) in ["pre-commit", "pre-push"].iter().zip(before) {
            assert_eq!(fs::read(f.hooks.join(stage)).unwrap(), expected);
        }
    }
}

#[test]
fn receipt_only_setup_with_guard_purpose_retains_the_borrowed_native_guard() {
    let f = Fixture::new();
    cli(&f.root, &["guard", "--install"]);
    cli(
        &f.sibling,
        &["setup", "--agent", "generic", "--hook-purpose", "guard"],
    );
    assert!(!f.sibling.join(".specgit.yaml").exists());
    let result = cli(&f.root, &["guard", "--uninstall"]);
    assert_eq!(result["installed"], true, "{result}");
    f.assert_guard(true);
    f.assert_excluded(&f.sibling, ".agents/skills/specgit-native/SKILL.md", true);
}
