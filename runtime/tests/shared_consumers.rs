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

#[cfg(unix)]
fn cli_with_home(root: &Path, home: &Path, args: &[&str]) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_specgit"))
        .current_dir(root)
        .env("HOME", home)
        .args(args)
        .arg("--json")
        .output()
        .unwrap();
    let report: Value =
        serde_json::from_slice(&output.stdout).unwrap_or_else(|_| panic!("{output:?}"));
    assert!(output.status.success(), "{report}: {output:?}");
    report
}

fn owned_declaration(root: &Path) {
    let private = PathBuf::from(git(root, &["rev-parse", "--absolute-git-dir"])).join("specgit-v2");
    AssetStore::lock(
        &private.join("assets"),
        &[root.to_owned(), private.clone()],
        Duration::from_secs(2),
    )
    .unwrap()
    .apply(vec![
        Change::new(
            root.join(".specgit.yaml"),
            Some(b"version: 2\nprovider: github\nremote: origin\ntarget: main\n".to_vec()),
        )
        .unwrap(),
    ])
    .unwrap();
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
                bytes.contains(" guard --stage"),
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

#[cfg(feature = "test-fixtures")]
#[test]
fn rollback_waits_for_native_serialization_before_taking_asset_lock() {
    for operation in ["init", "setup", "remove", "migrate"] {
        let f = Fixture::new();
        let id = f.exclusion_transaction();
        let private =
            PathBuf::from(git(&f.root, &["rev-parse", "--absolute-git-dir"])).join("specgit-v2");
        let id = if operation == "remove" {
            AssetStore::lock(
                &private.join("removal"),
                std::slice::from_ref(&f.root),
                Duration::from_secs(2),
            )
            .unwrap()
            .apply(vec![
                Change::new(f.root.join("removal-probe"), Some(b"owned".to_vec())).unwrap(),
            ])
            .unwrap()
            .transaction
        } else {
            id
        };
        let native = private.join("native-guard-lock");
        let held = AssetStore::lock(
            &native,
            std::slice::from_ref(&native),
            Duration::from_secs(2),
        )
        .unwrap();
        let marker = f.root.join("rollback-ready");
        // This observation barrier exists only in the feature-enabled test CLI;
        // production installed binaries must never expose fixture instrumentation.
        let child = Command::new(env!("CARGO_BIN_EXE_specgit"))
            .current_dir(&f.root)
            .env("SPECGIT_FIXTURE_NATIVE_LOCK_READY", &marker)
            .args([operation, "--rollback", &id, "--json"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let started = std::time::Instant::now();
        while !marker.exists() && started.elapsed() < Duration::from_secs(1) {
            std::thread::sleep(Duration::from_millis(5));
        }
        let reached_lock = marker.exists();
        let asset_available = AssetStore::lock(
            &private.join("assets"),
            std::slice::from_ref(&f.root),
            Duration::from_millis(100),
        );
        let available = asset_available.is_ok();
        drop(asset_available);
        drop(held);
        let result = child.wait_with_output().unwrap();
        assert!(reached_lock, "{result:?}");
        assert!(
            available,
            "rollback occupied assets while waiting for native serialization: {result:?}"
        );
        assert!(result.status.success(), "{result:?}");
    }
}

#[tokio::test]
async fn prelocked_rollback_compatibility_api_rejects_without_changing_assets() {
    let f = Fixture::new();
    let id = f.exclusion_transaction();
    let private =
        PathBuf::from(git(&f.root, &["rev-parse", "--absolute-git-dir"])).join("specgit-v2");
    let before = fs::read(&f.exclude).unwrap();
    let store = AssetStore::lock(
        &private.join("assets"),
        std::slice::from_ref(&f.root),
        Duration::from_secs(2),
    )
    .unwrap();
    let result = specgit::config::worktree::rollback(
        &store,
        &specgit::process::Process::default(),
        &f.root,
        &f.exclude,
        &id,
    )
    .await;
    assert!(result.unwrap_err().message.contains("lock_native_guard"));
    assert_eq!(fs::read(&f.exclude).unwrap(), before);
    assert!(f.root.join(".specgit.yaml").exists());
}

#[test]
fn truncated_setup_demand_blocks_sibling_and_current_rollback_consumers() {
    for sibling in [false, true] {
        let f = Fixture::new();
        let installed = cli(&f.root, &["guard", "--install"]);
        let id = installed["transaction"]["transaction"].as_str().unwrap();
        let consumer = if sibling { &f.sibling } else { &f.root };
        cli(
            consumer,
            &["setup", "--agent", "generic", "--hook-purpose", "guard"],
        );
        let receipt = PathBuf::from(git(consumer, &["rev-parse", "--absolute-git-dir"]))
            .join("specgit-v2/agent-assets/ownership.json");
        let mut value: Value = serde_json::from_slice(&fs::read(&receipt).unwrap()).unwrap();
        value.as_object_mut().unwrap().remove("purposes");
        fs::write(&receipt, serde_json::to_vec(&value).unwrap()).unwrap();
        let before: Vec<_> = ["pre-commit", "pre-push"]
            .map(|stage| fs::read(f.hooks.join(stage)).unwrap())
            .into();
        let receipt_before = fs::read(&receipt).unwrap();
        for args in [
            vec!["guard", "--uninstall", "--dry-run"],
            vec!["guard", "--uninstall"],
            vec!["init", "--rollback", id],
        ] {
            let result = executable::command()
                .current_dir(&f.root)
                .args(args)
                .arg("--json")
                .output()
                .unwrap();
            assert!(!result.status.success(), "sibling={sibling}: {result:?}");
            for (stage, expected) in ["pre-commit", "pre-push"].iter().zip(&before) {
                assert_eq!(fs::read(f.hooks.join(stage)).unwrap(), *expected);
            }
            assert_eq!(fs::read(&receipt).unwrap(), receipt_before);
        }
    }
}

#[test]
fn setup_guard_survives_either_owners_retirement_and_pruning_until_last_consumer_leaves() {
    for retire_borrower_first in [false, true] {
        for action in ["setup", "remove"] {
            let f = Fixture::new();
            git(
                &f.root,
                &[
                    "remote",
                    "add",
                    "origin",
                    "https://github.com/fixture/repo.git",
                ],
            );
            git(&f.root, &["worktree", "add", "-b", "second", "../second"]);
            let second = f.root.parent().unwrap().join("second");
            for root in [&f.sibling, &second] {
                // Whole-project removal only deletes declarations with init ownership proof.
                owned_declaration(root);
            }
            for stage in ["pre-commit", "pre-push"] {
                fs::write(f.hooks.join(stage), "#!/bin/sh\n# original foreign hook\n").unwrap();
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(f.hooks.join(stage), fs::Permissions::from_mode(0o755))
                        .unwrap();
                }
            }
            cli(
                &f.sibling,
                &["setup", "--agent", "generic", "--hook-purpose", "guard"],
            );
            cli(
                &second,
                &["setup", "--agent", "generic", "--hook-purpose", "guard"],
            );
            for stage in ["pre-commit", "pre-push"] {
                let path = f.hooks.join(stage);
                let mut bytes = fs::read(&path).unwrap();
                bytes.extend_from_slice(b"# later foreign hook\n");
                fs::write(path, bytes).unwrap();
            }
            let (retiring, survivor) = if retire_borrower_first {
                (&second, &f.sibling)
            } else {
                (&f.sibling, &second)
            };
            let retire = || {
                if action == "setup" {
                    cli(retiring, &["setup", "--uninstall"])
                } else {
                    let preview = cli(retiring, &["remove", "--dry-run"]);
                    cli(
                        retiring,
                        &[
                            "remove",
                            "--apply",
                            "--expect",
                            preview["evidence"]["preview_sha256"].as_str().unwrap(),
                        ],
                    )
                }
            };
            let first = retire();
            let first_id = first["evidence"]["transaction"]["transaction"]
                .as_str()
                .unwrap();
            cli(retiring, &[action, "--rollback", first_id]);
            f.assert_guard(true);
            let retired = retire();
            let id = retired["evidence"]["transaction"]["transaction"]
                .as_str()
                .unwrap();
            f.assert_guard(true);
            fs::remove_dir_all(retiring).unwrap();
            git(&f.root, &["worktree", "prune", "--expire", "now"]);
            let before: Vec<_> = ["pre-commit", "pre-push"]
                .map(|stage| fs::read(f.hooks.join(stage)).unwrap())
                .into();
            let rollback = executable::command()
                .current_dir(survivor)
                .args([action, "--rollback", id, "--json"])
                .output()
                .unwrap();
            assert!(
                !rollback.status.success(),
                "a survivor must not reconstruct the retired worktree: {rollback:?}"
            );
            assert!(!retiring.exists());
            for (stage, expected) in ["pre-commit", "pre-push"].iter().zip(&before) {
                assert_eq!(fs::read(f.hooks.join(stage)).unwrap(), *expected);
            }
            let doctor = cli(survivor, &["doctor", "--offline"]);
            assert_ne!(
                doctor["evidence"]["health"]["status"], "unknown",
                "{doctor}"
            );
            assert!(
                doctor["evidence"]["health"]["checks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|check| check["id"] == "guard" && check["status"] == "current"),
                "{doctor}"
            );
            cli(survivor, &["setup", "--dry-run"]);
            cli(survivor, &["setup", "--uninstall"]);
            f.assert_guard(false);
            for stage in ["pre-commit", "pre-push"] {
                let script = fs::read_to_string(f.hooks.join(stage)).unwrap();
                assert!(script.contains("# original foreign hook"));
                assert!(script.contains("# later foreign hook"));
            }
            cli(survivor, &["guard", "--install"]);
            cli(survivor, &["guard", "--uninstall"]);
            f.assert_guard(false);
        }
    }
}

#[cfg(windows)]
#[test]
fn canonical_library_guard_rollback_revokes_receipt_and_hooks_together() {
    use specgit::setup::{Agent, HookOptions, HookPurpose, project};
    for entry in ["init", "setup", "migrate"] {
        let f = Fixture::new();
        let private = f.root.join(".git/specgit-v2/agent-assets");
        let installed = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(project::install_with_context(
                &project::Options {
                    agents: vec![Agent::Generic],
                    opencode_claude_hooks: false,
                    uninstall: false,
                    dry_run: false,
                    rollback: None,
                },
                &HookOptions {
                    purposes: vec![HookPurpose::Guard],
                    opencode_async_rewake: false,
                },
                &f.root,
                &private,
                &executable::binary(),
                &specgit::process::Process::default(),
            ))
            .unwrap();
        let id = installed["transaction"]["transaction"].as_str().unwrap();
        f.assert_guard(true);
        cli(&f.root, &[entry, "--rollback", id]);
        assert!(!private.join("ownership.json").exists());
        assert!(
            !private
                .parent()
                .unwrap()
                .join("setup-guard-hooks.json")
                .exists()
        );
        f.assert_guard(false);
        cli(&f.root, &["guard", "--install"]);
        cli(&f.root, &["guard", "--uninstall"]);
        f.assert_guard(false);
    }
}

#[test]
fn borrower_can_take_independent_ownership_from_retained_shared_custody() {
    let f = Fixture::new();
    git(&f.root, &["worktree", "add", "-b", "second", "../second"]);
    let owner = f.root.parent().unwrap().join("second");
    cli(
        &owner,
        &["setup", "--agent", "generic", "--hook-purpose", "guard"],
    );
    cli(
        &f.sibling,
        &["setup", "--agent", "generic", "--hook-purpose", "guard"],
    );
    cli(&owner, &["setup", "--uninstall"]);
    f.assert_guard(true);
    fs::remove_dir_all(&owner).unwrap();
    git(&f.root, &["worktree", "prune", "--expire", "now"]);

    let preview = cli(&f.sibling, &["guard", "--install", "--dry-run"]);
    assert_eq!(preview["prepared"], true, "{preview}");
    cli(&f.sibling, &["guard", "--install"]);
    let common = PathBuf::from(git(
        &f.root,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ));
    let custody = common.join("specgit-v2/shared-setup-guard");
    let leftover = fs::read_dir(&custody)
        .unwrap()
        .filter_map(Result::ok)
        .any(|entry| entry.path().join("setup-guard-hooks.json").exists());
    assert!(!leftover, "the transferred shared receipt must be retired");
    // Setup no longer owns the hooks; the independent guard keeps them.
    cli(&f.sibling, &["setup", "--uninstall"]);
    f.assert_guard(true);
    cli(&f.sibling, &["guard", "--uninstall"]);
    f.assert_guard(false);
}

fn failure(root: &Path, args: &[&str]) -> Value {
    let output = executable::command()
        .current_dir(root)
        .args(args)
        .arg("--json")
        .output()
        .unwrap();
    assert!(!output.status.success(), "{args:?}: {output:?}");
    serde_json::from_slice(&output.stdout).unwrap_or_else(|_| panic!("{output:?}"))
}

fn guard_transaction_at(root: &Path) -> String {
    let installed = cli(root, &["guard", "--install"]);
    installed["transaction"]["transaction"]
        .as_str()
        .unwrap_or_else(|| panic!("{installed}"))
        .to_owned()
}

fn setup_transaction_at(root: &Path) -> String {
    let installed = cli(
        root,
        &["setup", "--agent", "generic", "--hook-purpose", "guard"],
    );
    installed["evidence"]["transaction"]["transaction"]
        .as_str()
        .unwrap_or_else(|| panic!("{installed}"))
        .to_owned()
}

fn git_arg_path(path: &Path) -> String {
    let text = path.to_str().unwrap();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        text.strip_prefix(r"\\?\").unwrap_or(text).to_owned()
    }
}

#[test]
fn git_arg_path_strips_windows_verbatim_prefix() {
    assert_eq!(
        git_arg_path(Path::new(r"\\?\C:\tmp\hooks")),
        r"C:\tmp\hooks"
    );
    assert_eq!(
        git_arg_path(Path::new(r"\\?\UNC\server\share\hooks")),
        r"\\server\share\hooks"
    );
    assert_eq!(git_arg_path(Path::new("/tmp/hooks")), "/tmp/hooks");
}

fn assert_same_path(actual: &Path, expected: &Path, context: &str) {
    assert_eq!(
        actual.canonicalize().unwrap(),
        expected.canonicalize().unwrap(),
        "{context}: actual={} expected={}",
        actual.display(),
        expected.display()
    );
}

/// A, the original setup guard owner, retires into shared custody and is pruned;
/// B, the surviving borrower, then moves `core.hooksPath`.
struct MovedCustody {
    f: Fixture,
    moved: PathBuf,
    receipt: PathBuf,
}

impl MovedCustody {
    fn new() -> Self {
        let f = Fixture::new();
        git(&f.root, &["worktree", "add", "-b", "second", "../second"]);
        let owner = f.root.parent().unwrap().join("second");
        cli(
            &owner,
            &["setup", "--agent", "generic", "--hook-purpose", "guard"],
        );
        cli(
            &f.sibling,
            &["setup", "--agent", "generic", "--hook-purpose", "guard"],
        );
        cli(&owner, &["setup", "--uninstall"]);
        f.assert_guard(true);
        fs::remove_dir_all(&owner).unwrap();
        git(&f.root, &["worktree", "prune", "--expire", "now"]);
        let common = PathBuf::from(git(
            &f.root,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        ));
        let receipts: Vec<_> = fs::read_dir(common.join("specgit-v2/shared-setup-guard"))
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path().join("setup-guard-hooks.json"))
            .filter(|path| path.exists())
            .collect();
        assert_eq!(receipts.len(), 1, "{receipts:?}");
        let moved = common.join("moved-hooks");
        fs::create_dir(&moved).unwrap();
        Self {
            receipt: receipts[0].clone(),
            f,
            moved,
        }
    }

    fn move_hooks(&self) {
        git(
            &self.f.sibling,
            &["config", "core.hooksPath", self.moved.to_str().unwrap()],
        );
    }

    fn restore_hooks(&self) {
        git(&self.f.sibling, &["config", "--unset", "core.hooksPath"]);
    }

    fn setup_state(&self) -> PathBuf {
        PathBuf::from(git(&self.f.sibling, &["rev-parse", "--absolute-git-dir"]))
            .join("specgit-v2/agent-assets/ownership.json")
    }
}

#[test]
fn moved_hook_path_cannot_hide_retained_setup_custody_from_borrower_uninstall() {
    let m = MovedCustody::new();
    let f = &m.f;
    let state = m.setup_state();
    let skill = f.sibling.join(".agents/skills/specgit-native/SKILL.md");
    let state_before = fs::read(&state).unwrap();
    let receipt_before = fs::read(&m.receipt).unwrap();
    let hooks_before: Vec<_> = ["pre-commit", "pre-push"]
        .map(|stage| fs::read(f.hooks.join(stage)).unwrap())
        .into();
    assert!(skill.is_file());
    m.move_hooks();
    for args in [
        vec!["setup", "--uninstall", "--dry-run"],
        vec!["setup", "--uninstall"],
    ] {
        let report = failure(&f.sibling, &args);
        let message = report.to_string();
        assert!(
            message.contains("core.hooksPath") && message.contains(f.hooks.to_str().unwrap()),
            "{report}"
        );
        assert_eq!(fs::read(&state).unwrap(), state_before);
        assert!(skill.is_file());
        assert_eq!(fs::read(&m.receipt).unwrap(), receipt_before);
        for (stage, expected) in ["pre-commit", "pre-push"].iter().zip(&hooks_before) {
            assert_eq!(fs::read(f.hooks.join(stage)).unwrap(), *expected);
        }
        assert!(fs::read_dir(&m.moved).unwrap().next().is_none());
    }
    m.restore_hooks();
    cli(&f.sibling, &["setup", "--uninstall"]);
    f.assert_guard(false);
    assert!(!m.receipt.exists());
    assert!(!state.exists());
}

#[test]
fn moved_hook_path_rollback_finds_retained_custody_journal_and_fails_closed() {
    let m = MovedCustody::new();
    let f = &m.f;
    let retired = cli(&f.sibling, &["setup", "--uninstall"]);
    let id = retired["evidence"]["transaction"]["transaction"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        m.receipt
            .parent()
            .unwrap()
            .join("assets/transactions")
            .join(&id)
            .join("journal.json")
            .exists(),
        "the last consumer's cleanup is recorded in shared custody"
    );
    f.assert_guard(false);
    m.move_hooks();
    let report = failure(&f.sibling, &["setup", "--rollback", &id]);
    let message = report.to_string();
    assert!(
        message.contains(&id) && message.contains("core.hooksPath"),
        "{report}"
    );
    f.assert_guard(false);
    assert!(!m.receipt.exists());
    m.restore_hooks();
    cli(&f.sibling, &["setup", "--rollback", &id]);
    f.assert_guard(true);
    assert!(m.receipt.exists());
}

#[cfg(feature = "test-fixtures")]
#[test]
fn concurrent_owner_and_borrower_uninstall_never_leave_unowned_hooks() {
    use std::{process::Stdio, time::Instant};
    let f = Fixture::new();
    cli(
        &f.root,
        &["setup", "--agent", "generic", "--hook-purpose", "guard"],
    );
    cli(
        &f.sibling,
        &["setup", "--agent", "generic", "--hook-purpose", "guard"],
    );
    f.assert_guard(true);
    let native = PathBuf::from(git(&f.root, &["rev-parse", "--absolute-git-dir"]))
        .join("specgit-v2/native-guard-lock");
    let held = AssetStore::lock(
        &native,
        std::slice::from_ref(&native),
        Duration::from_secs(2),
    )
    .unwrap();
    // Both uninstalls plan against the shared state before either may write.
    let spawn = |root: &Path, marker: &Path| {
        Command::new(env!("CARGO_BIN_EXE_specgit"))
            .current_dir(root)
            .env("SPECGIT_FIXTURE_SETUP_PLAN_READY", marker)
            .args(["setup", "--uninstall", "--json"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap()
    };
    let markers = [f.root.join("owner-ready"), f.sibling.join("borrower-ready")];
    let children = [spawn(&f.root, &markers[0]), spawn(&f.sibling, &markers[1])];
    let deadline = Instant::now() + Duration::from_secs(10);
    while markers.iter().any(|m| !m.exists()) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        markers.iter().all(|m| m.exists()),
        "both uninstalls must plan"
    );
    drop(held);
    let outcomes: Vec<bool> = children
        .into_iter()
        .map(|child| child.wait_with_output().unwrap().status.success())
        .collect();
    let guard_left = fs::read_to_string(f.hooks.join("pre-commit"))
        .unwrap_or_default()
        .contains(" guard --stage");
    assert!(
        !(outcomes.iter().all(|ok| *ok) && guard_left),
        "both stale uninstalls succeeded but left unowned hooks"
    );
    // A stale plan is rejected rather than applied; replanning finishes cleanup.
    for (root, ok) in [&f.root, &f.sibling].into_iter().zip(&outcomes) {
        if !ok {
            cli(root, &["setup", "--uninstall"]);
        }
    }
    f.assert_guard(false);
}

/// Git does not take SpecGit's lock, so a checkout added during the locked
/// uninstall transaction must abort it before the shared hooks are removed.
#[cfg(feature = "test-fixtures")]
#[test]
fn worktree_added_during_setup_uninstall_transaction_keeps_shared_hooks() {
    let f = Fixture::new();
    git(&f.root, &["switch", "-q", "-c", "declared"]);
    fs::write(f.root.join(".specgit.yaml"), "version: 2\n").unwrap();
    git(&f.root, &["add", ".specgit.yaml"]);
    git(
        &f.root,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-q",
            "-m",
            "declare",
        ],
    );
    git(&f.root, &["switch", "-q", "feature"]);
    assert!(!f.root.join(".specgit.yaml").exists());
    cli(
        &f.sibling,
        &["setup", "--agent", "generic", "--hook-purpose", "guard"],
    );
    f.assert_guard(true);

    let pause = tempfile::tempdir().unwrap();
    // The pause point exists only in the fixture build, never in release binaries.
    let child = Command::new(env!("CARGO_BIN_EXE_specgit"))
        .current_dir(&f.sibling)
        .args(["setup", "--uninstall", "--json"])
        .env("SPECGIT_FIXTURE_ASSET_PAUSE", "before-write:0")
        .env("SPECGIT_FIXTURE_ASSET_PAUSE_DIR", pause.path())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while !pause.path().join("ready").exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "uninstall never paused"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    git(&f.root, &["worktree", "add", "-q", "../third", "declared"]);
    fs::write(pause.path().join("go"), b"go").unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success(), "{output:?}");
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        report.to_string().contains("worktree inventory changed"),
        "{report}"
    );
    f.assert_guard(true);
}

