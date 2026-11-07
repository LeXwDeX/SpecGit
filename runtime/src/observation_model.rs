//! Pure observation facts and lifecycle classification. No transport or writes.
use crate::{
    delivery_model::{Check, Issue, PullRequest},
    diagnostic::{Code, Diagnostic},
    identity::Repository,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Open,
    ClosedUnmerged,
    Merged,
    Completed,
    MergedIssuesOpen,
    Unknown,
    InvalidInput,
    Cancelled,
}
impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::ClosedUnmerged => "closed_unmerged",
            Self::Merged => "merged",
            Self::Completed => "completed",
            Self::MergedIssuesOpen => "merged_issues_open",
            Self::Unknown => "unknown",
            Self::InvalidInput => "invalid_input",
            Self::Cancelled => "cancelled",
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckOutcome {
    Unobserved,
    Pending,
    Passed,
    Completed,
    Failed,
}
pub use crate::delivery_model::AutoMerge;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AssociationSource {
    NativeClosing,
    BodyReference,
    LocalSelection,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalApplicabilityStatus {
    Applicable,
    NotApplicable,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalApplicabilityReason {
    DetachedHead,
    SourceBranchMismatch,
    HeadMismatch,
    TargetMismatch,
}
#[derive(Debug, Clone, Serialize)]
pub struct LocalApplicability {
    pub status: LocalApplicabilityStatus,
    pub reasons: Vec<LocalApplicabilityReason>,
}
#[derive(Debug, Serialize)]
pub struct IssueAssociation {
    pub issue: u64,
    pub sources: Vec<AssociationSource>,
}
/// Additive provider evidence. The public `Issue` construction contract stays
/// unchanged; the close reason is reported separately.
#[derive(Debug, Clone, Serialize)]
pub struct IssueStateReason {
    pub issue: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_reason: Option<String>,
}
#[derive(Debug, Default, Serialize)]
pub struct Evidence {
    pub repository: Option<Repository>,
    pub project_id: Option<u64>,
    pub request: Option<PullRequest>,
    pub local_branch: Option<String>,
    pub local_head: Option<String>,
    pub target: Option<String>,
    pub local_applicability: Option<LocalApplicability>,
    pub issues: Option<Vec<Issue>>,
    pub associations: Option<Vec<IssueAssociation>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue_state_reasons: Option<Vec<IssueStateReason>>,
    pub native_closing_available: bool,
    pub association_discrepancies: Vec<u64>,
    pub checks: Option<Vec<Check>>,
    pub auto_merge: Option<AutoMerge>,
    pub close_issues_after_merge: bool,
}
#[derive(Debug)]
pub struct Observation {
    pub status: Status,
    pub evidence: Box<Evidence>,
    pub diagnostics: Vec<Diagnostic>,
}
impl Observation {
    pub fn unavailable(d: Diagnostic) -> Self {
        let status = match d.exit() {
            2 => Status::InvalidInput,
            130 => Status::Cancelled,
            _ => Status::Unknown,
        };
        Self {
            status,
            evidence: Box::default(),
            diagnostics: vec![d],
        }
    }
    pub fn exit(&self) -> u8 {
        // Cancellation, invalid input and rejected evidence stay ahead of an
        // unknown lifecycle fact even when an optional diagnostic was appended.
        self.diagnostics
            .iter()
            .map(|d| d.exit())
            .max_by_key(|exit| crate::diagnostic::exit_priority(*exit))
            .unwrap_or(0)
    }
    pub fn checks_outcome(&self) -> CheckOutcome {
        let Some(checks) = self.evidence.checks.as_ref() else {
            return CheckOutcome::Unobserved;
        };
        if checks.is_empty() {
            return CheckOutcome::Unobserved;
        }
        if checks.iter().any(Check::failed) {
            return CheckOutcome::Failed;
        }
        if checks.iter().all(Check::successful) {
            CheckOutcome::Passed
        } else if checks.iter().all(|c| c.status == "completed") {
            CheckOutcome::Completed
        } else {
            CheckOutcome::Pending
        }
    }
}
/// A delivery is complete only when the request's own native closing set covers
/// every selected Issue and the provider's close reasons allow completion.
fn native_completion(evidence: &Evidence) -> bool {
    let Some(associations) = evidence.associations.as_deref() else {
        return false;
    };
    let native: std::collections::BTreeSet<u64> = associations
        .iter()
        .filter(|association| {
            association
                .sources
                .contains(&AssociationSource::NativeClosing)
        })
        .map(|association| association.issue)
        .collect();
    if !evidence.native_closing_available
        || !evidence.association_discrepancies.is_empty()
        || native.is_empty()
    {
        return false;
    }
    if !associations
        .iter()
        .filter(|association| {
            association
                .sources
                .contains(&AssociationSource::LocalSelection)
        })
        .all(|association| {
            association
                .sources
                .contains(&AssociationSource::NativeClosing)
        })
    {
        return false;
    }
    evidence
        .issue_state_reasons
        .as_deref()
        .is_none_or(|reasons| {
            reasons
                .iter()
                .filter(|reason| native.contains(&reason.issue))
                .all(|reason| matches!(reason.state_reason.as_deref(), None | Some("completed")))
        })
}
/// Describe only supplied native lifecycle facts; this cannot authorize merging.
pub fn describe(evidence: Evidence) -> Observation {
    let invalid = || {
        Diagnostic::new(
            Code::MalformedResponse,
            "observe",
            "The native snapshot contains unknown or contradictory identities or states.",
            "Read the exact native objects again; unknown facts are not successful observations.",
        )
    };
    let Some(request) = evidence.request.as_ref() else {
        return Observation::unavailable(invalid());
    };
    if request.id == 0
        || request.source_project == 0
        || request.target_project == 0
        || !crate::identity::valid_oid(&request.head)
        || !["open", "opened", "locked", "closed", "merged"].contains(&request.state.as_str())
        || evidence.issues.as_ref().is_some_and(|issues| {
            let mut ids = std::collections::BTreeSet::new();
            issues.iter().any(|i| {
                i.id == 0
                    || !ids.insert(i.id)
                    || !["open", "opened", "closed"].contains(&i.state.as_str())
            })
        })
        || evidence
            .checks
            .as_ref()
            .is_some_and(|checks| checks.iter().any(|c| !c.valid_for(request, checks)))
    {
        return Observation::unavailable(invalid());
    }
    if request.is_locked() {
        return Observation {
            status: Status::Unknown,
            evidence: Box::new(evidence),
            diagnostics: vec![crate::diagnostic::transient_locked()],
        };
    }
    let status = match evidence.request.as_ref().map(|r| r.state.as_str()) {
        Some("open" | "opened") => Status::Open,
        Some("closed") => Status::ClosedUnmerged,
        Some("merged") => match evidence.issues.as_deref() {
            Some(issues) if issues.iter().any(|i| i.state != "closed") => Status::MergedIssuesOpen,
            Some(issues) if !issues.is_empty() && native_completion(&evidence) => Status::Completed,
            _ => Status::Merged,
        },
        _ => Status::Unknown,
    };
    Observation {
        status,
        evidence: Box::new(evidence),
        diagnostics: vec![],
    }
}
