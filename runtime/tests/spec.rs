use specgit::{
    config::{Declaration, Labels, Language, Tag},
    spec,
};
#[test]
fn native_input_bounds_apply_even_when_optional_conventions_are_off() {
    let d = Declaration::default();
    for title in [String::new(), "x".repeat(256), "feat: first\nsecond".into()] {
        assert!(!spec::check(&d, true, &title, "body", &[]).is_empty());
    }
    for name in ["has space", "BadUppercase", "x:::y", "-leading"] {
        let mut d = d.clone();
        d.tags.push(Tag {
            name: name.into(),
            color: "112233".into(),
            description: String::new(),
        });
        assert!(d.validate().is_err());
    }
}

#[test]
fn language_rules_preserve_unicode_han_semantics_and_are_opt_in() {
    let mut d = Declaration::default();
    assert!(spec::check_labels(&d, &["native::one".into(), "native::two".into()]).is_none());
    assert!(
        spec::selected_labels(
            &d,
            "fix: bug",
            Some(&["native::one".into(), "native::two".into()]),
            &["native::one".into(), "native::two".into()]
        )
        .is_err()
    );
    assert!(spec::check_title(&d, "feat: 中文").is_none());
    d.validation.titles = true;
    for han in ["中文", "𠀀", "〇"] {
        assert!(spec::check_title(&d, &format!("feat: {han}")).is_some());
        d.language = Language::Zh;
        assert!(spec::check_title(&d, &format!("feat: {han}")).is_none());
        d.language = Language::En;
    }
    assert!(spec::check_title(&d, "feat: native runtime").is_none());
    assert!(spec::kind("unknown: runtime").is_err());
}

#[test]
fn required_bodies_ignore_comments_and_fenced_fake_headings_but_accept_code_evidence() {
    let mut d = Declaration::default();
    d.templates.issue.required_sections = Some(vec!["Why".into(), "Evidence".into()]);
    for invalid in [
        "## Why\n<!-- explanation -->\n## Evidence\nDone",
        "## Why\nTODO\n## Evidence\nDone",
        "```\n## Why\nFilled\n## Evidence\nDone\n```",
        "## Why\nExplained\n## Evidence\n{{unfilled}}",
    ] {
        assert!(spec::check_body(&d, true, invalid).is_some(), "{invalid}");
    }
    let valid = "## Why\nExplained\n## Evidence\n```rust\nTODO {{literal_example}}\n```";
    assert!(spec::check_body(&d, true, valid).is_none());
}

#[test]
fn labels_follow_modes_pool_and_axes_without_renaming_native_labels() {
    let mut d = Declaration::default();
    assert!(
        spec::selected_labels(&d, "feat: plain", None, &[])
            .unwrap()
            .is_empty()
    );
    d.validation.labels = Labels::Kind;
    assert_eq!(
        spec::selected_labels(&d, "fix: bug", None, &[]).unwrap(),
        ["kind::fix"]
    );
    assert!(
        spec::selected_labels(
            &d,
            "fix: bug",
            Some(&["kind::fix".into(), "kind::feat".into()]),
            &[]
        )
        .is_err()
    );
    assert!(
        spec::selected_labels(
            &d,
            "fix: bug",
            Some(&["foreign".into()]),
            &["foreign".into()]
        )
        .is_err()
    );
    d.validation.labels = Labels::Project;
    d.tags.push(Tag {
        name: "area::cli".into(),
        color: "336699".into(),
        description: "CLI".into(),
    });
    assert!(spec::selected_labels(&d, "fix: bug", None, &[]).is_err());
    assert_eq!(
        spec::selected_labels(&d, "fix: bug", Some(&["area::cli".into()]), &[]).unwrap(),
        ["area::cli"]
    );
}

#[test]
fn closing_references_preserve_foreign_prose_and_reject_hidden_or_cross_repo_bindings() {
    let body = "User prose\r\n\r\nCloses #2\r\n\n```\nCloses #9\n```\n<!-- Closes #10 -->";
    let result = spec::with_references(body, &[2, 3, 3]).unwrap();
    assert!(result.starts_with(body));
    assert_eq!(
        spec::references(&result)
            .unwrap()
            .into_iter()
            .collect::<Vec<_>>(),
        [2, 3]
    );
    assert_eq!(result.matches("Closes #3").count(), 1);
    for invalid in [
        "Closes other/repo#2",
        "Closes #2 and #3",
        "```\nunfinished",
        "<!-- unfinished",
    ] {
        assert!(spec::with_references(invalid, &[4]).is_err(), "{invalid}");
    }
}
