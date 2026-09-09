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

#[tokio::test]
async fn linked_worktrees_and_ambiguous_remotes_preserve_local_identity() {
    use specgit::{diagnostic::Code, process::Process, project::resolve};
    use std::process::Command;
    let root = tempfile::tempdir().unwrap();
    let main = root.path().join("main 空格");
    std::fs::create_dir(&main).unwrap();
    let git = |args: &[&str]| {
        let output = Command::new("git")
            .current_dir(&main)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    git(&["init"]);
    git(&["config", "user.name", "Fixture"]);
    git(&["config", "user.email", "fixture@example.invalid"]);
    git(&["commit", "--allow-empty", "-m", "fixture"]);
    git(&["remote", "add", "origin", "git@github.com:owner/repo.git"]);
    let linked = root.path().join("linked 空格");
    git(&[
        "worktree",
        "add",
        "--detach",
        linked.to_str().unwrap(),
        "HEAD",
    ]);
    let process = Process::default();
    let original = resolve(&process, &main, None, None, None).await.unwrap();
    std::fs::write(linked.join("foreign.txt"), "preserve").unwrap();
    let observed = resolve(&process, &linked, None, None, None).await.unwrap();
    assert_eq!(original.head, observed.head);
    assert_eq!(
        original.common_dir.canonicalize().unwrap(),
        observed.common_dir.canonicalize().unwrap()
    );
    assert_ne!(original.git_dir, observed.git_dir);
    assert!(original.branch.is_some());
    assert!(observed.branch.is_none());
    assert!(!original.dirty);
    assert!(observed.dirty);
    git(&["remote", "add", "second", "git@gitlab.com:group/repo.git"]);
    assert_eq!(
        resolve(&process, &linked, None, None, None)
            .await
            .unwrap_err()
            .code,
        Code::AmbiguousRemote
    );
    assert_eq!(
        resolve(&process, &linked, Some("origin"), None, None)
            .await
            .unwrap()
            .repository,
        original.repository
    );
    assert_eq!(
        std::fs::read_to_string(linked.join("foreign.txt")).unwrap(),
        "preserve"
    );
}
