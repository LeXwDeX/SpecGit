//! Native facts and presentation normalization. No policy evaluation or write capability.
use crate::{
    delivery_context::Workspace,
    delivery_model::{Check, Issue, PullRequest},
    diagnostic::{Code, Diagnostic},
    forge, native_delivery,
    process::Process,
    project::Repository,
    selection, spec,
};
use serde::Serialize;
use std::{collections::BTreeMap, path::Path};

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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
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
#[derive(Debug, Serialize)]
pub struct IssueAssociation {
    pub issue: u64,
    pub sources: Vec<AssociationSource>,
}
#[derive(Debug, Default, Serialize)]
pub struct Evidence {
    pub repository: Option<Repository>,
    pub project_id: Option<u64>,
    pub request: Option<PullRequest>,
    pub local_head: Option<String>,
    pub target: Option<String>,
    pub issues: Option<Vec<Issue>>,
    pub associations: Option<Vec<IssueAssociation>>,
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
        self.diagnostics.first().map_or(0, Diagnostic::exit)
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
        || !crate::project::valid_oid(&request.head)
        || !["open", "opened", "closed", "merged"].contains(&request.state.as_str())
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
    let status = match evidence.request.as_ref().map(|r| r.state.as_str()) {
        Some("open" | "opened") => Status::Open,
        Some("closed") => Status::ClosedUnmerged,
        Some("merged") => match evidence.issues.as_deref() {
            Some(issues) if issues.iter().any(|i| i.state != "closed") => Status::MergedIssuesOpen,
            Some(issues)
                if !issues.is_empty()
                    && evidence.native_closing_available
                    && evidence.association_discrepancies.is_empty() =>
            {
                Status::Completed
            }
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
fn changed() -> Diagnostic {
    Diagnostic::new(
        Code::ConcurrentEdit,
        "observe",
        "Native request or related facts changed during observation.",
        "Read a fresh snapshot of the exact request.",
    )
}
pub async fn observe(request: Option<u64>, process: Process, cwd: &Path) -> Observation {
    match Box::pin(execute(request, process, cwd)).await {
        Ok(o) => o,
        Err(d) => Observation::unavailable(d),
    }
}
async fn execute(
    request: Option<u64>,
    process: Process,
    cwd: &Path,
) -> Result<Observation, Diagnostic> {
    if request == Some(0) {
        return Err(Diagnostic::input("Request IDs must be positive."));
    }
    let w = Workspace::load(process, cwd).await?;
    let repo = &w.context.repository;
    // An explicit native identity does not depend on an unrelated local locator.
    // A usable matching checkpoint contributes provenance; it never gets repaired here.
    let selected = if let Some(number) = request {
        selection::read(&w.context).ok().flatten().filter(|s| {
            s.request == Some(number) && s.project_id == w.facts.id && s.target == w.target
        })
    } else {
        selection::read(&w.context)?
    };
    if selected
        .as_ref()
        .is_some_and(|s| s.project_id != w.facts.id || s.target != w.target)
    {
        return Err(Diagnostic::new(
            Code::IdentityMismatch,
            "observe",
            "The selection belongs to another project or target.",
            "Select the exact native request.",
        ));
    }
    let number = if let Some(n) = request.or(selected.as_ref().and_then(|s| s.request)) {
        n
    } else {
        let rows = native_delivery::request_candidates(&w.reader, repo, w.branch()?).await?;
        if rows.len() != 1 {
            return Err(Diagnostic::new(
                Code::AmbiguousRequest,
                "observe",
                "Observation requires one exact native request.",
                "Supply its --request ID after inspecting the candidates.",
            ));
        }
        rows[0].id
    };
    let observed = forge::request(&w.reader, repo, number).await?;
    let r = &observed.facts;
    if r.target_project != w.facts.id
        || r.source_project != w.facts.id
        || r.source != w.branch()?
        || r.target != w.target
    {
        return Err(Diagnostic::new(
            Code::IdentityMismatch,
            "observe",
            "The request does not belong to the selected project/source/target.",
            "Reconcile the exact native identity before observing.",
        ));
    }
    let mut evidence = Evidence {
        repository: Some(repo.clone()),
        project_id: Some(w.facts.id),
        request: Some(r.clone()),
        local_head: Some(w.context.head.clone()),
        target: Some(w.target.clone()),
        auto_merge: Some(observed.auto_merge()),
        close_issues_after_merge: w.close_issues_after_merge(),
        ..Evidence::default()
    };
    let mut diagnostics = Vec::new();
    let body_ids = spec::references(&r.body)?;
    let mut associations = BTreeMap::<u64, Vec<AssociationSource>>::new();
    let mut native_ids = None;
    match forge::closing_issues(&w.reader, repo, w.facts.id, number).await {
        Ok(ids) => {
            native_ids = Some(ids.clone());
            evidence.native_closing_available = true;
            for id in ids {
                associations
                    .entry(id)
                    .or_default()
                    .push(AssociationSource::NativeClosing);
            }
        }
        Err(d) => diagnostics.push(d),
    }
    for id in &body_ids {
        associations
            .entry(*id)
            .or_default()
            .push(AssociationSource::BodyReference);
    }
    if let Some(selected) = selected.as_ref().filter(|s| s.request == Some(number)) {
        evidence.association_discrepancies = selected
            .issues
            .iter()
            .copied()
            .filter(|id| !associations.contains_key(id))
            .collect();
        for id in &selected.issues {
            associations
                .entry(*id)
                .or_default()
                .push(AssociationSource::LocalSelection);
        }
    }
    if associations.len() > 100 {
        return Err(Diagnostic::new(
            Code::OutputLimit,
            "observe",
            "Too many issue associations for one bounded observation.",
            "Inspect native associations in bounded groups.",
        ));
    }
    let mut issues = Vec::new();
    for id in associations.keys() {
        issues.push(native_delivery::issue(&w.reader, repo, w.facts.id, *id).await?);
    }
    evidence.associations = Some(
        associations
            .into_iter()
            .map(|(issue, sources)| IssueAssociation { issue, sources })
            .collect(),
    );
    evidence.issues = Some(issues);
    if r.state != "merged" && r.state != "closed" {
        match forge::checks(&w.reader, repo, &observed).await {
            Ok(checks) => {
                if !checks.iter().all(|c| c.valid_for(r, &checks)) {
                    return Err(changed());
                }
                evidence.checks = Some(checks);
            }
            Err(d) => diagnostics.push(d),
        }
    }
    for issue in evidence.issues.iter().flatten() {
        if native_delivery::issue(&w.reader, repo, w.facts.id, issue.id).await? != *issue {
            return Err(changed());
        }
    }
    if let Some(ids) = native_ids
        && forge::closing_issues(&w.reader, repo, w.facts.id, number).await? != ids
    {
        return Err(changed());
    }
    if !forge::unchanged(&w.reader, repo, &observed).await? {
        return Err(changed());
    }
    w.unchanged().await?;
    let mut result = describe(evidence);
    result.diagnostics = diagnostics;
    Ok(result)
}
