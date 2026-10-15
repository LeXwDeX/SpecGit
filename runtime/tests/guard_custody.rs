//! Standalone `guard --install` must not create independent ownership while
//! retained shared setup guard custody is hidden by a moved `core.hooksPath`
//! or has an unfinished shared transaction.
#[path = "support/executable.rs"]
mod executable;

use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
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

/// `guard` keeps the Git-hook protocol: diagnostics are text on stderr.
fn failure(root: &Path, args: &[&str]) -> String {
    let output = executable::command()
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(3), "{args:?}: {output:?}");
    String::from_utf8(output.stderr).unwrap()
}

fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}

fn preview_code(root: &Path) -> specgit::diagnostic::Code {
    let process = specgit::process::Process::default();
    match block_on(specgit::guard::preview(&process, root, false)) {
        Ok(report) => panic!("preview must fail: {report}"),
        Err(diagnostic) => diagnostic.code,
    }
}

/// A (`second`) owns the setup guard and B (`linked`) borrows it. A retires
/// into shared custody and is removed and pruned, so B is the last consumer.
struct Retained {
    _temp: tempfile::TempDir,
    borrower: PathBuf,
    hooks: PathBuf,
    common: PathBuf,
    receipt: PathBuf,
}

impl Retained {
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
        git(&root, &["worktree", "add", "-b", "second", "../second"]);
        let borrower = base.join("linked");
        let owner = base.join("second");
        let hooks = PathBuf::from(git(
            &root,
            &["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
        ));
        let common = PathBuf::from(git(
            &root,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        ));
        let setup = ["setup", "--agent", "generic", "--hook-purpose", "guard"];
        cli(&owner, &setup);
        cli(&borrower, &setup);
        cli(&owner, &["setup", "--uninstall"]);
        fs::remove_dir_all(&owner).unwrap();
        git(&root, &["worktree", "prune", "--expire", "now"]);
        let receipts: Vec<_> = fs::read_dir(common.join("specgit-v2/shared-setup-guard"))
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path().join("setup-guard-hooks.json"))
            .filter(|path| path.exists())
            .collect();
        assert_eq!(receipts.len(), 1, "{receipts:?}");
        let fixture = Self {
            _temp: temp,
            borrower,
            hooks,
            common,
            receipt: receipts[0].clone(),
        };
        fixture.assert_guard(true);
        fixture
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

    fn private(&self) -> PathBuf {
        PathBuf::from(git(&self.borrower, &["rev-parse", "--absolute-git-dir"])).join("specgit-v2")
    }

    fn hook_bytes(&self) -> Vec<Vec<u8>> {
        ["pre-commit", "pre-push"]
            .map(|stage| fs::read(self.hooks.join(stage)).unwrap())
            .into()
    }

    #[cfg(feature = "test-fixtures")]
    fn shared_pending(&self) -> Vec<PathBuf> {
        let transactions = self.receipt.parent().unwrap().join("assets/transactions");
        let Ok(entries) = fs::read_dir(transactions) else {
            return vec![];
        };
        entries
            .filter_map(Result::ok)
            .map(|entry| entry.path().join("journal.json"))
            .filter(|journal| {
                fs::read_to_string(journal).is_ok_and(|text| text.contains("\"prepared\""))
            })
            .collect()
    }
}

#[test]
fn moved_hook_path_cannot_hide_retained_custody_from_standalone_guard_install() {
    let r = Retained::new();
    let moved = r.common.join("moved-hooks");
    fs::create_dir(&moved).unwrap();
    let receipt_before = fs::read(&r.receipt).unwrap();
    let hooks_before = r.hook_bytes();
    let independent = r.private().join("guard-hooks.json");
    git(
        &r.borrower,
        &["config", "core.hooksPath", moved.to_str().unwrap()],
    );
    for args in [
        vec!["guard", "--install", "--dry-run"],
        vec!["guard", "--install"],
    ] {
        let message = failure(&r.borrower, &args);
        assert!(
            message.contains("core.hooksPath") && message.contains(r.hooks.to_str().unwrap()),
            "{message}"
        );
        assert!(!independent.exists(), "no independent receipt may appear");
        for stage in ["pre-commit", "pre-push"] {
            let text = fs::read_to_string(moved.join(stage)).unwrap_or_default();
            assert!(!text.contains("specgit-v2:pre-"), "{stage}: {text}");
        }
        assert_eq!(fs::read(&r.receipt).unwrap(), receipt_before);
        assert_eq!(r.hook_bytes(), hooks_before);
    }
    assert_eq!(
        preview_code(&r.borrower),
        specgit::diagnostic::Code::OwnershipConflict
    );
    // Read-only health inspection reports the conflict instead of "no guard".
    let health = block_on(specgit::guard::health_plan(
        &specgit::process::Process::default(),
        &r.borrower,
    ));
    let Err(diagnostic) = health else {
        panic!("health must not report missing ownership");
    };
    assert_eq!(
        diagnostic.code,
        specgit::diagnostic::Code::OwnershipConflict,
        "{diagnostic:?}"
    );
    assert!(diagnostic.remedy.contains(r.hooks.to_str().unwrap()));

    // Restoring the recorded directory restores the ordinary transfer path.
    git(&r.borrower, &["config", "--unset", "core.hooksPath"]);
    cli(&r.borrower, &["guard", "--install"]);
    assert!(independent.exists());
    assert!(!r.receipt.exists());
    r.assert_guard(true);
}

