use specgit::project::{Provider, parse_remote, valid_oid};
#[test]
fn remote_identity_is_structural_and_preserves_nested_projects() {
    for raw in [
        "https://github.com/Example/Repo.git",
        "git@github.com:Example/Repo.git",
        "ssh://git@github.com:22/Example/Repo.git",
    ] {
        let r = parse_remote(raw, None, None).unwrap();
        assert_eq!(r.provider, Provider::Github);
        assert_eq!(r.path, "Example/Repo");
        assert_eq!(r.host, "github.com");
    }
    let r = parse_remote(
        "ssh://git@forge.example:2222/a/b/c.git",
        Some(Provider::Gitlab),
        Some("api.example:8443"),
    )
    .unwrap();
    assert_eq!(r.path, "a/b/c");
    assert_eq!(r.host, "api.example:8443");
    let r = parse_remote("https://gitlab.com:443/a/b/c.git", None, None).unwrap();
    assert_eq!(r.host, "gitlab.com");
}
#[test]
fn spoofed_or_credential_origins_never_select_a_forge() {
    for raw in [
        "https://github.com.evil.invalid/a/b",
        "https://user:secret@github.com/a/b",
        "https://github.com/a/b?token=secret",
        "https://github.com/a/b#fragment",
        "file:///a/b",
        "https://unknown.example/a/b",
        "https://github.com/a/b/c",
        "git@github.com:/absolute/path",
        "https://github.com/a/%2e%2e/b",
        "https://github.com/a/x/../b",
        "https://github.com/a/./b",
    ] {
        let error = parse_remote(raw, None, None).unwrap_err();
        assert!(!error.to_string().contains("secret"));
    }
    for bad in ["a", "HEAD", " main", &"a".repeat(39), &"g".repeat(40)] {
        assert!(!valid_oid(bad));
    }
    assert!(valid_oid(&"a".repeat(40)));
    assert!(valid_oid(&"a".repeat(64)));
}
