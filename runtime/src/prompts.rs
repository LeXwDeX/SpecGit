//! Embedded agent guidance. Text advises the agent; runtime boundaries enforce invariants.
use crate::declaration::Language;
use std::borrow::Cow;

fn canonical(resource: &'static str) -> Cow<'static, str> {
    if resource.contains("\r\n") {
        Cow::Owned(resource.replace("\r\n", "\n"))
    } else {
        Cow::Borrowed(resource)
    }
}

pub(crate) fn project(_language: Language) -> Cow<'static, str> {
    host_entry()
}

pub(crate) fn host_entry() -> Cow<'static, str> {
    canonical(include_str!("../assets/prompts/host-entry.md"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_resources_convert_crlf_without_changing_other_bytes() {
        assert_eq!(
            canonical("first\r\nsecond\nthird\r"),
            "first\nsecond\nthird\r"
        );
        assert_eq!(canonical("unchanged\n"), "unchanged\n");
    }

    #[test]
    fn embedded_resources_are_canonical_for_every_consumer() {
        for language in [Language::En, Language::Zh] {
            assert!(!project(language).contains('\r'));
        }
        assert!(!host_entry().contains('\r'));
    }

    #[test]
    fn entry_points_stay_short_and_do_not_duplicate_project_rules() {
        let host = host_entry();
        assert!(host.lines().count() <= 6, "setup is a Skill entry point");
        for language in [Language::En, Language::Zh] {
            let text = project(language);
            assert!(text.lines().count() <= 14, "init is a Skill entry point");
            for line in host.lines().filter(|line| !line.trim().is_empty()) {
                assert!(text.lines().any(|project_line| project_line == line));
            }
        }
        let skill = canonical(include_str!("../assets/SKILL.md"));
        assert!(skill.lines().count() <= 198, "keep one full workflow");
        assert!(skill.contains("Contract version: {{version}}."));
        let flat = skill.split_whitespace().collect::<Vec<_>>().join(" ");
        for rule in [
            "标签遵循 `validation.labels`：",
            "`kind` 从标题推导一个 `kind::<type>`",
            "`project` 要求声明的 `tags`",
            "`off` 仅在被要求时传 `--tags`",
        ] {
            assert!(flat.contains(rule), "{rule}");
        }
    }
}