/// The registry can stay unchanged while a valid declaration appears in an
/// already registered sibling. The rollback must recheck that state before
/// writing, not trust the discovery-time consumer list.
#[cfg(feature = "test-fixtures")]
#[test]
fn declaration_added_to_existing_sibling_during_rollback_keeps_shared_hooks() {
    let f = Fixture::new();
    let installed = cli(
        &f.sibling,
        &["setup", "--agent", "generic", "--hook-purpose", "guard"],
    );
    let id = installed["evidence"]["transaction"]["transaction"]
        .as_str()
        .unwrap_or_else(|| panic!("{installed}"))
        .to_owned();
    f.assert_guard(true);
    let private =
        PathBuf::from(git(&f.sibling, &["rev-parse", "--absolute-git-dir"])).join("specgit-v2");
    let receipt = private.join("agent-assets/ownership.json");
    let source = private.join("setup-guard-hooks.json");
    let before: Vec<_> = [
        f.hooks.join("pre-commit"),
        f.hooks.join("pre-push"),
        receipt,
        source,
    ]
    .iter()
    .map(|path| fs::read(path).ok())
    .collect();

    let pause = tempfile::tempdir().unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_specgit"))
        .current_dir(&f.sibling)
        .args(["setup", "--rollback", &id, "--json"])
        .env("SPECGIT_FIXTURE_ASSET_PAUSE", "before-rollback-write:1")
        .env("SPECGIT_FIXTURE_ASSET_PAUSE_DIR", pause.path())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while !pause.path().join("ready").exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "rollback never paused"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    // The main checkout is already registered; only its declaration appears.
    fs::write(f.root.join(".specgit.yaml"), "version: 2\n").unwrap();
    fs::write(pause.path().join("go"), b"go").unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success(), "{output:?}");
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(report.to_string().contains("changed"), "{report}");
    f.assert_guard(true);
    let after: Vec<_> = [
        f.hooks.join("pre-commit"),
        f.hooks.join("pre-push"),
        private.join("agent-assets/ownership.json"),
        private.join("setup-guard-hooks.json"),
    ]
    .iter()
    .map(|path| fs::read(path).ok())
    .collect();
    assert_eq!(
        after, before,
        "the aborted rollback must undo its own writes"
    );

    // A fresh scan sees the new consumer and retains the hooks and receipts.
    let retried = cli(&f.sibling, &["setup", "--rollback", &id]);
    assert!(
        !retried["evidence"]["retained"]
            .as_array()
            .unwrap_or_else(|| panic!("{retried}"))
            .is_empty(),
        "{retried}"
    );
    f.assert_guard(true);
    assert!(private.join("setup-guard-hooks.json").exists());

    // Once the consumer leaves, the retained journal finishes the rollback.
    fs::remove_file(f.root.join(".specgit.yaml")).unwrap();
    let finished = cli(&f.sibling, &["setup", "--rollback", &id]);
    assert!(
        finished["evidence"]["retained"]
            .as_array()
            .unwrap_or_else(|| panic!("{finished}"))
            .is_empty(),
        "{finished}"
    );
    f.assert_guard(false);
}

