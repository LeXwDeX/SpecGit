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

/// Only native acquisition can construct downstream lineage. The pure evaluator
/// still checks every edge against the supplied current snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckLineage {
    CurrentHead,
    NativeDownstream(DownstreamIdentity),
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownstreamIdentity {
    links: Vec<PipelineLink>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
struct PipelineIdentity {
    head: String,
    project: u64,
    pipeline: u64,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PipelineLink {
    parent: PipelineIdentity,
    trigger: u64,
    child: PipelineIdentity,
}
impl PipelineIdentity {
    fn new(value: (&str, u64, u64)) -> Self {
        Self {
            head: value.0.into(),
            project: value.1,
            pipeline: value.2,
        }
    }
    fn matches(&self, check: &Check) -> bool {
        check.head == self.head
            && check.project == Some(self.project)
            && check.pipeline == Some(self.pipeline)
    }
}
impl PipelineLink {
    pub(crate) fn observed(
        parent: (&str, u64, u64),
        trigger: u64,
        child: (&str, u64, u64),
    ) -> Self {
        Self {
            parent: PipelineIdentity::new(parent),
            trigger,
            child: PipelineIdentity::new(child),
        }
    }
}
impl CheckLineage {
    pub(crate) fn downstream(links: Vec<PipelineLink>) -> Self {
        Self::NativeDownstream(DownstreamIdentity { links })
    }
}
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Check {
    #[serde(skip)]
    pub lineage: CheckLineage,
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
    /// Known check identities must agree even when assessment is called without a forge.
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
        match &self.lineage {
            CheckLineage::CurrentHead => {
                self.head == request.head
                    && self.project.is_none_or(|id| {
                        id == request.source_project || id == request.target_project
                    })
            }
            CheckLineage::NativeDownstream(proof) => {
                let Some(first) = proof.links.first() else {
                    return false;
                };
                let root = &first.parent;
                if root.head != request.head
                    || ![request.source_project, request.target_project].contains(&root.project)
                    || !checks.iter().any(|c| {
                        matches!(c.lineage, CheckLineage::CurrentHead)
                            && c.source == "pipeline"
                            && root.matches(c)
                    })
                {
                    return false;
                }
                let mut expected = root;
                let mut visited = std::collections::BTreeSet::from([(root.project, root.pipeline)]);
                for link in &proof.links {
                    if &link.parent != expected
                        || link.trigger == 0
                        || link.child.project == 0
                        || link.child.pipeline == 0
                        || !crate::project::valid_oid(&link.child.head)
                        || !visited.insert((link.child.project, link.child.pipeline))
                        || !checks.iter().any(|c| {
                            c.source == "trigger_jobs"
                                && c.id == link.trigger
                                && link.parent.matches(c)
                        })
                        || !checks
                            .iter()
                            .any(|c| c.source == "pipeline" && link.child.matches(c))
                    {
                        return false;
                    }
                    expected = &link.child;
                }
                expected.matches(self)
            }
        }
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
