//! Persist creation intents and locators before fallible native readback.
use super::preparation::Prepared;
use super::*;

pub(super) async fn apply(
    options: &Options,
    p: &mut Prepared,
    write_process: Process,
    effects: &mut Effects,
) -> Result<Report, Diagnostic> {
    let w = &mut p.workspace;
    let selection = &mut p.selection;
    let previous = &p.previous;
    w.unchanged_issue().await?;
    let mut lock = Locked::acquire(&w.context)?;
    if serde_json::to_value(selection::read(&w.context)?)
        .map_err(|_| Diagnostic::input("Cannot compare selection."))?
        != serde_json::to_value(previous)
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
    for index in 0..selection.intents.len() {
        let intent = selection.intents[index].clone();
        if intent.issue.is_some() {
            continue;
        }
        if intent.write_started {
            return Ok(uncertain(serde_json::json!({"title":intent.title})));
        }
        ensure_labels(options, w, &writer, &intent, &catalog, effects).await?;
        create_issue(w, &writer, &mut lock, selection, index, &intent, effects).await?;
    }
    // Resume always validates remote facts, including preserved user edits.
    let mut issues = vec![];
    for number in &selection.issues {
        let issue =
            native_delivery::issue(&w.reader, &w.context.repository, w.facts.id, *number).await?;
        validate(w.specification(), &issue.title, &issue.body, &issue.labels)?;
        issues.push(issue);
    }
    Ok(Report::success(
        "issue",
        "selected",
        serde_json::json!({"selection":selection,"issues":issues,"request":"pending_request"}),
    ))
}

async fn ensure_labels(
    options: &Options,
    w: &Workspace,
    writer: &native_delivery::IssueWrite,
    intent: &IssueIntent,
    catalog: &BTreeMap<String, config::Tag>,
    effects: &mut Effects,
) -> Result<(), Diagnostic> {
    for label in &intent.labels {
        let pool = native_delivery::label_pool(&w.reader, &w.context.repository).await?;
        if !pool.contains(label) {
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
            if !native_delivery::label_pool(&w.reader, &w.context.repository)
                .await?
                .contains(label)
            {
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
    let number = writer
        .create_issue(&intent.title, &intent.body, &intent.labels)
        .await?;
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
        || !intent.labels.iter().all(|l| observed.labels.contains(l))
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
