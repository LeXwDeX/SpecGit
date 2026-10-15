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

#[test]
fn generated_skill_exclusion_leaves_other_agent_files_visible() {
    use std::{fs, process::Command};
    let t = tempfile::tempdir().unwrap();
    let root = t.path().canonicalize().unwrap();
    assert!(
        Command::new("git")
            .args(["init", "-q"])
            .current_dir(&root)
            .status()
            .unwrap()
            .success()
    );
    let exclude = root.join(".git/info/exclude");
    fs::create_dir_all(exclude.parent().unwrap()).unwrap();
    let change = local_exclude::change(
        &exclude,
        &[".specgit.yaml", ".agents/skills/specgit-native/SKILL.md"],
    )
    .unwrap();
    fs::write(&exclude, change.after.unwrap()).unwrap();
    for (name, ignored) in [
        (".agents/skills/specgit-native/SKILL.md", true),
        (".agents/skills/specgit-native/notes.md", false),
        (".agents/skills/manual/SKILL.md", false),
        ("AGENTS.md", false),
        ("nested/.agents/skills/specgit-native/SKILL.md", false),
    ] {
        let result = Command::new("git")
            .args(["-c", "core.excludesFile=", "check-ignore", "-q", "--", name])
            .current_dir(&root)
            .status()
            .unwrap();
        assert_eq!(result.success(), ignored, "{name}");
    }
}

#[test]
fn project_refresh_keeps_sibling_skill_rules_and_retires_instruction_exclusions() {
    use specgit::assets::Change;
    use std::fs;
    let t = tempfile::tempdir().unwrap();
    let root = t.path().canonicalize().unwrap();
    let exclude = root.join("exclude");
    fs::write(&exclude, "# user\r\n/user-cache\r\n").unwrap();
    let previous = local_exclude::change(
        &exclude,
        &[
            ".specgit.yaml",
            "AGENTS.md",
            "CLAUDE.md",
            ".claude/skills/specgit-native/SKILL.md",
        ],
    )
    .unwrap();
    fs::write(&exclude, previous.after.unwrap()).unwrap();
    let changes = vec![
        Change::new(
            root.join(".agents/skills/specgit-native/SKILL.md"),
            Some(b"generated".to_vec()),
        )
        .unwrap(),
    ];
    let planned = local_exclude::project_change(&root, &exclude, &changes).unwrap();
    let after = String::from_utf8(planned.after.unwrap()).unwrap();
    assert!(after.starts_with("# user\r\n/user-cache\r\n"));
    assert!(after.contains("/.agents/skills/specgit-native/SKILL.md\r\n"));
    assert!(after.contains("/.claude/skills/specgit-native/SKILL.md\r\n"));
    assert!(!after.contains("/AGENTS.md"));
    assert!(!after.contains("/CLAUDE.md"));
    fs::write(&exclude, &after).unwrap();
    assert!(
        local_exclude::project_change(&root, &exclude, &changes)
            .unwrap()
            .unchanged()
    );
    assert!(
        local_exclude::project_change(&root, &exclude, &[])
            .unwrap()
            .unchanged()
    );
    fs::write(&exclude, after.replace("/.specgit.yaml", "/.agents/")).unwrap();
    assert!(local_exclude::project_change(&root, &exclude, &changes).is_err());
}

#[tokio::test]
async fn tracked_generated_skill_is_reported_without_changing_the_index() {
    use specgit::{assets::Change, process::Process};
    use std::{fs, process::Command};
    let t = tempfile::tempdir().unwrap();
    let root = t.path().canonicalize().unwrap();
    assert!(
        Command::new("git")
            .args(["init", "-q"])
            .current_dir(&root)
            .status()
            .unwrap()
            .success()
    );
    let relative = ".agents/skills/specgit-native/SKILL.md";
    let skill = root.join(relative);
    fs::create_dir_all(skill.parent().unwrap()).unwrap();
    fs::write(&skill, "generated").unwrap();
    assert!(
        Command::new("git")
            .args(["add", "-f", "--", relative])
            .current_dir(&root)
            .status()
            .unwrap()
            .success()
    );
    let before = fs::read(root.join(".git/index")).unwrap();
    let mut changes = vec![Change::new(skill, Some(b"updated".to_vec())).unwrap()];
    let report = local_exclude::plan(
        &Process::default(),
        &root,
        &root.join(".git/info/exclude"),
        &mut changes,
    )
    .await
    .unwrap();
    assert_eq!(report["already_tracked"], serde_json::json!([relative]));
    assert_eq!(
        report["excluded_paths"],
        serde_json::json!([".specgit.yaml", relative])
    );
    assert_eq!(report["index_changed"], false);
    assert!(
        report["tracked_remedy"]
            .as_str()
            .unwrap()
            .contains("git rm --cached")
    );
    assert_eq!(fs::read(root.join(".git/index")).unwrap(), before);
}
