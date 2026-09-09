use specgit::{
    config::{Declaration, Labels, Language},
    diagnostic::Code,
};
#[test]
fn defaults_and_full_roundtrip_preserve_shared_choices() {
    let d = Declaration::parse(b"version: 2\n").unwrap();
    assert_eq!(d.language, Language::En);
    assert_eq!(d.validation.labels, Labels::Off);
    assert_eq!(d.observation.poll_seconds, 15);
    assert!(d.remote.is_none());
    let full = br#"version: 2
remote: upstream
provider: gitlab
target: preview
language: zh
validation: {titles: true, labels: project, bodies: true}
tags: [{name: 'area::cli', color: '336699', description: CLI}]
templates:
  issue: {source: inline, body: 'Why {{title}}', required_sections: [Why]}
  pr: {source: repository, path: .gitlab/merge_request_templates/release.md}
verification: {required_checks: [build, tests]}
observation: {poll_seconds: 30, max_wait_seconds: 900, notify: [completed]}
"#;
    let d = Declaration::parse(full).unwrap();
    let d2 = Declaration::parse(&d.bytes().unwrap()).unwrap();
    assert_eq!(d2.language, Language::Zh);
    assert_eq!(d2.target.as_deref(), Some("preview"));
    assert_eq!(d2.templates.issue.body, d.templates.issue.body);
}
#[test]
fn rejects_unknown_duplicate_conflicting_and_unbounded_input() {
    for bad in [
        "version: 2\nversion: 2",
        "version: 2\ntoken: secret",
        "version: 3",
        "version: 2\nlanguage: fr",
        "version: 2\nvalidation: {titles: true, titles: false}",
        "version: 2\nvalidation: {extra: 1}",
        "version: 2\nobservation: {poll_seconds: 0}",
        "version: 2\nobservation: {max_wait_seconds: 999999}",
        "version: 2\nobservation: {notify: [completed, completed]}",
        "version: 2\nverification: {required_checks: [test, test]}",
        "version: 2\nvalidation: {labels: project}",
        "version: 2\ntemplates: {issue: {source: builtin, body: text}}",
        "version: 2\ntemplates: {issue: {source: repository, path: ../user}}",
        "version: 2\ntemplates: {issue: {source: inline}}",
        "version: 2\ntarget: x.lock",
        "version: 2\ntarget: x/../y",
        "version: 2\nremote: --all",
        "version: 2\ntemplates: {pr: {source: repository, path: 'C:\\user'}}",
        "version: 2\ntemplates: {pr: {source: builtin, required_sections: []}}",
    ] {
        assert!(
            Declaration::parse(bad.as_bytes()).is_err(),
            "accepted {bad}"
        );
    }
    assert_eq!(
        Declaration::parse(b"version: 1\ndelivery: legacy\n")
            .unwrap_err()
            .code,
        Code::MigrationRequired
    );
    assert_eq!(
        Declaration::parse(&vec![b' '; 1024 * 1024 + 1])
            .unwrap_err()
            .code,
        Code::InputLimit
    );
}
#[test]
fn off_is_a_string_enum_and_invalid_files_are_unchanged() {
    let d = Declaration::parse(b"version: 2\nvalidation: {labels: off}\n").unwrap();
    assert_eq!(d.validation.labels, Labels::Off);
    let t = tempfile::tempdir().unwrap();
    let root = t.path().canonicalize().unwrap();
    let original = b"version: 2\nunknown: secret";
    std::fs::write(root.join(".specgit.yaml"), original).unwrap();
    assert!(specgit::config::read(&root).is_err());
    assert_eq!(std::fs::read(root.join(".specgit.yaml")).unwrap(), original);
}
