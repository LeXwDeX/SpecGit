use serde_json::{Value, json};
use specgit::assets::{AssetStore, Change};
use std::{fs, path::PathBuf, time::Duration};

fn fixture() -> (tempfile::TempDir, PathBuf, AssetStore, String) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = AssetStore::lock(
        &root.join("state"),
        std::slice::from_ref(&root),
        Duration::from_secs(2),
    )
    .unwrap();
    let applied = store
        .apply(vec![
            Change::new(root.join("retained"), Some(b"owned".to_vec())).unwrap(),
            Change::new(root.join("restored"), Some(b"owned".to_vec())).unwrap(),
        ])
        .unwrap();
    (temp, root, store, applied.transaction)
}

#[test]
fn partial_rollback_keeps_full_audit_and_never_replays_already_restored_paths() {
    let (_temp, root, store, id) = fixture();
    let journal_path = root
        .join("state/transactions")
        .join(&id)
        .join("journal.json");
    let (first, retained) = store
        .rollback_retaining(&id, &[root.join("retained")])
        .unwrap();
    assert_eq!(first.changes, 1);
    assert_eq!(retained, vec![root.join("retained")]);
    let partial: Value = serde_json::from_slice(&fs::read(&journal_path).unwrap()).unwrap();
    assert_eq!(partial["state"], "rolled_back_retaining");
    assert_eq!(partial["entries"].as_array().unwrap().len(), 2);
    assert_eq!(partial["retained_paths"], json!([root.join("retained")]));
    fs::write(root.join("restored"), "later manual content").unwrap();
    assert_eq!(
        store
            .rollback_retaining(&id, &[root.join("retained")])
            .unwrap()
            .0
            .changes,
        0
    );
    assert_eq!(store.rollback(&id).unwrap().changes, 1);
    assert_eq!(
        fs::read(root.join("restored")).unwrap(),
        b"later manual content"
    );
    assert!(!root.join("retained").exists());
    let complete: Value = serde_json::from_slice(&fs::read(journal_path).unwrap()).unwrap();
    assert_eq!(complete["state"], "rolled_back");
    assert_eq!(complete["entries"].as_array().unwrap().len(), 2);
    assert!(complete.get("retained_paths").is_none());
    for content in [b"owned".as_slice(), b"different later bytes".as_slice()] {
        fs::write(root.join("retained"), content).unwrap();
        fs::write(root.join("restored"), content).unwrap();
        let (repeated, retained) = store
            .rollback_retaining(&id, &[root.join("retained")])
            .unwrap();
        assert_eq!(repeated.changes, 0);
        assert!(retained.is_empty());
        assert_eq!(store.rollback(&id).unwrap().changes, 0);
        assert_eq!(fs::read(root.join("retained")).unwrap(), content);
        assert_eq!(fs::read(root.join("restored")).unwrap(), content);
    }
}

#[test]
fn invalid_retained_journal_states_fail_before_any_restore() {
    for case in [
        "foreign",
        "duplicate_retained",
        "duplicate_entry",
        "empty_partial",
        "committed_retained",
        "unknown_state",
    ] {
        let (_temp, root, store, id) = fixture();
        store
            .rollback_retaining(&id, &[root.join("retained")])
            .unwrap();
        let path = root
            .join("state/transactions")
            .join(&id)
            .join("journal.json");
        let mut journal: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        match case {
            "foreign" => journal["retained_paths"] = json!([root.join("unowned")]),
            "duplicate_retained" => {
                journal["retained_paths"] = json!([root.join("retained"), root.join("retained")])
            }
            "duplicate_entry" => {
                let entry = journal["entries"][0].clone();
                journal["entries"].as_array_mut().unwrap().push(entry);
            }
            "empty_partial" => journal["retained_paths"] = json!([]),
            "committed_retained" => journal["state"] = json!("committed"),
            "unknown_state" => journal["state"] = json!("unrecognized"),
            _ => unreachable!(),
        }
        fs::write(path, serde_json::to_vec(&journal).unwrap()).unwrap();
        assert!(store.rollback(&id).is_err(), "{case}");
        assert_eq!(fs::read(root.join("retained")).unwrap(), b"owned");
        assert!(!root.join("restored").exists());
    }
}

#[cfg(unix)]
#[test]
fn partial_rollback_preserves_concurrent_permission_edits_without_partial_restore() {
    use std::os::unix::fs::PermissionsExt;
    let (_temp, root, store, id) = fixture();
    fs::set_permissions(root.join("restored"), fs::Permissions::from_mode(0o700)).unwrap();
    assert!(
        store
            .rollback_retaining(&id, &[root.join("retained")])
            .is_err()
    );
    assert_eq!(fs::read(root.join("retained")).unwrap(), b"owned");
    assert_eq!(fs::read(root.join("restored")).unwrap(), b"owned");
    assert_eq!(
        fs::metadata(root.join("restored"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
}

#[cfg(windows)]
#[test]
fn windows_ordinary_retention_path_matches_the_canonical_journal_entry() {
    let (_temp, root, store, id) = fixture();
    let ordinary_root = PathBuf::from(root.to_str().unwrap().strip_prefix(r"\\?\").unwrap());
    let retained = ordinary_root.join("retained");
    let (applied, paths) = store.rollback_retaining(&id, &[retained]).unwrap();
    assert_eq!(applied.changes, 1);
    assert_eq!(paths, vec![root.join("retained")]);
    assert_eq!(fs::read(root.join("retained")).unwrap(), b"owned");
    assert!(!root.join("restored").exists());
    assert_eq!(store.rollback(&id).unwrap().changes, 1);
}
