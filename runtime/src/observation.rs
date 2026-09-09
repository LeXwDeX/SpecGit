//! Read-only acquisition and freshness verification, independent of CLI presentation.
use crate::{
    assessment::{self, Assessment, DeclarationEvidence, Lifecycle, Snapshot},
    config::Declaration,
    delivery_context::Workspace,
    diagnostic::{Code, Diagnostic},
    forge, native_delivery, native_file,
    process::Process,
    selection,
};
use sha2::{Digest, Sha256};
use std::path::Path;
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub async fn observe(request: Option<u64>, process: Process, cwd: &Path) -> Assessment {
    match Box::pin(execute(request, process, cwd)).await {
        Ok(a) => a,
        Err(d) => assessment::assess(Err(d)),
    }
}
fn changed() -> Diagnostic {
    Diagnostic::new(
        Code::ConcurrentEdit,
        "finish",
        "Native head, target, rules or check attempts changed during observation.",
        "Read a fresh complete snapshot before acceptance.",
    )
}
async fn execute(
    request: Option<u64>,
    process: Process,
    cwd: &Path,
) -> Result<Assessment, Diagnostic> {
    if request == Some(0) {
        return Err(Diagnostic::input("Request IDs must be positive."));
    }
    let w = Workspace::load(process, cwd).await?;
    let repo = &w.context.repository;
    let selected = selection::read(&w.context)?;
    if selected
        .as_ref()
        .is_some_and(|s| s.project_id != w.facts.id || s.target != w.target)
    {
        return Err(Diagnostic::new(
            Code::IdentityMismatch,
            "finish",
            "The local selection belongs to a different native project or target.",
            "Reconcile the exact native request and current selection before acceptance.",
        ));
    }
    let number = if let Some(n) = request.or(selected.as_ref().and_then(|s| s.request)) {
        n
    } else {
        let rows = native_delivery::request_candidates(&w.reader, repo, w.branch()?).await?;
        if rows.len() != 1 {
            return Err(Diagnostic::new(
                Code::AmbiguousRequest,
                "finish",
                "Observation requires one exact native request.",
                "Select its exact --request ID after inspecting native candidates.",
            ));
        }
        rows[0].id
    };
    let observed = forge::request(&w.reader, repo, number).await?;
    let r = observed.facts.clone();
    if let Err(a) = assessment::identity(&r, w.facts.id, &w.context.head, w.branch()?, &w.target) {
        return Ok(a);
    }
    let target = native_delivery::branch_head(&w.reader, repo, &r.target).await?;
    let approved = native_file::root_file(&w.reader, repo, &target, ".specgit.yaml").await?;
    let candidate = native_file::root_file(&w.reader, repo, &r.head, ".specgit.yaml").await?;
    let source = candidate.bytes.as_deref().ok_or_else(|| {
        Diagnostic::new(
            Code::MalformedResponse,
            "finish",
            "The current pushed head has no shared v2 declaration.",
            "Commit the shared project declaration before native acceptance.",
        )
    })?;
    let candidate_rules = Declaration::parse(source)?;
    let initial_adoption = approved.bytes.is_none();
    let approved_bytes = approved.bytes.as_deref().unwrap_or(source);
    let rules = Declaration::parse(approved_bytes)?;
    let selected_intent = selected.as_ref().map(|s| assessment::SelectionIntent {
        issues: &s.issues,
        unresolved: s.intents.iter().any(|i| i.issue.is_none()),
    });
    let ids = match assessment::associations(
        &r,
        &rules,
        &candidate_rules,
        repo.provider,
        &w.facts.default_branch,
        selected_intent,
    ) {
        Ok(ids) => ids,
        Err(a) => return Ok(a),
    };
    let mut issues = vec![];
    for id in ids {
        issues.push(native_delivery::issue(&w.reader, repo, w.facts.id, id).await?);
    }
    let declaration = DeclarationEvidence {
        source: if initial_adoption {
            "initial_adoption"
        } else {
            "target_revision"
        },
        target_commit: target.clone(),
        approved_digest: digest(approved_bytes),
        candidate_digest: digest(source),
        candidate_changed: source != approved_bytes,
        candidate_rules,
    };
    let lifecycle = if r.state == "merged" {
        Lifecycle::Merged(forge::source_cleanup(&w.reader, repo, &r.source).await?)
    } else {
        let requirements = forge::requirements(&w.reader, repo, &observed).await?;
        let checks = forge::checks(&w.reader, repo, &observed).await?;
        if forge::checks(&w.reader, repo, &observed).await? != checks
            || forge::requirements(&w.reader, repo, &observed).await? != requirements
        {
            return Err(changed());
        }
        Lifecycle::Open {
            requirements: requirements.facts,
            checks,
        }
    };
    for issue in &issues {
        if native_delivery::issue(&w.reader, repo, w.facts.id, issue.id).await? != *issue {
            return Err(changed());
        }
    }
    if !forge::unchanged(&w.reader, repo, &observed).await?
        || native_delivery::branch_head(&w.reader, repo, &r.target).await? != target
    {
        return Err(changed());
    }
    w.unchanged().await?;
    Ok(assessment::assess(Ok(Snapshot {
        request: r,
        issues,
        rules,
        declaration,
        dirty: w.context.dirty,
        lifecycle,
        flow: crate::delivery_model::flow(&w.facts, Some(&w.target)),
    })))
}
