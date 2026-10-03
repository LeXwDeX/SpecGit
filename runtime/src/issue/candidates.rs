//! Fresh duplicate evidence gates creation; inspection never changes native or local state.
use super::preparation::Prepared;
use super::*;
use std::time::Instant;

pub(super) fn creation_lock(
    options: &Options,
    p: &Prepared,
) -> Result<Option<crate::assets::AssetStore>, Diagnostic> {
    let w = &p.workspace;
    let selection = &p.selection;
    let lock = if !options.inspect
        && !options.dry_run
        && selection
            .intents
            .iter()
            .any(|i| i.issue.is_none() && !i.write_started)
    {
        let key = crate::assets::hash(
            &serde_json::to_vec(&(
                w.context.repository.provider,
                w.context.repository.host.to_lowercase(),
                w.facts.id,
            ))
            .map_err(|_| Diagnostic::input("Cannot encode issue creation identity."))?,
        );
        let base = w
            .context
            .common_dir
            .join("specgit-v2")
            .join("issue-creation")
            .join(key);
        Some(crate::assets::AssetStore::lock(
            &base,
            &[],
            std::time::Duration::from_secs(2),
        )?)
    } else {
        None
    };

    Ok(lock)
}

pub(super) async fn inspect(options: &Options, p: &Prepared) -> Result<Option<Report>, Diagnostic> {
    let w = &p.workspace;
    let selection = &p.selection;
    let pool = &p.pool;
    let mut candidate_reports = vec![];
    let mut matched_reviews = BTreeSet::new();
    for intent in selection.intents.iter().filter(|i| i.issue.is_none()) {
        let CandidateReview {
            evidence,
            review_digest,
            has_candidates,
        } = review(options, p, intent).await?;
        let reviewed = options.reviewed_candidates.contains(&review_digest);
        if reviewed {
            matched_reviews.insert(review_digest.clone());
        }
        if options.inspect || options.dry_run {
            candidate_reports.push(evidence);
            continue;
        }
        if intent.write_started {
            w.process.mark_inspection_incomplete();
            return Ok(Some(uncertain(evidence)));
        }
        if has_candidates && !reviewed {
            w.process.mark_inspection_incomplete();
            let mut report = Report::success("issue", "candidate_review_required", evidence);
            report.exit = 3;
            report.diagnostics.push(Diagnostic::new(Code::AmbiguousRequest, "issue", "Similar open issues require a WHY comparison before creation.", "Read the candidates and adopt the exact existing ID for the same WHY. For a distinct WHY, pass --reviewed-candidates with this exact review_digest; changed evidence requires a new review. Uncertain writes still require exact adoption."));
            return Ok(Some(report));
        }
    }
    w.process.ensure_inspection_budget("issue_preflight")?;
    if !options.inspect
        && !options.dry_run
        && options
            .reviewed_candidates
            .iter()
            .any(|digest| !matched_reviews.contains(digest))
    {
        return Err(Diagnostic::new(
            Code::ConcurrentEdit,
            "issue_candidates",
            "A candidate review no longer matches the proposed spec or current native candidates.",
            "Run --inspect, compare the current WHYs and use its current review_digest only for distinct work.",
        ));
    }
    let missing_labels: std::collections::BTreeSet<_> = selection
        .intents
        .iter()
        .filter(|i| i.issue.is_none())
        .flat_map(|i| &i.labels)
        .filter(|label| !pool.contains(label))
        .cloned()
        .collect();
    if options.inspect || options.dry_run {
        w.process.ensure_inspection_budget("issue_preflight")?;
        w.process.finish_inspection();
        if let Some(checkpoint) = &p.foreign_checkpoint {
            let mut report = Report::success(
                "issue",
                "prepared_blocked",
                serde_json::json!({"prepared":selection.intents,"adopted":selection.issues,"selection":selection,"candidates":candidate_reports,"writes":false,"write_eligible":false,"checkpoint":checkpoint,"repository":w.context.repository,"project_id":w.facts.id,"target":w.target,"new_branch":options.branch,"missing_labels":missing_labels,"label_creation_requested":options.create_labels}),
            );
            report.next_actions.push(serde_json::json!({"kind":"return_to_checkpoint_branch","branch":checkpoint.recorded_branch,"remedy":"Return to the recorded branch to resume the existing checkpoint."}));
            report.next_actions.push(serde_json::json!({"kind":"use_independent_worktree","remedy":"Use a separate worktree for this prepared delivery before performing writes."}));
            return Ok(Some(report));
        }
        return Ok(Some(Report::success(
            "issue",
            "prepared",
            serde_json::json!({"prepared":selection.intents,"adopted":selection.issues,"selection":selection,"candidates":candidate_reports,"writes":false,"repository":w.context.repository,"project_id":w.facts.id,"target":w.target,"new_branch":options.branch,"missing_labels":missing_labels,"label_creation_requested":options.create_labels}),
        )));
    }
    if !options.create_labels && !missing_labels.is_empty() {
        return Err(Diagnostic::new(
            Code::ConfirmationRequired,
            "issue",
            "Selected labels are missing from the native project.",
            "Inspect --dry-run and explicitly request --create-labels, or choose existing labels.",
        ));
    }
    Ok(None)
}

struct CandidateReview {
    evidence: serde_json::Value,
    review_digest: String,
    has_candidates: bool,
}

async fn review(
    options: &Options,
    p: &Prepared,
    intent: &IssueIntent,
) -> Result<CandidateReview, Diagnostic> {
    let w = &p.workspace;
    let selection = &p.selection;
    let pool = &p.pool;
    validate(
        w.specification(),
        &intent.title,
        &intent.body,
        &intent.labels,
    )?;
    w.specification()
        .selected_labels(&intent.title, Some(&intent.labels), pool)?;
    if w.context.repository.provider == project::Provider::Gitlab {
        templates::reject_quick_actions(&intent.body)?;
    }
    let started = Instant::now();
    let requests_before = w.process.inspection_requests_executed();
    let candidate_read =
        native_delivery::candidates(&w.reader, &w.context.repository, w.facts.id, &intent.title)
            .await?;
    w.process.ensure_inspection_budget("issue_preflight")?;
    let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    let requests_executed = w
        .process
        .inspection_requests_executed()
        .saturating_sub(requests_before);
    let mut candidates = candidate_read.issues;
    candidates.sort_by_key(|issue| issue.id);
    let review_digest = candidate_review_digest(
        &w.context.repository,
        w.facts.id,
        options.branch.as_deref().unwrap_or(&selection.branch),
        &w.target,
        intent,
        &candidates,
    );
    let evidence = serde_json::json!({"title":intent.title,"issues":candidates,"review_digest":review_digest,"elapsed_ms":elapsed_ms,"requests_executed":requests_executed,"pagination":candidate_read.pagination});
    Ok(CandidateReview {
        evidence,
        review_digest,
        has_candidates: !candidates.is_empty(),
    })
}
