//! Typed delivery facts shared by policy evaluation and native adapters.
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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RequiredCheck {
    pub name: String,
    pub app: Option<u64>,
}
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Requirements {
    pub checks: Vec<RequiredCheck>,
    pub pipeline_required: bool,
    pub approvals_required: u64,
    pub approvals_satisfied: bool,
    pub mergeable: bool,
}

#[derive(Debug, Clone, Copy, clap::ValueEnum, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Now,
    Auto,
}
#[derive(Debug, Clone, Copy, clap::ValueEnum, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Strategy {
    Merge,
    Squash,
    Rebase,
}

#[derive(Debug, serde::Serialize)]
pub struct Flow {
    pub target: String,
    pub native_default: String,
    pub targets_native_default: bool,
    pub issue_closing: &'static str,
    pub source_cleanup: &'static str,
    pub warnings: Vec<&'static str>,
}
#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceCleanup {
    Present,
    Deleted,
    Unknown,
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
    let source_cleanup = match facts.native_source_cleanup {
        Some(true) => "enabled_eligibility_unverified",
        Some(false) => {
            warnings.push("native_source_cleanup_disabled");
            "disabled"
        }
        None => {
            warnings.push("native_source_cleanup_unknown");
            "unknown"
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
        source_cleanup,
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
