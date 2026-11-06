//! Persist creation intents and locators before fallible native readback.
use super::preparation::Prepared;
use super::*;

pub(super) async fn discard_uncertain(
    options: &Options,
    process: Process,
    cwd: &Path,
    effects: &mut Effects,
) -> Result<Report, Diagnostic> {
    let w = Workspace::load_issue(process, cwd).await?;
    let mut lock = Locked::acquire(&w.context)?;
    let mut selected = selection::read(&w.context)?
        .ok_or_else(|| Diagnostic::input("No checkpoint has an uncertain issue creation."))?;
    if selected.project_id != w.facts.id || selected.target != w.target {
        return Err(Diagnostic::input(
            "The selected delivery project or target changed.",
        ));
    }
    let pending: Vec<_> = selected
        .intents
        .iter()
        .enumerate()
        .filter(|(_, intent)| intent.write_started && intent.issue.is_none())
        .map(|(index, _)| index)
        .collect();
    if pending.is_empty() {
        return Err(Diagnostic::input(
            "No checkpoint has an uncertain issue creation.",
        ));
    }
    let mut evidence = Vec::new();
    for &index in &pending {
        let intent = &selected.intents[index];
        let candidates = native_delivery::candidate_search(
            &w.reader,
            &w.context.repository,
            w.facts.id,
            &intent.title,
        )
        .await?;
        if let Some(error) = candidates.history_diagnostics.into_iter().next() {
            return Err(error);
        }
        if !candidates.read.pagination.complete {
            return Err(Diagnostic::input("Issue candidate read is incomplete."));
        }
        let raw_open = crate::native_delivery::recovery_issue_candidates(
            &w.reader,
            &w.context.repository,
            &intent.title,
        )
        .await?;
        let recent = crate::native_delivery::recent_issues(
            &w.reader,
            &w.context.repository,
            w.facts.id,
        )
        .await?;
        let normalize = |title: &str| {
            title
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase()
        };
        let recent_match = recent
            .iter()
            .any(|issue| normalize(&issue.title) == normalize(&intent.title));
        if raw_open
            || recent_match
            || !candidates.read.issues.is_empty()
            || !candidates.history.is_empty()
        {
            return Err(Diagnostic::new(
                Code::AmbiguousRequest,
                "issue",
                "Native issue candidates exist for an uncertain creation.",
                "Inspect the candidates and adopt the exact issue ID; the checkpoint was preserved.",
            ));
        }
        evidence.push(intent.title.clone());
    }
    w.process.ensure_inspection_budget("issue_recovery")?;
    w.unchanged_issue().await?;
    w.process.ensure_inspection_budget("issue_recovery")?;
    if !options.dry_run {
        for index in pending {
            selected.intents[index].write_started = false;
        }
        let effect = effects.begin(
            "local",
            "discard_uncertain_issue",
            serde_json::json!({"branch":selected.branch,"titles":evidence}),
        );
        lock.save(&selected)?;
        effects.applied(effect);
    }
    Ok(Report::success(
        "issue",
        if options.dry_run {
            "discard_prepared"
        } else {
            "uncertain_discarded"
        },
        serde_json::json!({"titles":evidence,"writes":!options.dry_run}),
    ))
}

pub(super) async fn apply(
    options: &Options,
    p: &mut Prepared,
    write_process: Process,
    effects: &mut Effects,
) -> Result<Report, Diagnostic> {
    let w = &mut p.workspace;
    let selection = &mut p.selection;
    // A replaced delivered checkpoint must still be exactly what preparation saw.
    let expected = p.previous.as_ref().or(p.replaced.as_ref());
    w.unchanged_issue().await?;
    let mut lock = Locked::acquire(&w.context)?;
    let current = match selection::classify(&w.context)? {
        selection::ReadOutcome::Absent => None,
        selection::ReadOutcome::Current(s)
        | selection::ReadOutcome::BranchMismatch { selection: s, .. } => Some(s),
    };
    if serde_json::to_value(current).map_err(|_| Diagnostic::input("Cannot compare selection."))?
        != serde_json::to_value(expected)
            .map_err(|_| Diagnostic::input("Cannot compare selection."))?
    {
        return Err(Diagnostic::new(
            Code::ConcurrentEdit,
            "selection",
            "The selection changed during preflight.",
            "Read the current selection and retry.",
        ));
    }
    if options.branch.is_some() {
        // Recheck dirty state at the actual checkout boundary.
        if !project::git(
            &w.process,
            &w.context.root,
            &["status", "--porcelain=v1", "-z"],
        )
        .await?
        .is_empty()
        {
            return Err(Diagnostic::input(
                "The worktree changed before branch creation.",
            ));
        }
    }
    w.process.ensure_inspection_budget("issue_preflight")?;
    w.process.finish_inspection();
    if let Some(branch) = &options.branch {
        let branch_effect = effects.begin(
            "local",
            "create_branch",
            serde_json::json!({"branch":branch,"repository":w.context.repository}),
        );
        project::git(&write_process, &w.context.root, &["switch", "-c", branch]).await?;
        effects.applied(branch_effect);
        w.context.branch = Some(branch.clone());
        selection.branch = branch.clone();
    }
    let local_effect = effects.begin(
        "local",
        "save_selection",
        serde_json::json!({"branch":selection.branch,"repository":selection.repository}),
    );
    lock.save(selection)?;
    effects.applied(local_effect);
    let writer =
        native_delivery::IssueWrite::new(write_process, &w.context.root, &w.context.repository)?;
    let catalog = w.specification().catalog();
    let mut pool = None;
    for index in 0..selection.intents.len() {
        let intent = selection.intents[index].clone();
        if intent.issue.is_some() {
            continue;
        }
        if intent.write_started {
            return Ok(uncertain(serde_json::json!({"title":intent.title})));
        }
        if !intent.labels.is_empty() {
            if pool.is_none() {
                pool = Some(native_delivery::label_pool(&w.reader, &w.context.repository).await?);
            }
            ensure_labels(
                options,
                w,
                &writer,
                &intent.labels,
                pool.as_mut().unwrap(),
                &catalog,
                effects,
            )
            .await?;
        }
        create_issue(w, &writer, &mut lock, selection, index, &intent, effects).await?;
    }
    // Resume always validates remote facts, including preserved user edits.
    let mut issues = vec![];
    for number in &selection.issues {
        let issue =
            native_delivery::issue(&w.reader, &w.context.repository, w.facts.id, *number).await?;
        validate(
            w.specification(),
            w.context.repository.provider,
            &issue.title,
            &issue.body,
            &issue.labels,
        )?;
        issues.push(issue);
    }
    Ok(Report::success(
        "issue",
        "selected",
        serde_json::json!({"selection":selection,"issues":issues,"request":"pending_request","duplicate_check":"Recent issue checks are bounded and cannot eliminate duplicate races."}),
    ))
}

