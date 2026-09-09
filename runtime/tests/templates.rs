use specgit::{
    config::{Language, Source, Template},
    templates,
};
use std::collections::BTreeMap;
#[test]
fn explicit_content_is_final_and_substitutions_do_not_recurse_or_execute() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().canonicalize().unwrap();
    let selector = Template {
        source: Source::Inline,
        body: Some("{{title}} / {{body}} / {{summary}}".into()),
        ..Template::default()
    };
    let values = BTreeMap::from([
        ("title", "{{body}}".into()),
        ("body", "$(touch no) `echo no`".into()),
    ]);
    let p = templates::prepare(&root, &selector, Language::En, true, None, &values).unwrap();
    assert_eq!(p.body, "{{body}} / $(touch no) `echo no` / ");
    assert!(templates::substitute("{{unknown}}", &values).is_err());
    let body = root.join("final.md");
    std::fs::write(&body, "User prepared {{unknown}} remains exact").unwrap();
    let p = templates::prepare(&root, &selector, Language::En, true, Some(&body), &values).unwrap();
    assert_eq!(p.source, "body_file");
    assert_eq!(p.body, "User prepared {{unknown}} remains exact");
    assert!(!root.join("no").exists());
}
#[test]
fn native_discovery_reports_ambiguity_and_forms_without_silent_selection() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().canonicalize().unwrap();
    std::fs::create_dir_all(root.join(".github/ISSUE_TEMPLATE")).unwrap();
    std::fs::write(root.join(".github/ISSUE_TEMPLATE/a.md"), "Native markdown").unwrap();
    std::fs::write(
        root.join(".github/ISSUE_TEMPLATE/b.yml"),
        "name: Native form",
    )
    .unwrap();
    let candidates = templates::discover(&root).unwrap();
    assert_eq!(candidates.len(), 2);
    let selector = Template {
        source: Source::Repository,
        path: Some(".github/ISSUE_TEMPLATE/b.yml".into()),
        ..Template::default()
    };
    assert!(
        templates::prepare(&root, &selector, Language::En, true, None, &BTreeMap::new()).is_err()
    );
    assert!(templates::reject_quick_actions("Content\n/close").is_err());
    assert!(templates::reject_quick_actions("Ordinary /close mention").is_ok());
}

#[test]
fn discovery_reports_exhaustion_even_when_entries_are_not_templates() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().canonicalize().unwrap();
    let dir = root.join(".github/ISSUE_TEMPLATE");
    std::fs::create_dir_all(&dir).unwrap();
    for i in 0..101 {
        std::fs::write(dir.join(format!("{i}.txt")), "ignored").unwrap();
    }
    std::fs::write(dir.join("valid.md"), "real template").unwrap();
    assert!(templates::discover(&root).is_err());
}
#[cfg(unix)]
#[test]
fn special_files_are_rejected_before_reading() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().canonicalize().unwrap();
    for name in [".specgit.yaml", "body.md"] {
        assert!(
            std::process::Command::new("mkfifo")
                .arg(root.join(name))
                .status()
                .unwrap()
                .success()
        );
    }
    assert!(specgit::config::read(&root).is_err());
    assert!(templates::read_text(&root.join("body.md")).is_err());
    assert!(specgit::assets::Snapshot::read(&root.join("body.md")).is_err());
}
