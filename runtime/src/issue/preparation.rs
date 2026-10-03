//! Read identity and native specs, then reconcile a proposed checkpoint without writes.
use super::*;

pub(super) struct Prepared {
    pub workspace: Workspace,
    pub previous: Option<Selection>,
    pub foreign_checkpoint: Option<selection::BranchMismatch>,
    pub selection: Selection,
    pub pool: Vec<String>,
}

pub(super) fn normalize(options: &mut Options, cwd: &Path) -> Result<(), Diagnostic> {
    options.body_file = std::mem::take(&mut options.body_file)
        .into_iter()
        .map(|p| if p.is_absolute() { p } else { cwd.join(p) })
        .collect();
    if options.specs.len() > 100 {
        return Err(Diagnostic::input("Select at most 100 specs."));
    }
    if options.reviewed_candidates.len() > 100
        || options.reviewed_candidates.iter().any(|digest| {
            digest.len() != 64
                || !digest
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        })
    {
        return Err(Diagnostic::input(
            "Supply exact candidate review digests from --inspect.",
        ));
    }
    Ok(())
}

pub(super) async fn prepare(
    options: &Options,
    process: Process,
    cwd: &Path,
) -> Result<Prepared, Diagnostic> {
    let w = Workspace::load_issue(process, cwd).await?;
    let current_branch = w.issue_branch()?.to_owned();
    if let Some(branch) = &options.branch
        && (!config::valid_branch(branch)
            || branch == &w.target
            || branch == &current_branch
            || w.context.dirty)
    {
        return Err(Diagnostic::input(
            "A new delivery branch must be valid, distinct from source/target, and start in a clean worktree.",
        ));
    }
    let (previous, foreign_checkpoint) = match selection::classify(&w.context)? {
        selection::ReadOutcome::Absent => (None, None),
        selection::ReadOutcome::Current(current) => (Some(current), None),
        selection::ReadOutcome::BranchMismatch {
            selection: recorded,
            checkpoint,
        } => {
            if recorded.project_id != w.facts.id || recorded.target != w.target {
                return Err(Diagnostic::input(
                    "The project identity or delivery target changed; reconcile the existing selection explicitly.",
                ));
            }
            if !(options.inspect || options.dry_run) {
                return Err(selection::branch_mismatch_diagnostic(&checkpoint));
            }
            (None, Some(checkpoint))
        }
    };
    let mut selection = previous.clone().unwrap_or(Selection {
        version: 2,
        repository: w.context.repository.clone(),
        project_id: w.facts.id,
        branch: current_branch,
        target: w.target.clone(),
        issues: vec![],
        intents: vec![],
        adopted: vec![],
        request: None,
        request_write_started: false,
        request_intent: None,
    });
    if selection.project_id != w.facts.id || selection.target != w.target {
        return Err(Diagnostic::input(
            "The project identity or delivery target changed; reconcile the existing selection explicitly.",
        ));
    }
    if options.branch.is_some()
        && (!selection.issues.is_empty()
            || !selection.intents.is_empty()
            || selection.request.is_some())
    {
        return Err(Diagnostic::input(
            "Use a separate worktree for a new independent delivery; this worktree already has a selection.",
        ));
    }
    let titles: Vec<_> = options
        .specs
        .iter()
        .filter(|s| s.parse::<u64>().is_err())
        .collect();
    if !options.body_file.is_empty() && options.body_file.len() != titles.len() {
        return Err(Diagnostic::input(
            "Supply one --body-file per new title, in title order.",
        ));
    }
    let pool = native_delivery::label_pool(&w.reader, &w.context.repository).await?;
    let (prepared, adopted) = submitted(options, &w, &pool).await?;
    for number in &selection.issues {
        let issue =
            native_delivery::issue(&w.reader, &w.context.repository, w.facts.id, *number).await?;
        validate(w.specification(), &issue.title, &issue.body, &issue.labels)?;
    }
    reconcile(&mut selection, adopted, prepared)?;
    if selection.issues.len()
        + selection
            .intents
            .iter()
            .filter(|i| i.issue.is_none())
            .count()
        > 100
    {
        return Err(Diagnostic::input("A delivery supports at most 100 issues."));
    }
    Ok(Prepared {
        workspace: w,
        previous,
        foreign_checkpoint,
        selection,
        pool,
    })
}

