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

pub(crate) fn project(language: Language) -> Cow<'static, str> {
    canonical(match language {
        Language::En => include_str!("../assets/prompts/project-en.md"),
        Language::Zh => include_str!("../assets/prompts/project-zh.md"),
    })
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
                assert!(!text.lines().any(|project_line| project_line == line));
            }
        }
        let skill = canonical(include_str!("../assets/SKILL.md"));
        assert!(skill.lines().count() <= 198, "keep one full workflow");
        assert!(skill.contains("Contract version: {{version}}."));
    }
}
