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

#[test]
fn crlf_owned_block_refresh_preserves_line_endings_and_exact_foreign_bytes() {
    let t = tempfile::tempdir().unwrap();
    let path = t.path().canonicalize().unwrap().join("AGENTS.md");
    let d = Declaration::default();
    let block = guidance::render(&d);
    let prefix = "Foreign LF\nForeign CRLF\r\n";
    let suffix = "\r\nForeign tail\n";
    std::fs::write(
        &path,
        format!("{prefix}{}{suffix}", block.replace('\n', "\r\n")),
    )
    .unwrap();
    let mut next = d.clone();
    next.language = Language::Zh;
    let hash = specgit::assets::hash(block.as_bytes());
    let after = guidance::change(&path, &next, &next, Some(&hash))
        .unwrap()
        .after
        .unwrap();
    assert!(after.starts_with(prefix.as_bytes()));
    assert!(after.ends_with(suffix.as_bytes()));
    assert!(
        String::from_utf8(after)
            .unwrap()
            .contains(&guidance::render(&next).replace('\n', "\r\n"))
    );
    std::fs::write(
        &path,
        block
            .replace("Hook notices", "User edited")
            .replace('\n', "\r\n"),
    )
    .unwrap();
    assert!(guidance::change(&path, &d, &next, Some(&hash)).is_err());
}

#[test]
fn generated_guidance_uses_native_observation_and_preferences_are_not_authority() {
    let d = Declaration::default();
    let prose = guidance::render(&d);
    assert!(!prose.contains("specgit finish"));
    assert!(prose.contains("specgit watch"));
    assert!(prose.contains("existing user authorization"));
    assert!(prose.contains("disabled by default"));
    assert!(prose.contains("native readback"));
    assert!(prose.contains("\"native_auto_merge\":false"));
    assert!(prose.contains("\"close_issues_after_merge\":false"));
}

#[test]
fn generated_guidance_states_issue_scope_and_authorization_contract_in_both_languages() {
    for language in [Language::En, Language::Zh] {
        let declaration = Declaration {
            language,
            ..Declaration::default()
        };
        let prose = guidance::render(&declaration);
        match language {
            Language::En => {
                assert!(prose.contains(
                    "Read-only inspection, audit, and review do not require an Issue checkpoint"
                ));
                assert!(
                    prose
                        .contains("Before tracked product edits, select a complete relevant Issue")
                );
                assert!(prose.contains("pure documentation work"));
                assert!(prose.contains("Local init/setup is maintenance, not delivery"));
                assert!(prose.contains("Issue/PR writes, including marking a request ready, require existing user authorization"));
                assert!(
                    prose.contains("Existing session authorization remains valid within its scope")
                );
                assert!(prose.contains("`--dry-run` previews grant no permission"));
            }
            Language::Zh => {
                assert!(prose.contains("只读检查、审计和评审不需要 Issue checkpoint"));
                assert!(prose.contains("修改已跟踪的产品代码前，选择一个包含"));
                assert!(prose.contains("纯文档工作按仓库自己的文档流程处理"));
                assert!(prose.contains("本地 init/setup 属于维护，不是交付"));
                assert!(prose.contains("Issue/PR 写入（包括将请求标记为 ready）需要已有用户授权"));
                assert!(prose.contains("会话已有授权在其范围内持续有效"));
                assert!(prose.contains("`--dry-run` 预览都不产生授权"));
            }
        }
    }
}

#[test]
fn receiptless_2_0_0_migration_upgrades_only_the_exact_released_templates() {
    for (language, old) in [
        (Language::En, include_str!("fixtures/guidance-2.0.0-en.txt")),
        (Language::Zh, include_str!("fixtures/guidance-2.0.0-zh.txt")),
    ] {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().canonicalize().unwrap();
        let d = Declaration {
            language,
            ..Declaration::default()
        };
        std::fs::write(root.join("AGENTS.md"), format!("User rules\n{old}\n")).unwrap();
        let changes = guidance::changes(&root, &root.join("private"), &d, &d, false).unwrap();
        let updated = String::from_utf8(changes[0].after.clone().unwrap()).unwrap();
        assert!(updated.starts_with("User rules\n"));
        assert!(
            updated
                .replace("\r\n", "\n")
                .contains(&guidance::render(&d))
        );
        std::fs::write(
            root.join("AGENTS.md"),
            old.replace("## SpecGit 2", "## Edited"),
        )
        .unwrap();
        assert!(guidance::changes(&root, &root.join("private"), &d, &d, false).is_err());
    }
}