#[cfg(feature = "test-fixtures")]
fn paused_rollback(root: &Path, args: &[&str]) -> (std::process::Child, tempfile::TempDir) {
    let pause = tempfile::tempdir().unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_specgit"))
        .current_dir(root)
        .args(args)
        .env("SPECGIT_FIXTURE_ASSET_PAUSE", "before-rollback-write:1")
        .env("SPECGIT_FIXTURE_ASSET_PAUSE_DIR", pause.path())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while !pause.path().join("ready").exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "rollback never paused"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    (child, pause)
}

#[cfg(feature = "test-fixtures")]
fn finish_paused(child: std::process::Child, pause: &tempfile::TempDir) -> (Value, bool) {
    fs::write(pause.path().join("go"), b"go").unwrap();
    let output = child.wait_with_output().unwrap();
    let report: Value =
        serde_json::from_slice(&output.stdout).unwrap_or_else(|_| panic!("{output:?}"));
    (report, output.status.success())
}

/// The same stale-consumer race can remove the shared exclusion. A declaration
/// appearing in an already registered sibling must retain it or fail closed.
#[cfg(feature = "test-fixtures")]
#[test]
fn declaration_added_to_existing_sibling_during_rollback_keeps_shared_exclusion() {
    let f = Fixture::new();
    let id = f.exclusion_transaction();
    let before = fs::read(&f.exclude).unwrap();
    f.assert_excluded(&f.root, ".specgit.yaml", true);
    let (child, pause) = paused_rollback(&f.root, &["init", "--rollback", &id, "--json"]);
    fs::write(f.sibling.join(".specgit.yaml"), "version: 2\n").unwrap();
    let (report, ok) = finish_paused(child, &pause);
    assert!(!ok, "{report}");
    assert!(report.to_string().contains("changed"), "{report}");
    assert_eq!(fs::read(&f.exclude).unwrap(), before);
    f.assert_excluded(&f.root, ".specgit.yaml", true);

    let retried = cli(&f.root, &["init", "--rollback", &id]);
    assert!(
        !retried["evidence"]["retained"]
            .as_array()
            .unwrap_or_else(|| panic!("{retried}"))
            .is_empty(),
        "{retried}"
    );
    f.assert_excluded(&f.sibling, ".specgit.yaml", true);
}

