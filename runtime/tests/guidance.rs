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
fn canonical_prompts_allow_receiptless_language_changes_for_lf_and_crlf_blocks() {
    for (from, to) in [(Language::En, Language::Zh), (Language::Zh, Language::En)] {
        let previous = Declaration {
            language: from,
            ..Declaration::default()
        };
        let next = Declaration {
            language: to,
            ..Declaration::default()
        };
        let previous_block = guidance::render(&previous);
        assert!(!previous_block.contains('\r'));
        for crlf in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().canonicalize().unwrap().join("AGENTS.md");
            let prefix = "Foreign CRLF\r\nForeign LF\n";
            let suffix = "\r\nTail stays exact\n";
            let block = if crlf {
                previous_block.replace('\n', "\r\n")
            } else {
                previous_block.clone()
            };
            std::fs::write(&path, format!("{prefix}{block}{suffix}")).unwrap();
            let after = guidance::change(&path, &previous, &next, None)
                .unwrap()
                .after
                .unwrap();
            let expected = if crlf {
                guidance::render(&next).replace('\n', "\r\n")
            } else {
                guidance::render(&next)
            };
            assert_eq!(after, format!("{prefix}{expected}{suffix}").into_bytes());
        }
    }
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

#[test]
fn self_hosted_recovery_is_bounded_in_both_languages_and_preserves_user_content() {
    for (language, clauses) in [
        (
            Language::En,
            vec![
                "Try normal SpecGit inspect/dry-run first",
                "reproducible SpecGit defect blocks Issue selection",
                "command, version, exit and diagnostic",
                "Under existing user authorization",
                "authenticated native gh/glab",
                "search duplicate WHYs",
                "Why / Scope / Approach / Acceptance",
                "read back its native ID and body",
                "Only if that same defect still blocks its linked repair",
                "documented one-task local checkpoint exception",
                "restore normal checks after repair",
                "does not bypass user authorization, forge protection, CI, review, merge, Issue closure or publication",
            ],
        ),
        (
            Language::Zh,
            vec![
                "先正常尝试 SpecGit inspect/dry-run",
                "可复现的 SpecGit 缺陷阻碍 Issue 选择",
                "命令、版本、退出码与诊断",
                "已有用户授权",
                "已认证的原生 gh/glab",
                "查重 WHY",
                "原因、范围、方案和验收要求",
                "回读其原生 ID 和正文",
                "只有同一缺陷仍阻碍其关联修复",
                "有文档记录的单任务本地 checkpoint 例外",
                "修复后恢复正常检查",
                "不会绕过用户授权、forge 保护、CI、评审、合并、Issue 关闭或发布",
            ],
        ),
    ] {
        let declaration = Declaration {
            language,
            ..Declaration::default()
        };
        let prose = guidance::render(&declaration);
        for clause in clauses {
            assert!(prose.contains(clause), "missing {clause}");
        }
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().canonicalize().unwrap().join("AGENTS.md");
        let user = "User rules\r\nkeep exact\n";
        std::fs::write(&path, user).unwrap();
        let initial = guidance::change(&path, &declaration, &declaration, None).unwrap();
        let bytes = initial.after.unwrap();
        assert!(bytes.starts_with(user.as_bytes()));
        std::fs::write(&path, &bytes).unwrap();
        let refresh = guidance::change(&path, &declaration, &declaration, None).unwrap();
        assert_eq!(refresh.after.unwrap(), bytes);
    }
}
