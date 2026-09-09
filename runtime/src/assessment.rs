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
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Blocker {
    LocalWorktreeDirty,
    RequestDraft,
    RequestClosed,
    SpecInvalid,
    ApprovalsUnsatisfied,
    NativeMergeBlocked,
    HeadPipelineMissing,
    CheckMissing(String),
    CheckNotSuccessful(String),
    CheckPending(String),
    CheckFailed(String),
}
impl Blocker {
    fn blocks_checks(&self) -> bool {
        matches!(
            self,
            Self::HeadPipelineMissing
                | Self::CheckMissing(_)
                | Self::CheckNotSuccessful(_)
                | Self::CheckPending(_)
                | Self::CheckFailed(_)
        )
    }
}
impl std::fmt::Display for Blocker {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::LocalWorktreeDirty => f.write_str("local_worktree_dirty"),
            Self::RequestDraft => f.write_str("request_draft"),
            Self::RequestClosed => f.write_str("request_closed"),
            Self::SpecInvalid => f.write_str("spec_invalid"),
            Self::ApprovalsUnsatisfied => f.write_str("approvals_unsatisfied"),
            Self::NativeMergeBlocked => f.write_str("native_merge_blocked"),
            Self::HeadPipelineMissing => f.write_str("head_pipeline_missing"),
            Self::CheckMissing(name) => write!(f, "check_missing:{name}"),
            Self::CheckNotSuccessful(name) => write!(f, "check_not_successful:{name}"),
            Self::CheckPending(name) => write!(f, "check_pending:{name}"),
            Self::CheckFailed(name) => write!(f, "check_failed:{name}"),
        }
    }
}
impl Serialize for Blocker {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckOutcome {
    Unobserved,
    Pending,
    Passed,
    Failed,
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
    pub blockers: Option<Vec<Blocker>>,
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
    pub fn checks_outcome(&self) -> CheckOutcome {
        let evidence = &self.evidence;
        let blockers = evidence.blockers.as_deref().unwrap_or(&[]);
        let required_failure = evidence.required_checks.iter().flatten().any(|required| {
            evidence.checks.iter().flatten().any(|check| {
                check.name == required.name
                    && required.app.is_none_or(|app| check.app == Some(app))
                    && check.status == "completed"
                    && !check.successful()
            })
        });
        if required_failure
            || (self.status == Status::Rejected && evidence.checks.is_none())
            || blockers
                .iter()
                .any(|b| matches!(b, Blocker::CheckFailed(_) | Blocker::SpecInvalid))
        {
            CheckOutcome::Failed
        } else if evidence.checks.is_none() {
            CheckOutcome::Unobserved
        } else if blockers.iter().any(Blocker::blocks_checks) {
            CheckOutcome::Pending
        } else {
            CheckOutcome::Passed
        }
    }
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
            Lifecycle::Open { checks, .. } => {
                s.request.state != "merged"
                    && checks
                        .iter()
                        .all(|check| check.valid_for(&s.request, checks))
            }
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
        blockers.push(Blocker::LocalWorktreeDirty);
    }
    if s.request.draft {
        blockers.push(Blocker::RequestDraft);
    }
    if !["open", "opened"].contains(&s.request.state.as_str()) {
        blockers.push(Blocker::RequestClosed);
    }
    if !violations.is_empty() {
        blockers.push(Blocker::SpecInvalid);
    }
    if !requirements.approvals_satisfied {
        blockers.push(Blocker::ApprovalsUnsatisfied);
    }
    if !requirements.mergeable {
        blockers.push(Blocker::NativeMergeBlocked);
    }
    if requirements.pipeline_required && !current_checks.iter().any(|c| c.source == "pipeline") {
        blockers.push(Blocker::HeadPipelineMissing);
    }
    for check in &required {
        let matches: Vec<_> = current_checks
            .iter()
            .filter(|c| c.name == check.name && check.app.is_none_or(|app| c.app == Some(app)))
            .collect();
        if matches.is_empty() {
            blockers.push(Blocker::CheckMissing(check.name.clone()));
        } else if matches.iter().any(|c| !c.successful()) {
            blockers.push(Blocker::CheckNotSuccessful(check.name.clone()));
        }
    }
    for check in &current_checks {
        if check.allow_failure {
            continue;
        }
        if check.status != "completed" {
            blockers.push(Blocker::CheckPending(check.name.clone()));
        } else if check.failed() {
            blockers.push(Blocker::CheckFailed(check.name.clone()));
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

#[cfg(test)]
mod lineage_tests {
    use super::*;
    use crate::delivery_model::{CheckLineage, Flow, PipelineLink};

    fn snapshot() -> Snapshot {
        let head = "a".repeat(40);
        let child_head = "f".repeat(40);
        let check = |source: &str, id, project, pipeline, sha: &str, lineage| Check {
            lineage,
            name: format!("{source}:{project}/{id}"),
            source: source.into(),
            head: sha.into(),
            id,
            app: None,
            workflow: None,
            workflow_attempt: None,
            pipeline: Some(pipeline),
            project: Some(project),
            status: "completed".into(),
            conclusion: Some("success".into()),
            started_at: None,
            completed_at: None,
            allow_failure: false,
        };
        let root = check("pipeline", 71, 7, 71, &head, CheckLineage::CurrentHead);
        let trigger = check("trigger_jobs", 91, 7, 71, &head, CheckLineage::CurrentHead);
        let child = check(
            "pipeline",
            72,
            8,
            72,
            &child_head,
            CheckLineage::downstream(vec![PipelineLink::observed(
                (&head, 7, 71),
                91,
                (&child_head, 8, 72),
            )]),
        );
        let rules = Declaration::parse(b"version: 2\n").unwrap();
        Snapshot {
            request: PullRequest {
                id: 2,
                title: "feat: source".into(),
                body: "Closes #1".into(),
                labels: vec![],
                state: "open".into(),
                draft: false,
                head,
                source: "feature".into(),
                target: "main".into(),
                source_project: 7,
                target_project: 7,
                updated_at: "2026-09-09T00:00:00Z".into(),
            },
            issues: vec![Issue {
                id: 1,
                title: "feat: source".into(),
                body: "source".into(),
                labels: vec![],
                state: "open".into(),
                updated_at: "2026-09-09T00:00:00Z".into(),
            }],
            declaration: DeclarationEvidence {
                source: "target_revision",
                target_commit: "b".repeat(40),
                approved_digest: "c".repeat(64),
                candidate_digest: "c".repeat(64),
                candidate_changed: false,
                candidate_rules: rules.clone(),
            },
            rules,
            dirty: false,
            lifecycle: Lifecycle::Open {
                requirements: Requirements {
                    checks: vec![],
                    pipeline_required: true,
                    approvals_required: 0,
                    approvals_satisfied: true,
                    mergeable: true,
                },
                checks: vec![root, trigger, child],
            },
            flow: Flow {
                target: "main".into(),
                native_default: "main".into(),
                targets_native_default: true,
                issue_closing: "unknown",
                source_cleanup: "unknown",
                warnings: vec![],
            },
        }
    }
    #[test]
    fn verified_cross_project_different_head_descendants_keep_their_native_result() {
        let accepted = assess(Ok(snapshot()));
        assert_eq!(accepted.status, Status::Accepted);
        let child = &accepted.evidence.checks.as_ref().unwrap()[2];
        assert_eq!(child.head, "f".repeat(40));
        assert_eq!(child.project, Some(8));
        let mut s = snapshot();
        if let Lifecycle::Open { checks, .. } = &mut s.lifecycle {
            checks[2].conclusion = Some("failure".into());
        }
        let rejected = assess(Ok(s));
        assert_eq!(rejected.status, Status::Rejected);
        assert_eq!(rejected.checks_outcome(), CheckOutcome::Failed);
    }
    #[test]
    fn missing_or_contradictory_parent_links_are_unknown() {
        for change in 0..5 {
            let mut s = snapshot();
            if let Lifecycle::Open { checks, .. } = &mut s.lifecycle {
                match change {
                    0 => {
                        checks.remove(1);
                    }
                    1 => checks[2].lineage = CheckLineage::CurrentHead,
                    2 => checks[2].lineage = CheckLineage::downstream(vec![]),
                    3 => {
                        checks[2].lineage = CheckLineage::downstream(vec![PipelineLink::observed(
                            (&s.request.head, 7, 70),
                            91,
                            (&"f".repeat(40), 8, 72),
                        )])
                    }
                    _ => {
                        checks[2].lineage = CheckLineage::downstream(vec![PipelineLink::observed(
                            (&s.request.head, 7, 71),
                            92,
                            (&"f".repeat(40), 8, 72),
                        )])
                    }
                }
            }
            assert_eq!(assess(Ok(s)).status, Status::Unknown, "variant {change}");
        }
    }
}
