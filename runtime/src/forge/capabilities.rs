//! Read-only native capability facts. Settings are observations, never authority.
use crate::{
    diagnostic::{Code, Diagnostic},
    probe::{ForgeRead, ProjectFacts, encode},
    project::Provider,
};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Support {
    Supported,
    Unsupported,
    Unknown,
}
#[derive(Debug, Serialize)]
pub struct Capability {
    pub status: Support,
    pub source: String,
    pub reason: String,
    pub diagnostic: Option<Diagnostic>,
}
impl Capability {
    fn new(status: Support, source: impl Into<String>, reason: &str) -> Self {
        Self {
            status,
            source: source.into(),
            reason: reason.into(),
            diagnostic: None,
        }
    }
    fn failed(source: String, diagnostic: Diagnostic) -> Self {
        Self {
            status: Support::Unknown,
            source,
            reason: "The native capability could not be read; no absence or support is inferred."
                .into(),
            diagnostic: Some(diagnostic),
        }
    }
}
#[derive(Debug, Serialize)]
pub struct NativeCapabilities {
    pub auto_merge: Capability,
    pub target_protection: Capability,
    pub issue_closing: Capability,
    pub request_eligibility: Capability,
}
impl NativeCapabilities {
    pub fn needs_choice(&self) -> bool {
        [
            self.auto_merge.status,
            self.target_protection.status,
            self.issue_closing.status,
        ]
        .into_iter()
        .any(|s| s != Support::Supported)
    }
}
fn boolean(value: Option<bool>, source: String, enabled: &str, disabled: &str) -> Capability {
    match value {
        Some(true) => Capability::new(Support::Supported, source, enabled),
        Some(false) => Capability::new(Support::Unsupported, source, disabled),
        None => Capability::new(
            Support::Unknown,
            source,
            "The response does not expose this setting as a boolean.",
        ),
    }
}
/// The current target comes from a verified request, declaration or native default.
pub async fn inspect(reader: &ForgeRead, facts: &ProjectFacts, target: &str) -> NativeCapabilities {
    let base = match reader.provider {
        Provider::Github => format!("repos/{}", facts.repository.path),
        Provider::Gitlab => format!("projects/{}", facts.id),
    };
    let auto_merge = if reader.provider == Provider::Github {
        match reader.get(&base).await {
            Ok(value)
                if value.get("id").and_then(Value::as_u64) == Some(facts.id)
                    && value
                        .get("full_name")
                        .and_then(Value::as_str)
                        .is_some_and(|name| name.eq_ignore_ascii_case(&facts.repository.path)) =>
            {
                boolean(
                    value.get("allow_auto_merge").and_then(Value::as_bool),
                    format!("GET {base}#allow_auto_merge"),
                    "The repository permits native auto-merge. Individual request eligibility and user authorization are separate.",
                    "Native auto-merge is disabled in this repository.",
                )
            }
            Ok(_) => Capability::new(
                Support::Unknown,
                format!("GET {base}"),
                "The capability response has no matching repository identity.",
            ),
            Err(d) => Capability::failed(format!("GET {base}"), d),
        }
    } else {
        // A project merge policy and a CLI version do not prove this instance's
        // request auto-merge API support. No write probe or version threshold.
        Capability::new(
            Support::Unknown,
            format!("GET {base}"),
            "GitLab project metadata does not prove instance/request auto-merge support; select manual observation or verify the native capability with an authorized administrator.",
        )
    };
    let endpoint = match reader.provider {
        Provider::Github => format!("{base}/branches/{}/protection", encode(target)),
        Provider::Gitlab => format!("{base}/protected_branches/{}", encode(target)),
    };
    let target_protection = match reader.get(&endpoint).await {
        Ok(value)
            if match reader.provider {
                Provider::Github => {
                    value.get("required_status_checks").is_some()
                        && value.get("enforce_admins").is_some()
                }
                Provider::Gitlab => {
                    value.get("name").and_then(Value::as_str) == Some(target)
                        && value
                            .get("merge_access_levels")
                            .is_some_and(Value::is_array)
                }
            } =>
        {
            Capability::new(
                Support::Supported,
                format!("GET {endpoint}"),
                "Target branch protection is readable. This is not an exhaustive ruleset, merge queue, approval or request-eligibility assessment; the native forge decides applicability.",
            )
        }
        Ok(_) => Capability::new(
            Support::Unknown,
            format!("GET {endpoint}"),
            "Target protection response lacks the expected native fields.",
        ),
        Err(d) => Capability::failed(format!("GET {endpoint}"), d),
    };
    let issue_closing = if target != facts.default_branch {
        Capability::new(
            Support::Unsupported,
            "native target/default branch comparison",
            "The target differs from the native default branch; ordinary closing references are not promised to close Issues.",
        )
    } else if reader.provider == Provider::Github {
        Capability::new(
            Support::Supported,
            "GitHub closing-reference semantics and verified default branch",
            "Closing references targeting the default branch can close linked Issues; actual association, permissions and post-merge closure must be read back.",
        )
    } else {
        boolean(
            facts.native_issue_closing,
            format!("GET {base}#autoclose_referenced_issues"),
            "The project enables referenced Issue closing; instance patterns and actual post-merge closure still require readback.",
            "The project disables automatic referenced Issue closing.",
        )
    };
    NativeCapabilities {
        auto_merge,
        target_protection,
        issue_closing,
        request_eligibility: Capability::new(
            Support::Unknown,
            "native request lifecycle",
            "Initialization cannot promise that a current or future request is eligible for auto-merge. The Agent inspects native request state under existing authorization.",
        ),
    }
}

