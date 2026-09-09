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