/// An active Git operation in a sibling can still finish a checkout after the
/// consumer scan. Its native lock is evidence that the scan is not stable.
#[cfg(feature = "test-fixtures")]
#[test]
fn active_git_operation_in_existing_sibling_aborts_rollback() {
    let f = Fixture::new();
    git(
        &f.root,
        &["worktree", "add", "-q", "-b", "second", "../second"],
    );
    let second = f.root.parent().unwrap().join("second");
    let installed = cli(
        &f.sibling,
        &["setup", "--agent", "generic", "--hook-purpose", "guard"],
    );
    let id = installed["evidence"]["transaction"]["transaction"]
        .as_str()
        .unwrap_or_else(|| panic!("{installed}"))
        .to_owned();
    f.assert_guard(true);
    let second_git = PathBuf::from(git(&second, &["rev-parse", "--absolute-git-dir"]));
    let (child, pause) = paused_rollback(&f.sibling, &["setup", "--rollback", &id, "--json"]);
    let lock = second_git.join("index.lock");
    fs::write(&lock, b"locked").unwrap();
    let (report, ok) = finish_paused(child, &pause);
    assert!(!ok, "{report}");
    assert!(report.to_string().contains("active"), "{report}");
    f.assert_guard(true);
    assert_eq!(fs::read(&lock).unwrap(), b"locked");
    fs::remove_file(&lock).unwrap();

    cli(&f.sibling, &["setup", "--rollback", &id]);
    f.assert_guard(false);
}

