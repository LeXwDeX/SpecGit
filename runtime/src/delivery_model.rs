//! Typed native facts shared by concrete adapters and read-only observation.
use crate::identity::{Provider, Repository};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
pub struct Pagination {
    pub pages_fetched: usize,
    pub items_seen: usize,
    pub page_limit: usize,
    pub complete: bool,
}

pub struct CandidateRead {
    pub issues: Vec<Issue>,
    pub pagination: Pagination,
}

/// Open candidates plus bounded closed history. Kept separate so the public
/// `CandidateRead` construction contract is unchanged.
pub struct CandidateSearch {
    pub read: CandidateRead,
    pub history: Vec<HistoryIssue>,
    pub history_diagnostics: Vec<crate::diagnostic::Diagnostic>,
}

/// Closed search rows are reference evidence, never adoptable open candidates.
#[derive(Debug, Clone, Serialize)]
pub struct HistoryIssue {
    pub id: u64,
    pub title: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_reason: Option<String>,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Issue {
    pub id: u64,
    pub title: String,
    pub body: String,
    pub labels: Vec<String>,
    pub state: String,
    pub updated_at: String,
}

/// Fresh read context, never persisted in the selection or candidate digest.
#[derive(Debug, Clone, Serialize)]
pub struct IssueRead {
    pub issue: Issue,
    pub milestone: MilestoneContext,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum MilestoneContext {
    Linked { milestone: Milestone },
    None,
    Unknown { reason: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "provider", rename_all = "lowercase")]
pub enum Milestone {
    Github {
        id: u64,
        number: u64,
        title: String,
        state: String,
        url: String,
    },
    Gitlab {
        id: u64,
        iid: u64,
        title: String,
        state: String,
        scope: MilestoneScope,
        url: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MilestoneScope {
    Project { project_id: u64 },
    Group { group_id: u64 },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PullRequest {
    pub id: u64,
    pub title: String,
    pub body: String,
    pub labels: Vec<String>,
    pub state: String,
    pub draft: bool,
    pub head: String,
    pub source: String,
    pub target: String,
    pub source_project: u64,
    pub target_project: u64,
    pub updated_at: String,
}

impl PullRequest {
    /// GitLab may briefly report a merge request as `locked`. This is neither a
    /// settled lifecycle fact nor evidence that discussion locking is enabled.
    pub(crate) fn is_locked(&self) -> bool {
        self.state == "locked"
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Check {
    pub name: String,
    pub source: String,
    /// Actual tested commit; merged-result pipelines can differ from source head.
    pub tested_head: String,
    pub head: String,
    pub id: u64,
    pub app: Option<u64>,
    pub workflow: Option<u64>,
    pub workflow_attempt: Option<u64>,
    pub pipeline: Option<u64>,
    pub project: Option<u64>,
    pub status: String,
    pub conclusion: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub allow_failure: bool,
}
impl Check {
    /// Known native check identities must agree with the supplied request.
    pub fn valid_for(&self, request: &PullRequest, checks: &[Check]) -> bool {
        let positive = |n: Option<u64>| n.is_none_or(|n| n > 0);
        let valid_ids = self.id > 0
            && crate::identity::valid_oid(&self.head)
            && crate::identity::valid_oid(&self.tested_head)
            && (self.source == "pipeline" || self.tested_head == self.head)
            && [
                self.app,
                self.workflow,
                self.workflow_attempt,
                self.pipeline,
                self.project,
            ]
            .into_iter()
            .all(positive)
            && self.workflow.is_some() == self.workflow_attempt.is_some()
            && !(self.workflow.is_some() && self.pipeline.is_some())
            && (self.pipeline.is_none() || self.project.is_some())
            && (self.source != "pipeline" || self.pipeline == Some(self.id));
        if !valid_ids {
            return false;
        }
        if let Some(workflow) = self.workflow
            && checks.iter().any(|c| {
                c.workflow == Some(workflow) && c.workflow_attempt != self.workflow_attempt
            })
        {
            return false;
        }
        self.head == request.head
            && self
                .project
                .is_none_or(|id| id == request.source_project || id == request.target_project)
    }

    pub fn successful(&self) -> bool {
        self.status == "completed" && self.conclusion.as_deref() == Some("success")
    }
    pub fn failed(&self) -> bool {
        self.status == "completed"
            && !matches!(
                self.conclusion.as_deref(),
                Some("success" | "neutral" | "skipped")
            )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AutoMerge {
    Registered,
    NotRegistered,
    Unknown,
}

#[derive(Debug, serde::Serialize)]
pub struct Flow {
    pub target: String,
    pub native_default: String,
    pub targets_native_default: bool,
    pub issue_closing: &'static str,
    pub warnings: Vec<&'static str>,
}
pub fn flow(facts: &ProjectFacts, target: Option<&str>) -> Flow {
    let target = target.unwrap_or(&facts.default_branch).to_owned();
    let default = target == facts.default_branch;
    let mut warnings = vec![];
    if !default {
        warnings.push("non_default_target");
    }
    let issue_closing = if !default {
        "unsupported_target"
    } else if facts.repository.provider == crate::identity::Provider::Github {
        "default_target_references_supported"
    } else {
        match facts.native_issue_closing {
            Some(true) => "enabled_rules_unverified",
            Some(false) => {
                warnings.push("native_issue_closing_disabled");
                "disabled"
            }
            None => {
                warnings.push("native_issue_closing_unknown");
                "unknown"
            }
        }
    };
    if facts.native_issue_closing == Some(true) {
        warnings.push("native_closing_rules_unverified");
    }
    Flow {
        target,
        native_default: facts.default_branch.clone(),
        targets_native_default: default,
        issue_closing,
        warnings,
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectFacts {
    pub id: u64,
    pub repository: crate::identity::Repository,
    pub default_branch: String,
    pub native_source_cleanup: Option<bool>,
    pub native_issue_closing: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "provider", rename_all = "snake_case")]
pub enum ProjectRolePermissions {
    Github {
        has_issues: Option<bool>,
        admin: Option<bool>,
        maintain: Option<bool>,
        push: Option<bool>,
        triage: Option<bool>,
        pull: Option<bool>,
    },
    Gitlab {
        issues_enabled: Option<bool>,
        merge_requests_enabled: Option<bool>,
        project_access_level: Option<u64>,
        group_access_level: Option<u64>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Support {
    Supported,
    Unsupported,
    Unknown,
}

/// Project roles are read-only evidence, not token scopes or write authorization.
#[derive(Debug, Serialize)]
pub struct WritePermissions {
    pub issue: WritePermission,
    pub request: WritePermission,
}

#[derive(Debug, Serialize)]
pub struct WritePermission {
    pub status: Support,
    pub source: String,
    pub reason: String,
    pub remedy: String,
}

// A known sufficient role proves the role threshold. Missing roles cannot prove
// insufficiency; explicit false/null memberships can.
fn any_role(roles: &[Option<bool>]) -> Option<bool> {
    if roles.contains(&Some(true)) {
        Some(true)
    } else if roles.iter().all(Option::is_some) {
        Some(false)
    } else {
        None
    }
}

fn enabled_role(enabled: Option<bool>, role: Option<bool>) -> Option<bool> {
    match (enabled, role) {
        (Some(false), _) | (_, Some(false)) => Some(false),
        (Some(true), Some(true)) => Some(true),
        _ => None,
    }
}

/// Derive both permissions from the already fetched, identity-checked project.
/// No transport or cached evidence is used here.
pub fn write_permissions(
    repository: &Repository,
    roles: Option<&ProjectRolePermissions>,
) -> WritePermissions {
    let (issue, request, source, issue_remedy, request_remedy) = match (repository.provider, roles)
    {
        (
            Provider::Github,
            Some(ProjectRolePermissions::Github {
                has_issues,
                admin,
                maintain,
                push,
                triage,
                pull,
            }),
        ) => (
            enabled_role(
                *has_issues,
                any_role(&[*pull, *triage, *push, *maintain, *admin]),
            ),
            any_role(&[*push, *maintain, *admin]),
            format!(
                "GitHub project {} role permissions: permissions.pull/triage/push/maintain/admin; has_issues",
                repository.path
            ),
            "Enable Issues and obtain pull, triage, push, maintain or admin access before Issue writes.",
            "Obtain push, maintain or admin access before request writes.",
        ),
        (
            Provider::Gitlab,
            Some(ProjectRolePermissions::Gitlab {
                issues_enabled,
                merge_requests_enabled,
                project_access_level,
                group_access_level,
            }),
        ) => {
            let sufficient = |threshold| {
                any_role(&[
                    project_access_level.map(|level| level >= threshold),
                    group_access_level.map(|level| level >= threshold),
                ])
            };
            (
                enabled_role(*issues_enabled, sufficient(10)),
                enabled_role(*merge_requests_enabled, sufficient(30)),
                format!(
                    "GitLab project {} role permissions: permissions.project_access.access_level / permissions.group_access.access_level; issues_enabled / merge_requests_enabled",
                    repository.path
                ),
                "Enable Issues and obtain project or group access_level >= 10 before Issue writes.",
                "Enable merge requests and obtain project or group access_level >= 30 before MR writes.",
            )
        }
        _ => (
            None,
            None,
            "project permissions (role permissions unavailable)".into(),
            "Read the project's role permissions and Issue setting through the authenticated native CLI.",
            "Read the project's role permissions and request setting through the authenticated native CLI.",
        ),
    };
    let permission = |value, remedy: &str, labels: bool| {
        let status = match value {
            Some(true) => Support::Supported,
            Some(false) => Support::Unsupported,
            None => Support::Unknown,
        };
        let detail = match status {
            Support::Supported => "The project role permissions meet the basic write requirements.",
            Support::Unsupported => {
                "The project role permissions or enabled setting do not meet the basic write requirements."
            }
            Support::Unknown => {
                "Required project role permissions or settings are missing or unparseable; no support is inferred."
            }
        };
        let label_hint = if labels && repository.provider == Provider::Github {
            " Applying Issue labels needs triage or higher access."
        } else {
            ""
        };
        WritePermission {
            status,
            source: source.clone(),
            reason: format!(
                "{detail}{label_hint} Writes may still be rejected by fine-grained token scopes or branch protection; no write probe was performed."
            ),
            remedy: if status == Support::Supported {
                "Write only under existing authorization; recheck current native state and reconcile uncertain results by native readback.".into()
            } else if status == Support::Unknown {
                "Read the project's role permissions and enabled setting through the authenticated native CLI; missing fields do not establish write access.".into()
            } else {
                remedy.into()
            },
        }
    };
    WritePermissions {
        issue: permission(issue, issue_remedy, true),
        request: permission(request, request_remedy, false),
    }
}
