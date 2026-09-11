//! Typed native facts shared by concrete adapters and read-only observation.
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Issue {
    pub id: u64,
    pub title: String,
    pub body: String,
    pub labels: Vec<String>,
    pub state: String,
    pub updated_at: String,
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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Check {
    pub name: String,
    pub source: String,
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
            && crate::project::valid_oid(&self.head)
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
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
    } else if facts.repository.provider == crate::project::Provider::Github {
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
    pub repository: crate::project::Repository,
    pub default_branch: String,
    pub native_source_cleanup: Option<bool>,
    pub native_issue_closing: Option<bool>,
}
