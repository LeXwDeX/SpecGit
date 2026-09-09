use specgit::{
    config::{Declaration, Language},
    guidance,
};
#[test]
fn refresh_preserves_exact_foreign_bytes_and_detects_damaged_or_edited_markers() {
    let t = tempfile::tempdir().unwrap();
    let path = t.path().canonicalize().unwrap().join("AGENTS.md");
    let en = Declaration::default();
    let mut zh = en.clone();
    zh.language = Language::Zh;
    let original = "User prose\r\n\r\n";
    std::fs::write(&path, original).unwrap();
    let first = guidance::change(&path, &en, &en, None)
        .unwrap()
        .after
        .unwrap();
    let mut wrapped = first.clone();
    wrapped.extend_from_slice(b"\r\nTail stays exact\r\n");
    std::fs::write(&path, &wrapped).unwrap();
    let changed = guidance::change(&path, &en, &zh, None)
        .unwrap()
        .after
        .unwrap();
    assert!(changed.starts_with(original.as_bytes()));
    assert!(changed.ends_with(b"\r\nTail stays exact\r\n"));
    assert!(
        String::from_utf8(changed)
            .unwrap()
            .contains("原因、范围、方案")
    );
    std::fs::write(
        &path,
        String::from_utf8(first.clone())
            .unwrap()
            .replace("Hook notices", "User edit"),
    )
    .unwrap();
    assert!(guidance::change(&path, &en, &zh, None).is_err());
    std::fs::write(
        &path,
        String::from_utf8(first)
            .unwrap()
            .replace("<!-- specgit:v2:end -->", ""),
    )
    .unwrap();
    assert!(guidance::change(&path, &en, &zh, None).is_err());
}

#[test]
fn persisted_hash_allows_runtime_upgrade_without_allowing_an_edited_block() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().canonicalize().unwrap();
    let private = root.join("private");
    std::fs::create_dir(&private).unwrap();
    let d = Declaration::default();
    let old = guidance::render(&d).replace(env!("CARGO_PKG_VERSION"), "1.99.0-old");
    std::fs::write(root.join("AGENTS.md"), format!("User prose\n{old}\n")).unwrap();
    std::fs::write(private.join("guidance.json"), serde_json::json!({"version":1,"generator":"1.99.0-old","blocks":{"AGENTS.md":specgit::assets::hash(old.as_bytes())}}).to_string()).unwrap();
    let planned = guidance::changes(&root, &private, &d, &d, false).unwrap();
    assert!(
        String::from_utf8(planned[0].after.clone().unwrap())
            .unwrap()
            .contains(env!("CARGO_PKG_VERSION"))
    );
    std::fs::write(
        root.join("AGENTS.md"),
        old.replace("Hook notices", "Edited text"),
    )
    .unwrap();
    assert!(guidance::changes(&root, &private, &d, &d, false).is_err());
}
