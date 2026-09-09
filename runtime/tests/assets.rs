use specgit::{
    assets::{AssetStore, Change, Snapshot},
    diagnostic::{Code, Diagnostic},
};
use std::{fs, path::PathBuf, time::Duration};
fn fixture() -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    (temp, root)
}
fn store(root: &std::path::Path) -> AssetStore {
    AssetStore::lock(
        &root.join("state"),
        &[root.into()],
        Duration::from_millis(100),
    )
    .unwrap()
}
#[test]
fn transactions_restore_exact_bytes_and_remove_only_the_created_files() {
    let (_temp, root) = fixture();
    let existing = root.join("user settings.json");
    let created = root.join("assets/中文.txt");
    let foreign = root.join("foreign.txt");
    fs::write(&existing, b"{\n  \"unknown\": true\n}\n").unwrap();
    fs::write(&foreign, b"leave me").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&existing, fs::Permissions::from_mode(0o640)).unwrap();
    }
    let old = Snapshot::read(&existing).unwrap();
    let locked = store(&root);
    let result = locked
        .apply(vec![
            Change::new(existing.clone(), Some(b"new bytes".to_vec())).unwrap(),
            Change::new(created.clone(), Some(b"new asset".to_vec())).unwrap(),
        ])
        .unwrap();
    assert_eq!(result.changes, 2);
    assert_eq!(fs::read(&existing).unwrap(), b"new bytes");
    locked.rollback(&result.transaction).unwrap();
    assert_eq!(fs::read(&existing).unwrap(), old.bytes.unwrap());
    assert!(!created.exists());
    assert_eq!(fs::read(&foreign).unwrap(), b"leave me");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&existing).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }
}
#[test]
fn stale_plan_and_mid_commit_user_edit_are_preserved() {
    let (_temp, root) = fixture();
    let a = root.join("a");
    let b = root.join("b");
    fs::write(&a, b"a0").unwrap();
    fs::write(&b, b"b0").unwrap();
    let locked = store(&root);
    let stale = Change::new(a.clone(), Some(b"a1".to_vec())).unwrap();
    fs::write(&a, b"user-a").unwrap();
    assert_eq!(
        locked.apply(vec![stale]).unwrap_err().code,
        Code::ConcurrentEdit
    );
    assert_eq!(fs::read(&a).unwrap(), b"user-a");
    let changes = vec![
        Change::new(a.clone(), Some(b"a1".to_vec())).unwrap(),
        Change::new(b.clone(), Some(b"b1".to_vec())).unwrap(),
    ];
    let result = locked.apply_checked(changes, |i| {
        if i == 1 {
            fs::write(&b, b"user-b").unwrap();
        }
        Ok(())
    });
    assert_eq!(result.unwrap_err().code, Code::ConcurrentEdit);
    assert_eq!(fs::read(&a).unwrap(), b"user-a");
    assert_eq!(fs::read(&b).unwrap(), b"user-b");
}
#[test]
fn partial_failure_rolls_back_and_later_edit_blocks_manual_rollback() {
    let (_temp, root) = fixture();
    let a = root.join("a");
    let b = root.join("b");
    fs::write(&a, b"a0").unwrap();
    let locked = store(&root);
    let changes = vec![
        Change::new(a.clone(), Some(b"a1".to_vec())).unwrap(),
        Change::new(b.clone(), Some(b"b1".to_vec())).unwrap(),
    ];
    assert!(
        locked
            .apply_checked(changes, |i| if i == 1 {
                Err(Diagnostic::input("fixture disk failure"))
            } else {
                Ok(())
            })
            .is_err()
    );
    assert_eq!(fs::read(&a).unwrap(), b"a0");
    assert!(!b.exists());
    let result = locked
        .apply(vec![Change::new(a.clone(), Some(b"a1".to_vec())).unwrap()])
        .unwrap();
    fs::write(&a, b"user edit").unwrap();
    assert_eq!(
        locked.rollback(&result.transaction).unwrap_err().code,
        Code::RollbackConflict
    );
    assert_eq!(fs::read(&a).unwrap(), b"user edit");
}
#[test]
fn lock_is_bounded_and_released_by_the_owner() {
    let (_temp, root) = fixture();
    let first = store(&root);
    let second = AssetStore::lock(
        &root.join("state"),
        std::slice::from_ref(&root),
        Duration::from_millis(50),
    );
    assert!(matches!(second,Err(d) if d.code==Code::LockBusy));
    drop(first);
    assert!(AssetStore::lock(&root.join("state"), &[root], Duration::from_millis(50)).is_ok());
}
#[test]
fn symlink_ancestors_and_outside_roots_are_rejected_before_writes() {
    let (_temp, root) = fixture();
    let outside = tempfile::tempdir().unwrap();
    let link = root.join("link");
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path(), &link).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(outside.path(), &link).unwrap();
    assert_eq!(
        Change::new(link.join("owned"), Some(vec![1]))
            .unwrap_err()
            .code,
        Code::UnsafePath
    );
    let locked = store(&root);
    let target = outside.path().canonicalize().unwrap().join("unowned");
    assert_eq!(
        locked
            .apply(vec![Change::new(target.clone(), Some(vec![1])).unwrap()])
            .unwrap_err()
            .code,
        Code::UnsafePath
    );
    assert!(!target.exists());
}

#[cfg(feature = "test-fixtures")]
#[test]
fn another_process_recovers_a_crashed_transaction_from_durable_preimages() {
    let (_temp, root) = fixture();
    fs::write(root.join("a"), b"a0").unwrap();
    fs::write(root.join("b"), b"b0").unwrap();
    let result = std::process::Command::new(env!("CARGO_BIN_EXE_specgit-process-fixture"))
        .args(["asset-crash", root.to_str().unwrap()])
        .status()
        .unwrap();
    assert_eq!(result.code(), Some(99));
    assert_eq!(fs::read(root.join("a")).unwrap(), b"a1");
    assert_eq!(fs::read(root.join("b")).unwrap(), b"b0");
    let locked = store(&root);
    let pending = locked.pending_transactions().unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(
        locked
            .apply(vec![
                Change::new(root.join("a"), Some(b"overwrite".to_vec())).unwrap()
            ])
            .unwrap_err()
            .code,
        Code::RollbackConflict
    );
    locked.rollback(&pending[0]).unwrap();
    assert_eq!(fs::read(root.join("a")).unwrap(), b"a0");
    assert_eq!(fs::read(root.join("b")).unwrap(), b"b0");
    assert!(locked.pending_transactions().unwrap().is_empty());
}
