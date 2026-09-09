use crate::{
    assets::safe_path,
    config::{Language, MAX_BYTES, Source, Template, relative_path},
    diagnostic::{Code, Diagnostic},
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, io::Read, path::Path};
#[derive(Debug, Serialize)]
pub struct Prepared {
    pub source: String,
    pub body: String,
    pub title: Option<String>,
    pub labels: Vec<String>,
    pub required_sections: Vec<String>,
}
#[derive(Debug, Serialize)]
pub struct Candidate {
    pub path: String,
    pub format: &'static str,
}
fn invalid(message: &str) -> Diagnostic {
    Diagnostic::input(message)
}
pub fn read_text(path: &Path) -> Result<String, Diagnostic> {
    safe_path(path)?;
    let mut bytes = vec![];
    crate::assets::open_regular(path)
        .map_err(|_| invalid("Selected template/body file is unavailable."))?
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid("Cannot read selected template/body file."))?;
    if bytes.len() > MAX_BYTES {
        return Err(Diagnostic::new(
            Code::InputLimit,
            "template",
            "Template/body content exceeds 1 MiB.",
            "Select bounded content.",
        ));
    }
    String::from_utf8(bytes).map_err(|_| invalid("Selected content must be UTF-8."))
}
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
pub fn substitute(template: &str, values: &BTreeMap<&str, String>) -> Result<String, Diagnostic> {
    let mut result = String::new();
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        result.push_str(&rest[..start]);
        let tail = &rest[start + 2..];
        let end = tail
            .find("}}")
            .ok_or_else(|| invalid("Unterminated template variable."))?;
        let key = tail[..end].trim();
        if !["title", "summary", "body", "delivery", "issues"].contains(&key) {
            return Err(invalid("Unknown template variable."));
        }
        result.push_str(values.get(key).map(String::as_str).unwrap_or(""));
        rest = &tail[end + 2..];
        if result.len() > MAX_BYTES {
            return Err(invalid("Expanded template exceeds its size allowance."));
        }
    }
    result.push_str(rest);
    if result.len() > MAX_BYTES {
        return Err(invalid("Expanded template exceeds its size allowance."));
    }
    Ok(result)
}
pub fn prepare(
    root: &Path,
    selector: &Template,
    language: Language,
    issue: bool,
    body_file: Option<&Path>,
    values: &BTreeMap<&str, String>,
) -> Result<Prepared, Diagnostic> {
    let required_sections = selector
        .required_sections
        .clone()
        .unwrap_or_else(|| sections(language, issue));
    let mut native_title = None;
    let mut labels = vec![];
    let (source, body) = if let Some(path) = body_file {
        ("body_file".into(), read_text(path)?)
    } else {
        let (source, raw) = match selector.source {
            Source::Builtin => (
                "builtin".into(),
                sections(language, issue)
                    .iter()
                    .map(|s| format!("## {s}\n\n<!-- Fill this section before submission. -->\n"))
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
            Source::Inline => (
                "inline".into(),
                selector
                    .body
                    .clone()
                    .ok_or_else(|| invalid("Inline content is missing."))?,
            ),
            Source::Repository => {
                let path = relative_path(
                    selector
                        .path
                        .as_deref()
                        .ok_or_else(|| invalid("Template path is missing."))?,
                )?;
                if path.extension().is_some_and(|e| e == "yml" || e == "yaml") {
                    return Err(Diagnostic::new(
                        Code::UnsupportedOperation,
                        "template",
                        "A native issue form is not a Markdown template.",
                        "Prepare explicit Markdown content; form interaction and native form validation remain unverified.",
                    ));
                }
                let raw = read_text(&root.join(&path))?;
                let (metadata, body) = markdown_metadata(&raw)?;
                native_title = metadata.title;
                labels = metadata.labels;
                (format!("repository:{}", path.display()), body)
            }
        };
        let body = if matches!(selector.source, Source::Repository) {
            raw
        } else {
            substitute(&raw, values)?
        };
        (source, body)
    };
    let title = selector
        .title
        .as_ref()
        .map(|s| substitute(s, values))
        .transpose()?
        .or(native_title);
    Ok(Prepared {
        source,
        body,
        title,
        labels,
        required_sections,
    })
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeMetadata {
    #[serde(default)]
    title: Option<String>,
    #[serde(default, deserialize_with = "metadata_labels")]
    labels: Vec<String>,
    #[serde(default, rename = "name")]
    _name: Option<String>,
    #[serde(default, rename = "about")]
    _about: Option<String>,
    // Assignment is a separate write, never authorized by selecting a template.
    #[serde(default)]
    assignees: Option<serde_yaml_ng::Value>,
}
fn metadata_labels<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Names {
        Text(String),
        List(Vec<String>),
    }
    Ok(match Names::deserialize(d)? {
        Names::Text(s) => s
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect(),
        Names::List(s) => s,
    })
}
fn markdown_metadata(raw: &str) -> Result<(NativeMetadata, String), Diagnostic> {
    let Some(rest) = raw
        .strip_prefix("---\n")
        .or_else(|| raw.strip_prefix("---\r\n"))
    else {
        return Ok((NativeMetadata::default(), raw.into()));
    };
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end_matches(['\r', '\n']) == "---" {
            let meta: NativeMetadata = serde_yaml_ng::from_str(&rest[..offset]).map_err(|_| {
                invalid("Invalid or unsupported native Markdown template metadata.")
            })?;
            if meta.assignees.as_ref().is_some_and(|v| match v {
                serde_yaml_ng::Value::Null => false,
                serde_yaml_ng::Value::String(s) => !s.trim().is_empty(),
                serde_yaml_ng::Value::Sequence(s) => !s.is_empty(),
                _ => true,
            }) {
                return Err(invalid(
                    "Template assignees require an explicit assignment operation.",
                ));
            }
            if meta.labels.len() > 100 || meta.labels.iter().any(|s| !crate::spec::label_name(s)) {
                return Err(invalid(
                    "Native template labels must follow portable label grammar.",
                ));
            }
            return Ok((meta, rest[offset + line.len()..].into()));
        }
        offset += line.len();
    }
    Err(invalid("Unterminated native Markdown template metadata."))
}
pub fn discover(root: &Path) -> Result<Vec<Candidate>, Diagnostic> {
    let mut out = vec![];
    let mut examined = 0usize;
    for relative in [
        ".github/ISSUE_TEMPLATE",
        ".github/PULL_REQUEST_TEMPLATE",
        ".gitlab/issue_templates",
        ".gitlab/merge_request_templates",
    ] {
        let path = root.join(relative);
        safe_path(&path)?;
        match fs::read_dir(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(invalid("Cannot inspect native template directory.")),
            Ok(entries) => {
                for entry in entries {
                    examined += 1;
                    if examined > 100 {
                        return Err(invalid(
                            "Native template discovery exceeds 100 examined entries; discovery is incomplete.",
                        ));
                    }
                    let entry = entry.map_err(|_| invalid("Cannot read native template entry."))?;
                    let p = entry.path();
                    safe_path(&p)?;
                    if entry
                        .file_type()
                        .map_err(|_| invalid("Cannot inspect native template entry."))?
                        .is_file()
                    {
                        let extension = p.extension().and_then(|e| e.to_str()).unwrap_or("");
                        if ["md", "yml", "yaml"].contains(&extension) {
                            out.push(Candidate {
                                path: p
                                    .strip_prefix(root)
                                    .map_err(|_| invalid("Invalid template path."))?
                                    .to_string_lossy()
                                    .into_owned(),
                                format: if extension == "md" {
                                    "markdown"
                                } else {
                                    "native_form_or_config"
                                },
                            });
                        }
                    }
                }
            }
        }
    }
    for relative in [
        "PULL_REQUEST_TEMPLATE.md",
        "docs/PULL_REQUEST_TEMPLATE.md",
        ".github/PULL_REQUEST_TEMPLATE.md",
    ] {
        let p = root.join(relative);
        safe_path(&p)?;
        if p.is_file() {
            out.push(Candidate {
                path: relative.into(),
                format: "markdown",
            });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}
/// Server-side quick actions are writes; a selected template is not authorization.
pub fn reject_quick_actions(body: &str) -> Result<(), Diagnostic> {
    if body.lines().any(|line| {
        let s = line.trim_start();
        s.starts_with('/') && s.chars().nth(1).is_some_and(|c| c.is_ascii_alphabetic())
    }) {
        return Err(invalid(
            "GitLab quick actions require separate explicit authorization; remove them from submitted content.",
        ));
    }
    Ok(())
}