/// A declaration permission change is rollback evidence too. The content did
/// not change, so a digest-only witness would miss it.
#[cfg(all(feature = "test-fixtures", unix))]
#[test]
fn declaration_permission_change_during_rollback_aborts() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let declaration = f.root.join(".specgit.yaml");
    fs::write(&declaration, "version: 2\n").unwrap();
    fs::set_permissions(&declaration, fs::Permissions::from_mode(0o644)).unwrap();
    let installed = cli(
        &f.sibling,
        &["setup", "--agent", "generic", "--hook-purpose", "guard"],
    );
    let id = installed["evidence"]["transaction"]["transaction"]
        .as_str()
        .unwrap_or_else(|| panic!("{installed}"))
        .to_owned();
    f.assert_guard(true);
    let (child, pause) = paused_rollback(&f.sibling, &["setup", "--rollback", &id, "--json"]);
    fs::set_permissions(&declaration, fs::Permissions::from_mode(0o600)).unwrap();
    let (report, ok) = finish_paused(child, &pause);
    assert!(!ok, "{report}");
    assert!(report.to_string().contains("changed"), "{report}");
    f.assert_guard(true);
    assert_eq!(
        fs::metadata(&declaration).unwrap().permissions().mode() & 0o777,
        0o600
    );

    fs::set_permissions(&declaration, fs::Permissions::from_mode(0o644)).unwrap();
    let retried = cli(&f.sibling, &["setup", "--rollback", &id]);
    assert!(
        !retried["evidence"]["retained"]
            .as_array()
            .unwrap_or_else(|| panic!("{retried}"))
            .is_empty(),
        "{retried}"
    );
    f.assert_guard(true);
}

