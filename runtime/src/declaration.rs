//! Pure v2 declaration types, parsing and validation.
//! This module performs no file access, process execution or forge operations.
use crate::{
    diagnostic::{Code, Diagnostic},
    identity::Provider,
    label_rules::label_name,
};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

pub const MAX_BYTES: usize = 1024 * 1024;
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq, clap::ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    #[default]
    En,
    Zh,
}
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Labels {
    #[default]
    Off,
    Kind,
    Project,
}
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Validation {
    #[serde(default)]
    pub titles: bool,
    #[serde(default)]
    pub labels: Labels,
    #[serde(default)]
    pub bodies: bool,
}
/// Stable IDs currently emitted by the read-only init report.
pub const INIT_CHECK_IDS: &[&str] = &[
    "project.identity",
    "forge.cli",
    "forge.read_access",
    "issue.duplicate_read",
    "issue.write_permission",
    "request.write_permission",
    "target.protection",
    "issue.closing",
    "request.eligibility",
    "auto_merge.setting",
];

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InitPolicy {
    /// A project can strengthen an init diagnostic, but cannot weaken a built-in requirement.
    #[serde(default)]
    pub required_checks: Vec<String>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Tag {
    #[serde(deserialize_with = "short_text::<_,64>")]
    pub name: String,
    #[serde(deserialize_with = "short_text::<_,6>")]
    pub color: String,
    #[serde(default, deserialize_with = "short_text::<_,100>")]
    pub description: String,
}
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Agent {
    #[serde(default)]
    pub native_auto_merge: bool,
    #[serde(default)]
    pub close_issues_after_merge: bool,
}
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Notification {
    Attention,
    Completed,
}
fn poll_default() -> u64 {
    15
}
fn wait_default() -> u64 {
    1800
}
fn notify_default() -> Vec<Notification> {
    vec![Notification::Attention, Notification::Completed]
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Observation {
    #[serde(default = "poll_default")]
    pub poll_seconds: u64,
    #[serde(default = "wait_default")]
    pub max_wait_seconds: u64,
    #[serde(default = "notify_default")]
    pub notify: Vec<Notification>,
}
impl Default for Observation {
    fn default() -> Self {
        Self {
            poll_seconds: poll_default(),
            max_wait_seconds: wait_default(),
            notify: notify_default(),
        }
    }
}
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Builtin,
    Repository,
    Inline,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Template {
    pub source: Source,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_sections"
    )]
    pub required_sections: Option<Vec<String>>,
}
impl Default for Template {
    fn default() -> Self {
        Self {
            source: Source::Builtin,
            path: None,
            body: None,
            title: None,
            required_sections: None,
        }
    }
}
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Templates {
    #[serde(default)]
    pub issue: Template,
    #[serde(default)]
    pub pr: Template,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Declaration {
    pub version: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<Provider>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default)]
    pub language: Language,
    #[serde(default)]
    pub validation: Validation,
    #[serde(default)]
    pub init_policy: InitPolicy,
    #[serde(default, deserialize_with = "tag_list")]
    pub tags: Vec<Tag>,
    #[serde(default)]
    pub templates: Templates,
    #[serde(default)]
    pub agent: Agent,
    #[serde(default)]
    pub observation: Observation,
}
impl Default for Declaration {
    fn default() -> Self {
        Self {
            version: 2,
            remote: None,
            provider: None,
            target: None,
            language: Language::En,
            validation: Validation::default(),
            init_policy: InitPolicy::default(),
            tags: vec![],
            templates: Templates::default(),
            agent: Agent::default(),
            observation: Observation::default(),
        }
    }
}
pub(crate) fn invalid() -> Diagnostic {
    Diagnostic::input(
        "Invalid v2 declaration: check keys, types, duplicate keys, selectors and documented bounds.",
    )
}
fn text(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.len() <= max && !s.chars().any(char::is_control)
}
pub fn relative_path(value: &str) -> Result<PathBuf, Diagnostic> {
    let p = Path::new(value);
    if value.len() > 4096
        || value.contains(['\\', ':'])
        || value.chars().any(char::is_control)
        || p.as_os_str().is_empty()
        || p.is_absolute()
        || p.components().any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(invalid());
    }
    Ok(p.to_path_buf())
}
fn unique_text(values: &[String], max: usize) -> bool {
    values.len() <= 100
        && values
            .iter()
            .enumerate()
            .all(|(i, v)| text(v, max) && !values[..i].contains(v))
}
impl Declaration {
    pub fn parse(bytes: &[u8]) -> Result<Self, Diagnostic> {
        if bytes.len() > MAX_BYTES {
            return Err(Diagnostic::new(
                Code::InputLimit,
                "configuration",
                "The declaration exceeds 1 MiB.",
                "Reduce the declaration size.",
            ));
        }
        // Direct typed deserialization rejects duplicate fields at every schema level.
        #[derive(Deserialize)]
        struct VersionOnly {
            version: u8,
        }
        // IgnoredAny skips unknown YAML events without expanding alias graphs.
        let version: VersionOnly = serde_yaml_ng::from_slice(bytes).map_err(|_| invalid())?;
        if version.version == 1 {
            return Err(Diagnostic::new(
                Code::MigrationRequired,
                "configuration",
                "A legacy v1 declaration requires explicit migration.",
                "Keep using the v1 executable or preview specgit migrate --config-file <v2.yaml>; no files were modified.",
            ));
        }
        let result: Self = serde_yaml_ng::from_slice(bytes).map_err(|error| {
            if error.to_string().contains("unknown field `verification`") {
                Diagnostic::new(Code::MigrationRequired, "configuration",
                    "The retired verification declaration cannot be used by the lightweight runtime.",
                    "Preserve the original file, remove verification.required_checks from a reviewed v2 declaration, and configure required checks on the native forge; SpecGit does not copy platform protection rules.")
            } else { invalid() }
        })?;
        result.validate()?;
        Ok(result)
    }
    pub fn validate(&self) -> Result<(), Diagnostic> {
        if self.version != 2 {
            return Err(invalid());
        }
        if self.remote.as_ref().is_some_and(|s| {
            !text(s, 255) || s.starts_with('-') || s.chars().any(char::is_whitespace)
        }) {
            return Err(invalid());
        }
        if self.target.as_ref().is_some_and(|s| !valid_branch(s)) {
            return Err(invalid());
        }
        let o = &self.observation;
        if !(1..=3600).contains(&o.poll_seconds)
            || o.max_wait_seconds < o.poll_seconds
            || o.max_wait_seconds > 86400
            || o.notify.len() > 2
            || o.notify
                .iter()
                .enumerate()
                .any(|(i, v)| o.notify[..i].contains(v))
        {
            return Err(invalid());
        }
        if self.tags.len() > 100
            || self.tags.iter().enumerate().any(|(i, t)| {
                !label_name(&t.name)
                    || t.color.len() != 6
                    || !t.color.bytes().all(|b| b.is_ascii_hexdigit())
                    || t.description.len() > 100
                    || t.description.chars().any(char::is_control)
                    || self.tags[..i].iter().any(|p| p.name == t.name)
            })
        {
            return Err(invalid());
        }
        if self.validation.labels == Labels::Project && self.tags.is_empty() {
            return Err(invalid());
        }
        if self.init_policy.required_checks.len() > INIT_CHECK_IDS.len()
            || self
                .init_policy
                .required_checks
                .iter()
                .enumerate()
                .any(|(i, id)| {
                    !INIT_CHECK_IDS.contains(&id.as_str())
                        || self.init_policy.required_checks[..i].contains(id)
                })
        {
            return Err(invalid());
        }
        for t in [&self.templates.issue, &self.templates.pr] {
            match t.source {
                Source::Builtin if t.path.is_none() && t.body.is_none() => {}
                Source::Repository if t.body.is_none() => {
                    relative_path(t.path.as_deref().ok_or_else(invalid)?)?;
                }
                Source::Inline
                    if t.path.is_none()
                        && t.body
                            .as_ref()
                            .is_some_and(|b| !b.trim().is_empty() && b.len() <= MAX_BYTES) => {}
                _ => return Err(invalid()),
            }
            if t.title.as_ref().is_some_and(|s| !text(s, 255))
                || t.required_sections
                    .as_ref()
                    .is_some_and(|s| s.is_empty() || !unique_text(s, 120))
            {
                return Err(invalid());
            }
        }
        Ok(())
    }
    pub fn bytes(&self) -> Result<Vec<u8>, Diagnostic> {
        self.validate()?;
        serde_yaml_ng::to_string(self)
            .map(String::into_bytes)
            .map_err(|_| invalid())
    }
}
pub fn valid_branch(s: &str) -> bool {
    text(s, 255)
        && s != "@"
        && !s.starts_with(['-', '/'])
        && !s.ends_with(['.', '/'])
        && !s.contains([' ', '~', '^', ':', '?', '*', '[', '\\'])
        && !s.contains("..")
        && !s.contains("@{")
        && !s.contains("//")
        && s.split('/')
            .all(|p| !p.starts_with('.') && !p.ends_with(".lock"))
}
fn short_text<'de, D: serde::Deserializer<'de>, const MAX: usize>(
    deserializer: D,
) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    if value.len() > MAX {
        return Err(serde::de::Error::custom("text exceeds its bound"));
    }
    Ok(value)
}
fn bounded_list<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
    valid: fn(&T) -> bool,
) -> Result<Vec<T>, D::Error> {
    struct List<T> {
        valid: fn(&T) -> bool,
    }
    impl<'de, T: Deserialize<'de>> serde::de::Visitor<'de> for List<T> {
        type Value = Vec<T>;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("at most 100 bounded values")
        }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Vec<T>, A::Error> {
            let mut out = vec![];
            while let Some(value) = seq.next_element()? {
                if out.len() >= 100 || !(self.valid)(&value) {
                    return Err(serde::de::Error::custom("list exceeds its bound"));
                }
                out.push(value);
            }
            Ok(out)
        }
    }
    deserializer.deserialize_seq(List { valid })
}
fn tag_list<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<Tag>, D::Error> {
    bounded_list(d, |_| true)
}

fn section_list<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    bounded_list(d, |s: &String| s.len() <= 120)
}
fn optional_sections<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Vec<String>>, D::Error> {
    #[derive(Deserialize)]
    struct Sections(#[serde(deserialize_with = "section_list")] Vec<String>);
    Option::<Sections>::deserialize(d).map(|s| s.map(|s| s.0))
}
