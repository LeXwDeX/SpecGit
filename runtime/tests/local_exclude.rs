use specgit::local_exclude;
#[test]
fn exclusion_refresh_preserves_foreign_bytes_and_rejects_damaged_markers() {
    let t = tempfile::tempdir().unwrap();
    let p = t.path().canonicalize().unwrap().join("exclude");
    let original = "# user\r\n/cache\r\n";
    std::fs::write(&p, original).unwrap();
    let first = local_exclude::change(&p, &[".specgit.yaml", "AGENTS.md", "AGENTS.md"])
        .unwrap()
        .after
        .unwrap();
    std::fs::write(&p, &first).unwrap();
    assert!(
        local_exclude::change(&p, &["AGENTS.md", ".specgit.yaml"])
            .unwrap()
            .unchanged()
    );
    let mut appended = first.clone();
    appended.extend_from_slice(b"# after\n!important\n");
    std::fs::write(&p, &appended).unwrap();
    let updated = local_exclude::change(&p, &[".specgit.yaml"])
        .unwrap()
        .after
        .unwrap();
    assert!(updated.starts_with(original.as_bytes()));
    assert!(updated.ends_with(b"# after\n!important\n"));
    for bad in [
        String::from_utf8(first.clone())
            .unwrap()
            .replace("# specgit:local:v2:end", ""),
        String::from_utf8(first.clone()).unwrap().repeat(2),
        String::from_utf8(first)
            .unwrap()
            .replace("/.specgit.yaml", "/user-secret"),
    ] {
        std::fs::write(&p, bad).unwrap();
        assert!(local_exclude::change(&p, &[".specgit.yaml"]).is_err());
    }
}
