//! Pure specification rules and explicit same-repository associations.
use crate::{
    config::{Declaration, Labels, Language, Tag},
    diagnostic::Diagnostic,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const KINDS: [(&str, &str); 14] = [
    ("feat", "0E8A16"),
    ("fix", "D93F0B"),
    ("refactor", "FBCA04"),
    ("perf", "6F42C1"),
    ("docs", "0075CA"),
    ("test", "0E8A16"),
    ("chore", "C5DEF5"),
    ("style", "BFD4F2"),
    ("build", "D4C5F9"),
    ("ci", "D4C5F9"),
    ("revert", "F9D0C4"),
    ("security", "B60205"),
    ("deprecate", "FEF2C0"),
    ("dogfood", "C2E0C6"),
];
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Violation {
    pub code: String,
    pub message: String,
}
fn violation(code: &str, message: &str) -> Violation {
    Violation {
        code: code.into(),
        message: message.into(),
    }
}
pub fn kind(title: &str) -> Result<&str, Diagnostic> {
    let (kind, rest) = title.split_once(": ").ok_or_else(|| {
        Diagnostic::input("Use a catalog Conventional Commit type followed by ': ' and a title.")
    })?;
    if rest.trim().is_empty() || !KINDS.iter().any(|(k, _)| *k == kind) {
        return Err(Diagnostic::input(
            "The title has an unknown type or empty summary.",
        ));
    }
    Ok(kind)
}
pub fn catalog(d: &Declaration) -> BTreeMap<String, Tag> {
    let mut tags: BTreeMap<_, _> = KINDS
        .iter()
        .map(|(name, color)| {
            let name = format!("kind::{name}");
            (
                name.clone(),
                Tag {
                    name,
                    color: (*color).into(),
                    description: String::new(),
                },
            )
        })
        .collect();
    tags.extend(d.tags.iter().cloned().map(|t| (t.name.clone(), t)));
    tags
}
/// Bounds/grammar are portable across both forge APIs, including comma-separated inputs.
pub fn label_name(s: &str) -> bool {
    let parts: Vec<_> = s.split("::").collect();
    !s.is_empty()
        && s.len() <= 64
        && parts.len() <= 2
        && parts.iter().all(|part| {
            part.split('-').all(|word| {
                !word.is_empty()
                    && word
                        .bytes()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            })
        })
}
pub fn selected_labels(
    d: &Declaration,
    title: &str,
    explicit: Option<&[String]>,
    pool: &[String],
) -> Result<Vec<String>, Diagnostic> {
    let values = match explicit {
        Some(labels) => labels.to_vec(),
        None if d.validation.labels == Labels::Kind => vec![format!("kind::{}", kind(title)?)],
        None => vec![],
    };
    let selected: BTreeSet<_> = values.into_iter().collect();
    let known = catalog(d);
    if selected.len() > 100
        || selected
            .iter()
            .any(|name| !label_name(name) || (!known.contains_key(name) && !pool.contains(name)))
    {
        return Err(Diagnostic::input(
            "Select labels from the declared vocabulary, built-in catalog or conforming existing pool.",
        ));
    }
    let labels: Vec<_> = selected.into_iter().collect();
    if axis_conflict(&labels) {
        return Err(Diagnostic::input(
            "Select at most one label per scoped axis.",
        ));
    }
    if let Some(error) = check_labels(d, &labels) {
        return Err(Diagnostic::input(&error.message));
    }
    Ok(labels)
}
pub fn check_labels(d: &Declaration, names: &[String]) -> Option<Violation> {
    if d.validation.labels == Labels::Off {
        return None;
    }
    if axis_conflict(names) {
        return Some(violation(
            "labels_axis_conflict",
            "Select at most one label per scoped axis.",
        ));
    }
    let kinds: BTreeSet<_> = KINDS.iter().map(|(k, _)| format!("kind::{k}")).collect();
    let allowed: BTreeSet<_> = d
        .tags
        .iter()
        .map(|t| t.name.clone())
        .chain(
            kinds
                .iter()
                .filter(|_| d.validation.labels == Labels::Kind)
                .cloned(),
        )
        .collect();
    if names.is_empty()
        || names.iter().any(|s| !allowed.contains(s))
        || (d.validation.labels == Labels::Kind
            && names.iter().filter(|s| kinds.contains(*s)).count() != 1)
    {
        return Some(violation(
            "labels_invalid",
            "Every label must follow the selected vocabulary; kind mode requires exactly one catalog kind.",
        ));
    }
    None
}
fn axis_conflict(names: &[String]) -> bool {
    let mut axes = BTreeSet::new();
    names
        .iter()
        .filter_map(|s| s.split_once("::").map(|p| p.0))
        .any(|axis| !axes.insert(axis))
}
/// Keep code as content while excluding fenced headings, references and placeholders.
pub fn prose(body: &str, code_evidence: bool) -> String {
    let mut out = vec![];
    let mut fence: Option<(char, usize)> = None;
    let mut code_present = false;
    let mut comment = false;
    for raw in body.lines() {
        let mut line = String::new();
        let mut rest = raw;
        while !rest.is_empty() {
            if comment {
                if let Some(i) = rest.find("-->") {
                    rest = &rest[i + 3..];
                    comment = false;
                } else {
                    break;
                }
            } else if let Some(i) = rest.find("<!--") {
                line.push_str(&rest[..i]);
                rest = &rest[i + 4..];
                comment = true;
            } else {
                line.push_str(rest);
                break;
            }
        }
        let trimmed = line.trim_start_matches(' ');
        let marker = trimmed.chars().next().filter(|c| *c == '`' || *c == '~');
        let run = marker
            .map(|c| trimmed.chars().take_while(|x| *x == c).count())
            .unwrap_or(0);
        let is_fence = line.len() - trimmed.len() <= 3 && run >= 3;
        if let Some((c, n)) = fence {
            if is_fence && marker == Some(c) && run >= n && trimmed[run..].trim().is_empty() {
                fence = None;
            } else if code_evidence && !code_present && !line.trim().is_empty() {
                out.push("[code evidence]".into());
                code_present = true;
            }
        } else if is_fence {
            fence = Some((marker.unwrap(), run));
            code_present = false;
        } else {
            out.push(line);
        }
    }
    out.join("\n")
}
pub fn check_body(d: &Declaration, issue: bool, body: &str) -> Option<Violation> {
    let template = if issue {
        &d.templates.issue
    } else {
        &d.templates.pr
    };
    if !d.validation.bodies && template.required_sections.is_none() {
        return None;
    }
    let text = prose(body, true);
    let headings = template
        .required_sections
        .clone()
        .unwrap_or_else(|| crate::templates::sections(d.language, issue));
    let mut sections: BTreeMap<String, String> = BTreeMap::new();
    let mut section: Option<String> = None;
    for line in text.lines() {
        if let Some(heading) = line.strip_prefix("## ") {
            let name = heading.trim().trim_end_matches('#').trim().to_lowercase();
            sections.entry(name.clone()).or_default();
            section = Some(name);
        } else if let Some(name) = &section {
            sections
                .entry(name.clone())
                .or_default()
                .push_str(&format!("{line}\n"));
        }
    }
    let missing = headings.iter().any(|h| {
        sections
            .get(&h.trim().to_lowercase())
            .is_none_or(|s| s.trim().is_empty())
    });
    let placeholder = text.contains("{{")
        || text.lines().any(|line| {
            let value = line
                .trim()
                .trim_start_matches(['-', '*'])
                .trim()
                .trim_end_matches(['.', '!', '。'])
                .trim();
            ["TODO", "TBD", "FIXME", "待补充", "待填写"]
                .iter()
                .any(|p| value.eq_ignore_ascii_case(p))
        });
    if text.trim().is_empty() || missing || placeholder {
        Some(violation(
            "body_content_incomplete",
            "Fill every required section and replace unfilled prose placeholders.",
        ))
    } else {
        None
    }
}
pub fn check_title(d: &Declaration, title: &str) -> Option<Violation> {
    if !d.validation.titles {
        return None;
    }
    static HAN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let han =
        HAN.get_or_init(|| regex::Regex::new(r"\p{Script=Han}").expect("fixed Unicode property"));
    if title.trim().is_empty() || (han.is_match(title) != (d.language == Language::Zh)) {
        Some(violation(
            "title_language_mismatch",
            "Follow the declared title character rule: zh requires Han; en excludes Han.",
        ))
    } else {
        None
    }
}
pub fn check(
    d: &Declaration,
    issue: bool,
    title: &str,
    body: &str,
    labels: &[String],
) -> Vec<Violation> {
    [
        (title.trim().is_empty() || title.len() > 255 || title.chars().any(char::is_control))
            .then(|| violation("title_invalid", "A native title must be nonempty, at most 255 UTF-8 bytes, without control characters.")),
        (body.len() > crate::config::MAX_BYTES).then(|| violation("body_too_large", "Native spec content exceeds 1 MiB.")),
        check_title(d, title),
        check_body(d, issue, body),
        check_labels(d, labels),
    ]
    .into_iter()
    .flatten()
    .collect()
}
/// Standalone native closing forms; unsupported closing-like prose fails closed.
pub fn references(body: &str) -> Result<BTreeSet<u64>, Diagnostic> {
    use std::sync::LazyLock;
    static EXACT: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)^(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+#([0-9]+)$").unwrap()
    });
    static CLOSING: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)\b(?:close[sd]?|closing|fix(?:es|ed|ing)?|resolve[sd]?|resolving)\s*:?\s*(?:#|https?://|[^\s]+#)").unwrap()
    });
    let mut refs = BTreeSet::new();
    for line in prose(body, false).lines() {
        let line = line.trim();
        if let Some(captures) = EXACT.captures(line) {
            let id = captures[1]
                .parse::<u64>()
                .ok()
                .filter(|n| *n > 0)
                .ok_or_else(|| {
                    Diagnostic::input(
                        "Closing references require positive issue IDs within the supported range.",
                    )
                })?;
            refs.insert(id);
        } else if CLOSING.is_match(line) {
            return Err(Diagnostic::input(
                "Reconcile unsupported closing references explicitly; use one same-repository 'Closes #n' association per line.",
            ));
        }
    }
    if refs.len() > 100 {
        return Err(Diagnostic::input("At most 100 issues may be associated."));
    }
    Ok(refs)
}
pub fn with_references(body: &str, issues: &[u64]) -> Result<String, Diagnostic> {
    let refs = references(body)?;
    let mut result = body.to_owned();
    let selected: BTreeSet<_> = issues.iter().copied().collect();
    for id in &selected {
        if *id == 0 {
            return Err(Diagnostic::input("Issue IDs must be positive."));
        }
        if !refs.contains(id) {
            result.push_str(&format!("\n\nCloses #{id}"));
        }
    }
    if result.len() > crate::config::MAX_BYTES {
        return Err(Diagnostic::input("Request body exceeds 1 MiB."));
    }
    let actual = references(&result)?;
    if !selected.is_subset(&actual) {
        return Err(Diagnostic::input(
            "An unclosed Markdown fence or comment hides required closing references.",
        ));
    }
    Ok(result)
}