/// Removing the declaration does not uninitialize the worktree: retained
/// private markers keep the shared hooks in use after a fresh scan.
#[cfg(feature = "test-fixtures")]
#[test]
fn declaration_removed_during_rollback_with_private_state_keeps_hooks() {
    let f = Fixture::new();
    let declaration = f.root.join(".specgit.yaml");
    fs::write(&declaration, "version: 2\n").unwrap();
    let private =
        PathBuf::from(git(&f.root, &["rev-parse", "--absolute-git-dir"])).join("specgit-v2");
    fs::create_dir_all(&private).unwrap();
    fs::write(
        private.join("guidance.json"),
        r#"{"version":1,"blocks":{}}"#,
    )
    .unwrap();
    let installed = cli(
        &f.sibling,
        &["setup", "--agent", "generic", "--hook-purpose", "guard"],
    );
    let id = installed["evidence"]["transaction"]["transaction"]
        .as_str()
        .unwrap_or_else(|| panic!("{installed}"))
        .to_owned();
    f.assert_guard(true);
    let (child, pause) = paused_rollback(&f.sibling, &["setup", "--rollback", &id, "--json"]);
    fs::remove_file(&declaration).unwrap();
    let (report, ok) = finish_paused(child, &pause);
    assert!(!ok, "{report}");
    assert!(report.to_string().contains("changed"), "{report}");
    f.assert_guard(true);

    let retried = cli(&f.sibling, &["setup", "--rollback", &id]);
    assert!(
        !retried["evidence"]["retained"]
            .as_array()
            .unwrap_or_else(|| panic!("{retried}"))
            .is_empty(),
        "{retried}"
    );
    f.assert_guard(true);
}

/// Stable non-consumers must not block rollback forever.
#[test]
fn stable_nonconsumer_sibling_does_not_block_rollback_cleanup() {
    let f = Fixture::new();
    let original = fs::read(&f.exclude).unwrap();
    let id = f.exclusion_transaction();
    let result = cli(&f.root, &["init", "--rollback", &id]);
    assert_eq!(fs::read(&f.exclude).unwrap(), original);
    assert!(!f.root.join(".specgit.yaml").exists());
    assert!(
        result["evidence"]["retained"]
            .as_array()
            .unwrap_or_else(|| panic!("{result}"))
            .is_empty(),
        "{result}"
    );
}

/// A gone checkout stays in the registry until Git prunes it. Git's own
/// prunable marking makes that state stable enough for cleanup.
#[test]
fn prunable_sibling_checkout_does_not_block_rollback_cleanup() {
    let f = Fixture::new();
    let original = fs::read(&f.exclude).unwrap();
    let id = f.exclusion_transaction();
    fs::remove_dir_all(&f.sibling).unwrap();
    let result = cli(&f.root, &["init", "--rollback", &id]);
    assert_eq!(fs::read(&f.exclude).unwrap(), original);
    assert!(
        result["evidence"]["retained"]
            .as_array()
            .unwrap_or_else(|| panic!("{result}"))
            .is_empty(),
        "{result}"
    );
}

#[cfg(unix)]
#[test]
fn global_config_symlink_does_not_block_rollback() {
    use std::os::unix::fs::symlink;
    let home = tempfile::tempdir().unwrap();
    let target = home.path().join("gitconfig-target");
    fs::write(&target, b"").unwrap();
    symlink(&target, home.path().join(".gitconfig")).unwrap();
    let f = Fixture::new();
    let installed = cli_with_home(&f.root, home.path(), &["guard", "--install"]);
    let id = installed["transaction"]["transaction"]
        .as_str()
        .unwrap_or_else(|| panic!("{installed}"))
        .to_owned();
    f.assert_guard(true);
    cli_with_home(&f.root, home.path(), &["setup", "--rollback", &id]);
    f.assert_guard(false);
}

