//! Pure policy evaluation. No process, filesystem, forge protocol or CLI report dependency.
use crate::{
    config::Declaration,
    delivery_model::{Check, Issue, PullRequest, RequiredCheck, Requirements},
    diagnostic::{Code, Diagnostic},
    spec::{self, Violation},
};
use serde::Serialize;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Accepted,
    InitialAdoption,
    Rejected,
    Completed,
    MergedIssuesOpen,
    Unknown,
    InvalidInput,
    Cancelled,
}
impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::InitialAdoption => "accepted_initial_adoption",
            Self::Rejected => "rejected",
            Self::Completed => "completed",
            Self::MergedIssuesOpen => "merged_issues_open",
            Self::Unknown => "unknown",
            Self::InvalidInput => "invalid_input",
            Self::Cancelled => "unknown",
        }
    }
}
#[derive(Debug, Serialize)]
pub struct DeclarationEvidence {
    pub source: &'static str,
    pub target_commit: String,
    pub approved_digest: String,
    pub candidate_digest: String,
    pub candidate_changed: bool,
    pub candidate_rules: Declaration,
}
#[derive(Debug, Default, Serialize)]
pub struct Evidence {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request: Option<PullRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_head: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approved_target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_issues: Option<Vec<u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_issues: Option<Vec<u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issues: Option<Vec<Issue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub declaration: Option<DeclarationEvidence>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spec_violations: Option<Vec<Violation>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_cleanup: Option<crate::delivery_model::SourceCleanup>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requirements: Option<Requirements>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required_checks: Option<Vec<RequiredCheck>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checks: Option<Vec<Check>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blockers: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow: Option<crate::delivery_model::Flow>,
}
#[derive(Debug)]
pub struct Assessment {
    pub status: Status,
    pub evidence: Box<Evidence>,
    pub diagnostics: Vec<Diagnostic>,
}
impl Assessment {
    pub fn accepted(&self) -> bool {
        matches!(self.status, Status::Accepted | Status::InitialAdoption)
    }
    pub fn exit(&self) -> u8 {
        match self.status {
            Status::Accepted | Status::InitialAdoption | Status::Completed => 0,
            Status::Rejected | Status::MergedIssuesOpen => 1,
            Status::InvalidInput => 2,
            Status::Cancelled => 130,
            Status::Unknown => 3,
        }
    }
    pub fn unavailable(d: Diagnostic) -> Self {
        Self {
            status: match d.exit() {
                1 => Status::Rejected,
                2 => Status::InvalidInput,
                130 => Status::Cancelled,
                _ => Status::Unknown,
            },
            evidence: Box::default(),
            diagnostics: vec![d],
        }
    }
    pub fn rejected(reason: &str, evidence: Evidence) -> Self {
        Self {
            status: Status::Rejected,
            evidence: Box::new(evidence),
            diagnostics: vec![Diagnostic::new(
                Code::EvidenceRejected,
                "finish",
                reason,
                "Resolve the reported native blockers and obtain fresh evidence.",
            )],
        }
    }
}
/// Identity checks are pure; acquisition uses this before following native references.
pub fn identity(
    request: &PullRequest,
    project_id: u64,
    head: &str,
    source: &str,
    target: &str,
) -> Result<(), Assessment> {
    if request.target_project != project_id
        || request.head != head
        || request.source != source
        || request.target != target
    {
        return Err(Assessment::rejected(
            "Request project/source/head/target differs from the selected worktree.",
            Evidence {
                request: Some(request.clone()),
                local_head: Some(head.into()),
                target: Some(target.into()),
                project_id: Some(project_id),
                ..Evidence::default()
            },
        ));
    }
    if request.source_project != project_id {
        return Err(Assessment::unavailable(Diagnostic::new(
            Code::UnsupportedOperation,
            "finish",
            "Fork source declaration/commit reads require separately verified repository identity.",
            "Use a same-project delivery until the fork observation capability is verified.",
        )));
    }
    Ok(())
}
pub struct SelectionIntent<'a> {
    pub issues: &'a [u64],
    pub unresolved: bool,
}
/// Validate authority and explicit associations without acquiring or mutating evidence.
pub fn associations(
    request: &PullRequest,
    rules: &Declaration,
    candidate: &Declaration,
    provider: crate::project::Provider,
    default_target: &str,
    selected: Option<SelectionIntent<'_>>,
) -> Result<std::collections::BTreeSet<u64>, Assessment> {
    let expected = rules.target.as_deref().unwrap_or(default_target);
    if expected != request.target
        || rules.provider.is_some_and(|p| p != provider)
        || candidate.provider.is_some_and(|p| p != provider)
    {
        return Err(Assessment::rejected(
            "Shared native declaration targets a different branch/provider.",
            Evidence {
                request: Some(request.clone()),
                approved_target: Some(expected.into()),
                ..Evidence::default()
            },
        ));
    }
    let ids = match spec::references(&request.body) {
        Ok(ids) if !ids.is_empty() => ids,
        _ => {
            return Err(Assessment::rejected(
                "Every deliberate native request association must resolve explicitly.",
                Evidence {
                    request: Some(request.clone()),
                    ..Evidence::default()
                },
            ));
        }
    };
    if let Some(selected) = selected
        && (selected.unresolved || selected.issues.iter().any(|id| !ids.contains(id)))
    {
        return Err(Assessment::rejected(
            "Selected issue intent and native references differ; explicit reconciliation is required.",
            Evidence {
                request: Some(request.clone()),
                native_issues: Some(ids.iter().copied().collect()),
                selected_issues: Some(selected.issues.to_vec()),
                ..Evidence::default()
            },
        ));
    }
    Ok(ids)
}
/// Complete observed inputs. Checks are deliberately absent for merged lifecycle facts.
pub struct Snapshot {
    pub request: PullRequest,
    pub issues: Vec<Issue>,
    pub rules: Declaration,
    pub declaration: DeclarationEvidence,
    pub dirty: bool,
    pub lifecycle: Lifecycle,
    pub flow: crate::delivery_model::Flow,
}
pub enum Lifecycle {
    Merged(crate::delivery_model::SourceCleanup),
    Open {
        requirements: Requirements,
        checks: Vec<Check>,
    },
}
/// Missing/changed observations cannot be silently turned into an empty successful snapshot.
pub fn assess(snapshot: Result<Snapshot, Diagnostic>) -> Assessment {
    let s = match snapshot {
        Ok(s) => s,
        Err(d) => return Assessment::unavailable(d),
    };
    // A caller cannot manufacture completeness with empty, duplicate or contradictory lifecycle facts.
    let referenced = spec::references(&s.request.body).ok();
    let observed: std::collections::BTreeSet<_> = s.issues.iter().map(|i| i.id).collect();
    let complete = referenced
        .is_some_and(|ids| !ids.is_empty() && ids == observed && observed.len() == s.issues.len())
        && match &s.lifecycle {
            Lifecycle::Merged(_) => s.request.state == "merged",
            Lifecycle::Open { .. } => s.request.state != "merged",
        };
    if !complete {
        return Assessment::unavailable(Diagnostic::new(
            Code::MalformedResponse,
            "finish",
            "Typed observation lacks exact associated issues or current-head lifecycle evidence.",
            "Acquire a fresh complete snapshot before assessment.",
        ));
    }
    let mut violations = spec::check(
        &s.rules,
        false,
        &s.request.title,
        &s.request.body,
        &s.request.labels,
    );
    for i in &s.issues {
        violations.extend(spec::check(&s.rules, true, &i.title, &i.body, &i.labels));
    }
    let initial = s.declaration.source == "initial_adoption";
    let mut evidence = Evidence {
        request: Some(s.request.clone()),
        issues: Some(s.issues.clone()),
        declaration: Some(s.declaration),
        spec_violations: Some(violations.clone()),
        flow: Some(s.flow),
        ..Evidence::default()
    };
    let (requirements, current_checks) = match s.lifecycle {
        Lifecycle::Merged(cleanup) => {
            evidence.source_cleanup = Some(cleanup);
            return if s.issues.iter().all(|i| i.state == "closed") {
                Assessment {
                    status: Status::Completed,
                    evidence: Box::new(evidence),
                    diagnostics: vec![],
                }
            } else {
                let mut a = Assessment::rejected(
                    "Native merge is confirmed but associated issues remain open.",
                    evidence,
                );
                a.status = Status::MergedIssuesOpen;
                a
            };
        }
        Lifecycle::Open {
            requirements,
            checks,
        } => (requirements, checks),
    };
    let mut required = requirements.checks.clone();
    for name in &s.rules.verification.required_checks {
        let c = RequiredCheck {
            name: name.clone(),
            app: None,
        };
        if !required.contains(&c) {
            required.push(c);
        }
    }
    let mut blockers = vec![];
    if s.dirty {
        blockers.push("local_worktree_dirty".into());
    }
    if s.request.draft {
        blockers.push("request_draft".into());
    }
    if !["open", "opened"].contains(&s.request.state.as_str()) {
        blockers.push("request_closed".into());
    }
    if !violations.is_empty() {
        blockers.push("spec_invalid".into());
    }
    if !requirements.approvals_satisfied {
        blockers.push("approvals_unsatisfied".into());
    }
    if !requirements.mergeable {
        blockers.push("native_merge_blocked".into());
    }
    if requirements.pipeline_required && !current_checks.iter().any(|c| c.source == "pipeline") {
        blockers.push("head_pipeline_missing".into());
    }
    for check in &required {
        let matches: Vec<_> = current_checks
            .iter()
            .filter(|c| c.name == check.name && check.app.is_none_or(|app| c.app == Some(app)))
            .collect();
        if matches.is_empty() {
            blockers.push(format!("check_missing:{}", check.name));
        } else if matches.iter().any(|c| !c.successful()) {
            blockers.push(format!("check_not_successful:{}", check.name));
        }
    }
    for check in &current_checks {
        if check.allow_failure {
            continue;
        }
        if check.status != "completed" {
            blockers.push(format!("check_pending:{}", check.name));
        } else if check.failed() {
            blockers.push(format!("check_failed:{}", check.name));
        }
    }
    let accepted = blockers.is_empty();
    evidence.requirements = Some(requirements);
    evidence.checks = Some(current_checks);
    evidence.required_checks = Some(required);
    evidence.blockers = Some(blockers);
    if accepted {
        Assessment {
            status: if initial {
                Status::InitialAdoption
            } else {
                Status::Accepted
            },
            evidence: Box::new(evidence),
            diagnostics: vec![],
        }
    } else {
        Assessment::rejected(
            "Current native evidence contains delivery blockers.",
            evidence,
        )
    }
}