fn reconcile(
    selection: &mut Selection,
    adopted: Vec<crate::delivery_model::Issue>,
    prepared: Vec<IssueIntent>,
) -> Result<(), Diagnostic> {
    // One exact adopted ID can replace one unresolved intent without requiring
    // its mutable native prose to remain identical to the original submission.
    let unresolved: Vec<_> = selection
        .intents
        .iter()
        .enumerate()
        .filter(|(_, i)| i.issue.is_none())
        .map(|(index, _)| index)
        .collect();
    let adoptable: Vec<_> = adopted
        .iter()
        .filter(|issue| {
            !selection.issues.contains(&issue.id)
                && !selection.intents.iter().any(|i| i.issue == Some(issue.id))
        })
        .collect();
    if adoptable.len() == 1 && unresolved.len() == 1 {
        selection.intents[unresolved[0]].issue = Some(adoptable[0].id);
    } else {
        let uncertain: Vec<_> = selection
            .intents
            .iter()
            .enumerate()
            .filter(|(_, i)| i.write_started && i.issue.is_none())
            .map(|(index, _)| index)
            .collect();
        if adoptable.len() == 1 && uncertain.len() == 1 {
            selection.intents[uncertain[0]].issue = Some(adoptable[0].id);
        }
    }
    for issue in adopted {
        if !selection.issues.contains(&issue.id) {
            selection.issues.push(issue.id);
        }
        selection.record_adopted(issue);
    }
    for intent in prepared {
        if selection.intents.iter().any(|i| {
            i.title == intent.title && (i.body != intent.body || i.labels != intent.labels)
        }) {
            return Err(Diagnostic::input(
                "The submitted content differs from an existing intent with this title. Adopt its native issue ID, or use a separate independent specification.",
            ));
        }
        if !selection
            .intents
            .iter()
            .any(|i| i.title == intent.title && i.body == intent.body && i.labels == intent.labels)
        {
            selection.intents.push(intent);
        }
    }
    Ok(())
}

async fn submitted(
    options: &Options,
    w: &Workspace,
    pool: &[String],
) -> Result<(Vec<IssueIntent>, Vec<crate::delivery_model::Issue>), Diagnostic> {
    let mut prepared = vec![];
    let mut adopted = vec![];
    let mut title_index = 0;
    for value in &options.specs {
        if let Ok(number) = value.parse::<u64>() {
            if number == 0 {
                return Err(Diagnostic::input("Issue IDs must be positive."));
            }
            let issue =
                native_delivery::issue(&w.reader, &w.context.repository, w.facts.id, number)
                    .await?;
            validate(w.specification(), &issue.title, &issue.body, &issue.labels)?;
            adopted.push(issue);
            continue;
        }
        spec::kind(value)?;
        let vars = BTreeMap::from([("title", value.clone()), ("summary", value.clone())]);
        let p = templates::prepare(
            &w.context.root,
            w.specification().issue_template(),
            w.specification().language(),
            true,
            options.body_file.get(title_index).map(PathBuf::as_path),
            &vars,
        )?;
        title_index += 1;
        let title = p.title.unwrap_or_else(|| value.clone());
        let explicit = options
            .tags
            .as_deref()
            .or_else(|| (!p.labels.is_empty()).then_some(p.labels.as_slice()));
        let labels = w.specification().selected_labels(&title, explicit, pool)?;
        validate(w.specification(), &title, &p.body, &labels)?;
        if w.context.repository.provider == project::Provider::Gitlab {
            templates::reject_quick_actions(&p.body)?;
        }
        prepared.push(IssueIntent {
            title,
            body: p.body,
            labels,
            issue: None,
            write_started: false,
        });
    }
    Ok((prepared, adopted))
}