/// A registered checkout directory must expose the same Git identity as its
/// registry entry. A prunable or invalid marker is not cleanup-safe.
#[test]
fn present_but_invalid_registered_checkout_blocks_rollback_cleanup() {
    for case in ["missing_marker", "missing_target", "wrong_existing_target"] {
        let f = Fixture::new();
        fs::write(f.sibling.join(".specgit.yaml"), "version: 2\n").unwrap();
        let id = guard_transaction_at(&f.root);
        f.assert_guard(true);
        let marker = f.sibling.join(".git");
        let original = fs::read(&marker).unwrap();
        let saved = f.sibling.join(".git.saved");
        let base = f.root.parent().unwrap();
        match case {
            "missing_marker" => fs::rename(&marker, &saved).unwrap(),
            "missing_target" => fs::write(
                &marker,
                format!("gitdir: {}\n", base.join("missing-gitdir").display()),
            )
            .unwrap(),
            "wrong_existing_target" => {
                let wrong = base.join("wrong-gitdir");
                fs::create_dir(&wrong).unwrap();
                fs::write(&marker, format!("gitdir: {}\n", wrong.display())).unwrap();
            }
            _ => unreachable!(),
        }
        let list = git(&f.root, &["worktree", "list", "--porcelain"]);
        if case == "missing_marker" {
            assert!(list.contains("prunable"), "{list}");
        }
        let report = failure(&f.root, &["setup", "--rollback", &id]);
        assert!(
            report.to_string().contains("incomplete"),
            "{case}: {report}"
        );
        f.assert_guard(true);

        match case {
            "missing_marker" => fs::rename(&saved, &marker).unwrap(),
            _ => fs::write(&marker, &original).unwrap(),
        }
        let retried = cli(&f.root, &["setup", "--rollback", &id]);
        assert!(
            !retried["evidence"]["retained"]
                .as_array()
                .unwrap_or_else(|| panic!("{retried}"))
                .is_empty(),
            "{case}: {retried}"
        );
        f.assert_guard(true);

        fs::remove_file(f.sibling.join(".specgit.yaml")).unwrap();
        let finished = cli(&f.root, &["setup", "--rollback", &id]);
        assert!(
            finished["evidence"]["retained"]
                .as_array()
                .unwrap_or_else(|| panic!("{finished}"))
                .is_empty(),
            "{case}: {finished}"
        );
        f.assert_guard(false);
    }
}

/// A checkout marker removed after the inventory and consumer scan must abort
/// the rollback instead of leaving the remaining consumers unobserved.
#[cfg(feature = "test-fixtures")]
#[test]
fn marker_removed_after_scan_aborts_rollback() {
    let f = Fixture::new();
    fs::write(f.sibling.join(".specgit.yaml"), "version: 2\n").unwrap();
    let id = setup_transaction_at(&f.root);
    f.assert_guard(true);
    let marker = f.sibling.join(".git");
    let saved = f.sibling.join(".git.saved");
    let (child, pause) = paused_rollback(&f.root, &["setup", "--rollback", &id, "--json"]);
    fs::rename(&marker, &saved).unwrap();
    let (report, ok) = finish_paused(child, &pause);
    assert!(!ok, "{report}");
    f.assert_guard(true);

    fs::rename(&saved, &marker).unwrap();
    let retried = cli(&f.root, &["setup", "--rollback", &id]);
    assert!(
        !retried["evidence"]["retained"]
            .as_array()
            .unwrap_or_else(|| panic!("{retried}"))
            .is_empty(),
        "{retried}"
    );
    f.assert_guard(true);

    fs::remove_file(f.sibling.join(".specgit.yaml")).unwrap();
    cli(&f.root, &["setup", "--rollback", &id]);
    f.assert_guard(false);
}

/// The main checkout is not in the linked-worktree registry. Its active hook
/// demand must still be observed and retain the shared hooks.
#[test]
fn main_hook_demand_retains_shared_hooks_from_linked_rollback() {
    let f = Fixture::new();
    fs::write(f.root.join(".specgit.yaml"), "version: 2\n").unwrap();
    let id = guard_transaction_at(&f.sibling);
    f.assert_guard(true);
    let retained = cli(&f.sibling, &["setup", "--rollback", &id]);
    assert!(
        !retained["evidence"]["retained"]
            .as_array()
            .unwrap_or_else(|| panic!("{retained}"))
            .is_empty(),
        "{retained}"
    );
    f.assert_guard(true);

    fs::remove_file(f.root.join(".specgit.yaml")).unwrap();
    let finished = cli(&f.sibling, &["setup", "--rollback", &id]);
    assert!(
        finished["evidence"]["retained"]
            .as_array()
            .unwrap_or_else(|| panic!("{finished}"))
            .is_empty(),
        "{finished}"
    );
    f.assert_guard(false);
}

