//! Native facts and presentation normalization. No policy evaluation or write capability.
use crate::{
    delivery_context::Workspace,
    delivery_model::PullRequest,
    diagnostic::{Code, Diagnostic},
    forge, native_delivery,
    process::Process,
    selection, spec,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

pub use crate::observation_model::{
    AssociationSource, AutoMerge, CheckOutcome, Evidence, IssueAssociation, LocalApplicability,
    LocalApplicabilityReason, LocalApplicabilityStatus, Observation, Status, describe,
};

fn changed() -> Diagnostic {
    Diagnostic::new(
        Code::ConcurrentEdit,
        "observe",
        "Native request or related facts changed during observation.",
        "Read a fresh snapshot of the exact request.",
    )
}
pub async fn observe(request: Option<u64>, process: Process, cwd: &Path) -> Observation {
    observe_in_scope(request, Scope::Worktree, process, cwd).await
}
/// Read one exact request in the configured repository without applying it to this worktree.
pub async fn observe_explicit(request: u64, process: Process, cwd: &Path) -> Observation {
    observe_in_scope(Some(request), Scope::ExplicitReadOnly, process, cwd).await
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scope {
    Worktree,
    ExplicitReadOnly,
}
async fn observe_in_scope(
    request: Option<u64>,
    scope: Scope,
    process: Process,
    cwd: &Path,
) -> Observation {
    match Box::pin(execute(request, scope, process, cwd)).await {
        Ok(o) => o,
        Err(d) => Observation::unavailable(d),
    }
}
fn local_applicability(
    context: &crate::project::Context,
    local_target: &str,
    request: &PullRequest,
) -> LocalApplicability {
    let mut reasons = Vec::new();
    match context.branch.as_deref() {
        None => reasons.push(LocalApplicabilityReason::DetachedHead),
        Some(branch) if branch != request.source => {
            reasons.push(LocalApplicabilityReason::SourceBranchMismatch)
        }
        Some(_) => {}
    }
    if context.head != request.head {
        reasons.push(LocalApplicabilityReason::HeadMismatch);
    }
    if local_target != request.target {
        reasons.push(LocalApplicabilityReason::TargetMismatch);
    }
    let status = if reasons.is_empty() {
        LocalApplicabilityStatus::Applicable
    } else {
        LocalApplicabilityStatus::NotApplicable
    };
    LocalApplicability { status, reasons }
}
async fn execute(
    request: Option<u64>,
    scope: Scope,
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
    let selected_candidate = if let Some(number) = request {
        selection::read(&w.context).ok().flatten().filter(|s| {
            s.request == Some(number) && s.project_id == w.facts.id && s.target == w.target
        })
    } else {
        selection::read(&w.context)?
    };
    if scope == Scope::Worktree
        && request.is_none()
        && selected_candidate
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
    let number = if let Some(n) = request.or(selected_candidate.as_ref().and_then(|s| s.request)) {
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
    if r.target_project != w.facts.id || r.source_project != w.facts.id {
        return Err(Diagnostic::new(
            Code::IdentityMismatch,
            "observe",
            "The request belongs to another native project.",
            "Only observe requests returned by the configured repository; cross-project and fork reads are unsupported.",
        ));
    }
    if scope == Scope::Worktree
        && (Some(r.source.as_str()) != w.context.branch.as_deref() || r.target != w.target)
    {
        return Err(Diagnostic::new(
            Code::IdentityMismatch,
            "observe",
            "The request source/target is outside this worktree's observation scope.",
            "Use pr --status --request for same-repository read-only facts; watch and implicit observation remain bound to the local source and target.",
        ));
    }
    let selected = selected_candidate
        .filter(|selection| scope != Scope::ExplicitReadOnly || selection.target == r.target);
    let applicability = local_applicability(&w.context, &w.target, r);
    let mut evidence = Evidence {
        repository: Some(repo.clone()),
        project_id: Some(w.facts.id),
        request: Some(r.clone()),
        local_branch: w.context.branch.clone(),
        local_head: Some(w.context.head.clone()),
        target: Some(w.target.clone()),
        local_applicability: Some(applicability),
        auto_merge: Some(observed.auto_merge()),
        close_issues_after_merge: w.close_issues_after_merge(),
        ..Evidence::default()
    };
    let mut diagnostics = Vec::new();
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
    let body_ids = match spec::references(&r.body) {
        Ok(ids) => ids,
        Err(d) => {
            diagnostics.push(d);
            BTreeSet::new()
        }
    };
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
    if let Some(checks) = &evidence.checks
        && forge::checks(&w.reader, repo, &observed).await? != *checks
    {
        return Err(changed());
    }
    let mut result = describe(evidence);
    result.diagnostics = diagnostics;
    Ok(result)
}