pub async fn request_target(
    reader: &ForgeRead,
    context: &crate::project::Context,
    facts: &ProjectFacts,
) -> Result<Option<(u64, String)>, Diagnostic> {
    let Some(branch) = &context.branch else {
        return Ok(None);
    };
    let endpoint = match context.repository.provider {
        Provider::Github => format!(
            "repos/{}/pulls?state=open&head={}",
            context.repository.path,
            encode(&format!(
                "{}:{branch}",
                context.repository.path.split('/').next().unwrap_or("")
            ))
        ),
        Provider::Gitlab => format!(
            "projects/{}/merge_requests?state=opened&scope=all&source_branch={}",
            facts.id,
            encode(branch)
        ),
    };
    let rows = reader.list(&endpoint, None, 10).await?;
    let mut matches = vec![];
    for row in rows {
        let (source_id, source_branch, target_id, target, number) =
            match context.repository.provider {
                Provider::Github => (
                    row.pointer("/head/repo/id").and_then(Value::as_u64),
                    row.pointer("/head/ref").and_then(Value::as_str),
                    row.pointer("/base/repo/id").and_then(Value::as_u64),
                    row.pointer("/base/ref").and_then(Value::as_str),
                    row.get("number").and_then(Value::as_u64),
                ),
                Provider::Gitlab => (
                    row.get("source_project_id").and_then(Value::as_u64),
                    row.get("source_branch").and_then(Value::as_str),
                    row.get("target_project_id").and_then(Value::as_u64),
                    row.get("target_branch").and_then(Value::as_str),
                    row.get("iid").and_then(Value::as_u64),
                ),
            };
        if source_id.is_none() || source_branch.is_none() {
            return Err(Diagnostic::new(
                Code::MalformedResponse,
                "init_request",
                "Request source identity is unavailable.",
                "Inspect the current native requests before initialization.",
            ));
        }
        if source_id != Some(facts.id) || source_branch != Some(branch.as_str()) {
            continue;
        }
        if target_id != Some(facts.id)
            || target.is_none_or(|s| !crate::config::valid_branch(s))
            || number.is_none_or(|n| n == 0)
        {
            return Err(Diagnostic::new(
                Code::IdentityMismatch,
                "init_request",
                "Request target identity is unavailable or different.",
                "Select the intended repository and inspect its native requests.",
            ));
        }
        matches.push((number.unwrap(), target.unwrap().to_owned()));
    }
    if matches.len() > 1 {
        return Err(Diagnostic::new(
            Code::AmbiguousRequest,
            "init_request",
            "Several native requests match this source branch.",
            "Resolve the ambiguous request association before initialization.",
        ));
    }
    Ok(matches.pop())
}