/// Main can move its own worktree hook path while a sibling keeps the shared
/// hooks. The current path has no installed guard, so retention must use the
/// journal targets and the sibling demand, not the drifted current path.
#[test]
fn main_hook_path_drift_keeps_sibling_shared_hooks() {
    let f = Fixture::new();
    let main_id = setup_transaction_at(&f.root);
    fs::write(f.sibling.join(".specgit.yaml"), "version: 2\n").unwrap();
    f.assert_guard(true);
    git(&f.root, &["config", "extensions.worktreeConfig", "true"]);
    let empty = f.root.parent().unwrap().join("empty-hooks");
    fs::create_dir(&empty).unwrap();
    git(
        &f.root,
        &[
            "config",
            "--worktree",
            "core.hooksPath",
            &git_arg_path(&empty),
        ],
    );
    let main_hooks = git(
        &f.root,
        &["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
    );
    assert_same_path(Path::new(&main_hooks), &empty, "main hooks");
    let sibling_hooks = git(
        &f.sibling,
        &["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
    );
    assert_same_path(Path::new(&sibling_hooks), &f.hooks, "sibling hooks");
    let report = cli(&f.root, &["setup", "--rollback", &main_id]);
    let retained = report["evidence"]["retained"]
        .as_array()
        .unwrap_or_else(|| panic!("{report}"));
    assert!(
        retained.iter().any(
            |entry| entry["path"].as_str().is_some_and(|path| Path::new(path)
                .file_name()
                .is_some_and(|name| name == "pre-commit"))
        ),
        "{report}"
    );
    assert!(
        retained.iter().any(
            |entry| entry["path"].as_str().is_some_and(|path| Path::new(path)
                .file_name()
                .is_some_and(|name| name == "setup-guard-hooks.json"))
        ),
        "{report}"
    );
    f.assert_guard(true);

    fs::remove_file(f.sibling.join(".specgit.yaml")).unwrap();
    let finished = cli(&f.root, &["setup", "--rollback", &main_id]);
    assert!(
        finished["evidence"]["retained"]
            .as_array()
            .unwrap_or_else(|| panic!("{finished}"))
            .is_empty(),
        "{finished}"
    );
    f.assert_guard(false);
}

/// A dynamic hook path must not turn an active declaration into a deletion
/// reason. Retain until the last demand leaves, then finish the same journal.
#[test]
fn dynamic_hook_path_change_keeps_shared_hooks_until_the_last_demand() {
    for case in ["missing_include", "empty_include", "onbranch"] {
        let f = Fixture::new();
        git(&f.root, &["config", "extensions.worktreeConfig", "true"]);
        let extra = f.root.parent().unwrap().join("dynamic-hooks.config");
        let other = f.root.parent().unwrap().join("other-hooks");
        fs::create_dir(&other).unwrap();
        match case {
            "missing_include" | "empty_include" => {
                git(
                    &f.sibling,
                    &[
                        "config",
                        "--worktree",
                        "include.path",
                        &git_arg_path(&extra),
                    ],
                );
            }
            "onbranch" => {
                git(
                    &f.sibling,
                    &[
                        "config",
                        "--worktree",
                        "includeIf.onbranch:other.path",
                        &git_arg_path(&extra),
                    ],
                );
            }
            _ => unreachable!(),
        }
        if case == "empty_include" {
            fs::write(&extra, b"").unwrap();
        }
        let id = setup_transaction_at(&f.root);
        setup_transaction_at(&f.sibling);
        f.assert_guard(true);
        git(
            &f.root,
            &[
                "config",
                "--file",
                &git_arg_path(&extra),
                "core.hooksPath",
                &git_arg_path(&other),
            ],
        );
        if case == "onbranch" {
            git(&f.sibling, &["switch", "-q", "-c", "other"]);
        }
        let actual = git(
            &f.sibling,
            &["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
        );
        assert_same_path(Path::new(&actual), &other, case);
        let report = cli(&f.root, &["setup", "--rollback", &id]);
        assert!(
            !report["evidence"]["retained"]
                .as_array()
                .unwrap_or_else(|| panic!("{case}: {report}"))
                .is_empty(),
            "{case}: {report}"
        );
        f.assert_guard(true);

        git(
            &f.sibling,
            &[
                "config",
                "--worktree",
                "core.hooksPath",
                &git_arg_path(&f.hooks),
            ],
        );
        cli(&f.sibling, &["setup", "--uninstall"]);
        let finished = cli(&f.root, &["setup", "--rollback", &id]);
        assert!(
            finished["evidence"]["retained"]
                .as_array()
                .unwrap_or_else(|| panic!("{case}: {finished}"))
                .is_empty(),
            "{case}: {finished}"
        );
        f.assert_guard(false);
    }
}

/// An exact-ID rollback scans consumers before writing. A checkout added by
/// Git, which does not take SpecGit's lock, must abort it before the shared
/// hooks are removed and leave every rollback target unchanged.
#[cfg(feature = "test-fixtures")]
#[test]
fn worktree_added_during_exact_rollback_keeps_shared_hooks() {
    let f = Fixture::new();
    git(&f.root, &["switch", "-q", "-c", "declared"]);
    fs::write(f.root.join(".specgit.yaml"), "version: 2\n").unwrap();
    git(&f.root, &["add", ".specgit.yaml"]);
    git(
        &f.root,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-q",
            "-m",
            "declare",
        ],
    );
    git(&f.root, &["switch", "-q", "feature"]);
    assert!(!f.root.join(".specgit.yaml").exists());
    let installed = cli(
        &f.sibling,
        &["setup", "--agent", "generic", "--hook-purpose", "guard"],
    );
    let id = installed["evidence"]["transaction"]["transaction"]
        .as_str()
        .unwrap_or_else(|| panic!("{installed}"))
        .to_owned();
    f.assert_guard(true);
    let private =
        PathBuf::from(git(&f.sibling, &["rev-parse", "--absolute-git-dir"])).join("specgit-v2");
    let receipt = private.join("agent-assets/ownership.json");
    let source = private.join("setup-guard-hooks.json");
    assert!(source.exists());
    let snapshot = |path: &Path| fs::read(path).ok();
    let before: Vec<_> = [
        f.hooks.join("pre-commit"),
        f.hooks.join("pre-push"),
        receipt.clone(),
        source.clone(),
    ]
    .iter()
    .map(|path| snapshot(path))
    .collect();

    let pause = tempfile::tempdir().unwrap();
    // The pause point exists only in the fixture build, never in release binaries.
    let child = Command::new(env!("CARGO_BIN_EXE_specgit"))
        .current_dir(&f.sibling)
        .args(["setup", "--rollback", &id, "--json"])
        .env("SPECGIT_FIXTURE_ASSET_PAUSE", "before-rollback-write:1")
        .env("SPECGIT_FIXTURE_ASSET_PAUSE_DIR", pause.path())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while !pause.path().join("ready").exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "rollback never paused"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    git(&f.root, &["worktree", "add", "-q", "../third", "declared"]);
    fs::write(pause.path().join("go"), b"go").unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success(), "{output:?}");
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        report.to_string().contains("worktree inventory changed"),
        "{report}"
    );
    f.assert_guard(true);
    let after: Vec<_> = [
        f.hooks.join("pre-commit"),
        f.hooks.join("pre-push"),
        receipt.clone(),
        source.clone(),
    ]
    .iter()
    .map(|path| snapshot(path))
    .collect();
    assert_eq!(
        after, before,
        "the aborted rollback must undo its own writes"
    );

    // With the inventory stable, the same exact rollback now retains the
    // hooks for the added consumer.
    let retried = cli(&f.sibling, &["setup", "--rollback", &id]);
    assert!(
        !retried["evidence"]["retained"]
            .as_array()
            .unwrap_or_else(|| panic!("{retried}"))
            .is_empty(),
        "{retried}"
    );
    f.assert_guard(true);
}