#[cfg(feature = "test-fixtures")]
#[test]
fn pending_shared_custody_transaction_blocks_standalone_guard_transfer() {
    let r = Retained::new();
    // Interrupt the last consumer's cleanup, which records its transaction in
    // shared custody, before its first write.
    let output = Command::new(env!("CARGO_BIN_EXE_specgit"))
        .current_dir(&r.borrower)
        .env("SPECGIT_FIXTURE_ASSET_CRASH", "before-write:0")
        .args(["setup", "--uninstall", "--json"])
        .output()
        .unwrap();
    assert!(!output.status.success(), "{output:?}");
    let pending = r.shared_pending();
    assert_eq!(pending.len(), 1, "{output:?}");
    r.assert_guard(true);
    let receipt_before = fs::read(&r.receipt).unwrap();
    let hooks_before = r.hook_bytes();
    let independent = r.private().join("guard-hooks.json");
    let id = pending[0]
        .parent()
        .unwrap()
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    for args in [
        vec!["guard", "--install", "--dry-run"],
        vec!["guard", "--install"],
    ] {
        let message = failure(&r.borrower, &args);
        assert!(
            message.contains(&id) && message.contains("--rollback"),
            "{message}"
        );
        assert!(!independent.exists(), "custody must not be transferred");
        assert_eq!(fs::read(&r.receipt).unwrap(), receipt_before);
        assert_eq!(r.hook_bytes(), hooks_before);
        assert_eq!(r.shared_pending(), pending);
    }
    assert_eq!(
        preview_code(&r.borrower),
        specgit::diagnostic::Code::RollbackConflict
    );
}

/// A worktree that never selected the guard must not become a second setup
/// owner in the moved hook directory while custody is retained elsewhere.
#[test]
fn moved_hook_path_blocks_a_new_setup_guard_owner() {
    let r = Retained::new();
    let root = r.borrower.parent().unwrap().join("checkout");
    let moved = r.common.join("moved-hooks");
    fs::create_dir(&moved).unwrap();
    git(
        &root,
        &["config", "core.hooksPath", moved.to_str().unwrap()],
    );
    let receipt_before = fs::read(&r.receipt).unwrap();
    let setup_receipt = PathBuf::from(git(&root, &["rev-parse", "--absolute-git-dir"]))
        .join("specgit-v2/setup-guard-hooks.json");
    for dry_run in [true, false] {
        let mut args = vec!["setup", "--agent", "generic", "--hook-purpose", "guard"];
        if dry_run {
            args.push("--dry-run");
        }
        let output = executable::command()
            .current_dir(&root)
            .args(&args)
            .arg("--json")
            .output()
            .unwrap();
        assert!(!output.status.success(), "{args:?}: {output:?}");
        let message = String::from_utf8_lossy(&output.stdout);
        assert!(message.contains("core.hooksPath"), "{message}");
        assert!(!setup_receipt.exists());
        for stage in ["pre-commit", "pre-push"] {
            let text = fs::read_to_string(moved.join(stage)).unwrap_or_default();
            assert!(!text.contains("specgit-v2:pre-"), "{stage}: {text}");
        }
        assert_eq!(fs::read(&r.receipt).unwrap(), receipt_before);
    }
    // Setup without the guard purpose stays available.
    cli(&root, &["setup", "--agent", "generic"]);
    assert!(!setup_receipt.exists());
}