async fn ensure_labels(
    options: &Options,
    w: &Workspace,
    writer: &native_delivery::IssueWrite,
    labels: &[String],
    pool: &mut Vec<String>,
    catalog: &BTreeMap<String, config::Tag>,
    effects: &mut Effects,
) -> Result<(), Diagnostic> {
    let mut created = Vec::new();
    for label in labels {
        if !spec::label_contains(w.context.repository.provider, pool, label) {
            if !options.create_labels {
                return Err(Diagnostic::new(
                    Code::ConfirmationRequired,
                    "label",
                    "A label disappeared after preflight.",
                    "Inspect the native pool before explicitly requesting label creation.",
                ));
            }
            let tag = catalog.get(label).ok_or_else(|| {
                Diagnostic::input(
                    "A selected existing label disappeared; arbitrary labels cannot be seeded.",
                )
            })?;
            let label_effect = effects.begin(
                "native",
                "create_label",
                serde_json::json!({"label":label,"repository":w.context.repository}),
            );
            w.unchanged_issue().await?;
            writer.create_label(tag).await?;
            created.push((label, label_effect));
        }
    }
    if !created.is_empty() {
        *pool = native_delivery::label_pool(&w.reader, &w.context.repository).await?;
        for (label, label_effect) in created {
            if !spec::label_contains(w.context.repository.provider, pool, label) {
                return Err(Diagnostic::new(
                    Code::MalformedResponse,
                    "label",
                    "The created label is missing from native readback.",
                    "Inspect the native label before resuming.",
                ));
            }
            effects.applied(label_effect);
        }
    }
    Ok(())
}

async fn create_issue(
    w: &Workspace,
    writer: &native_delivery::IssueWrite,
    lock: &mut Locked,
    selection: &mut Selection,
    index: usize,
    intent: &IssueIntent,
    effects: &mut Effects,
) -> Result<(), Diagnostic> {
    w.unchanged_issue().await?;
    selection.intents[index].write_started = true;
    let local_effect = effects.begin(
        "local",
        "save_selection",
        serde_json::json!({"branch":selection.branch,"repository":selection.repository}),
    );
    lock.save(selection)?;
    effects.applied(local_effect);
    let issue_effect = effects.begin("native", "create_issue", serde_json::json!({"title":intent.title,"repository":w.context.repository,"branch":selection.branch,"next_action":"inspect_candidates_then_adopt_exact_id"}));
    let result = writer
        .create_issue(&intent.title, &intent.body, &intent.labels)
        .await;
    let number = match result {
        Ok(number) => number,
        Err(error) => {
            if matches!(error.http_status, Some(400 | 401 | 403 | 422))
                && matches!(
                    error.code,
                    Code::ProcessFailed | Code::AuthenticationFailed | Code::PermissionDenied
                )
            {
                selection.intents[index].write_started = false;
                let local_effect = effects.begin(
                    "local",
                    "save_selection",
                    serde_json::json!({"branch":selection.branch,"repository":selection.repository}),
                );
                lock.save(selection)?;
                effects.applied(local_effect);
            }
            return Err(error);
        }
    };
    effects.locator(issue_effect, "issue", number);
    // Save the returned locator before any fallible readback.
    selection.intents[index].issue = Some(number);
    if !selection.issues.contains(&number) {
        selection.issues.push(number);
    }
    let local_effect = effects.begin(
        "local",
        "save_selection",
        serde_json::json!({"branch":selection.branch,"repository":selection.repository}),
    );
    lock.save(selection)?;
    effects.applied(local_effect);
    let observed =
        native_delivery::issue(&w.reader, &w.context.repository, w.facts.id, number).await?;
    if observed.title != intent.title
        || !native_delivery::written_body_matches(
            w.context.repository.provider,
            &intent.body,
            &observed.body,
        )
        || !intent
            .labels
            .iter()
            .all(|l| spec::label_contains(w.context.repository.provider, &observed.labels, l))
    {
        return Err(Diagnostic::new(
            Code::ConcurrentEdit,
            "issue",
            "Native issue readback differs from the submitted specification.",
            "Inspect the returned issue ID; resume preserves native edits.",
        ));
    }
    effects.applied(issue_effect);
    Ok(())
}
