//! Default specification headings shared by body validation and template preparation.
use crate::declaration::Language;

pub fn sections(language: Language, issue: bool) -> Vec<String> {
    (match (language, issue) {
        (Language::En, true) => vec!["Why", "Scope", "Approach", "Acceptance"],
        (Language::En, false) => vec!["Why", "What changed", "Evidence", "Checklist"],
        (Language::Zh, true) => vec!["原因", "范围", "方案", "验收"],
        (Language::Zh, false) => vec!["原因", "变更", "证据", "检查清单"],
    })
    .into_iter()
    .map(String::from)
    .collect()
}
