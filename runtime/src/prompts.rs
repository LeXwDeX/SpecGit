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
}
