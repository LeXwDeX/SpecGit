//! Embedded agent guidance. Text advises the agent; runtime boundaries enforce invariants.
use crate::declaration::Language;

pub(crate) fn project(language: Language) -> &'static str {
    match language {
        Language::En => include_str!("../assets/prompts/project-en.md"),
        Language::Zh => include_str!("../assets/prompts/project-zh.md"),
    }
}

pub(crate) const HOST_ENTRY: &str = include_str!("../assets/prompts/host-entry.md");
