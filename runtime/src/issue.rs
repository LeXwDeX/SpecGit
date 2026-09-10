//! Preflight all selected specs before native issue writes; persist intent first.
use crate::{
    config,
    diagnostic::{Code, Diagnostic},
    native_delivery,
    probe::ForgeRead,
    process::Process,
    project,
    report::{Effects, Report},
    selection::{self, IssueIntent, Locked, Selection},
    spec, templates,
};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

#[derive(Debug, clap::Args)]
pub struct Options {
    /// Exact issue IDs to adopt or complete Conventional Commit titles to create.
    #[arg(required = true, num_args = 1..)]
    pub specs: Vec<String>,
    /// One final Markdown body file per new title, in title order.
    #[arg(long)]
    pub body_file: Vec<PathBuf>,
    #[arg(long, value_delimiter = ',')]
    pub tags: Option<Vec<String>>,
    /// Create this branch only from a clean worktree; never replace an existing branch.
    #[arg(long)]
    pub branch: Option<String>,
    /// Prepare content and report duplicate candidates without writes.
    #[arg(long)]
    pub inspect: bool,
    /// Preview exact proposed objects without changing local or native state.
    #[arg(long)]
    pub dry_run: bool,
    /// Explicitly create selected catalog labels that are missing on the forge.
    #[arg(long)]
    pub create_labels: bool,
}
pub async fn run(options: Options, process: Process, cwd: &Path) -> Report {
    let mut effects = Effects::default();
    let mut report = match execute(options, process, cwd, &mut effects).await {
        Ok(report) => report,
        Err(d) => Report::failure("issue", d),
    };
    report.effects = Some(effects);
    report
}
async fn execute(
    mut options: Options,
    process: Process,
    cwd: &Path,
    effects: &mut Effects,
) -> Result<Report, Diagnostic> {
    options.body_file = options
        .body_file
        .into_iter()
        .map(|p| if p.is_absolute() { p } else { cwd.join(p) })
        .collect();
    if options.specs.len() > 100 {
        return Err(Diagnostic::input("Select at most 100 specs."));
    }
    let root_bytes = project::git(&process, cwd, &["rev-parse", "--show-toplevel"]).await?;
    let root = PathBuf::from(
        String::from_utf8(root_bytes)
            .map_err(|_| Diagnostic::input("Invalid Git root."))?
            .trim_end_matches(['\r', '\n']),
    );
    let d = config::read(&root)?.ok_or_else(|| {
        Diagnostic::input("Initialize the v2 project declaration before selecting a delivery.")
    })?;
    let mut context =
        config::resolve(&process, &root, d.remote.as_deref(), d.provider, None).await?;
    let reader = ForgeRead::new(
        process.clone(),
        &root,
        context.repository.provider,
        &context.repository.host,
    )?;
    let project_facts = reader.project(&context.repository).await?;
    let target = d
        .target
        .clone()
        .unwrap_or(project_facts.default_branch.clone());
    let current_branch = context.branch.clone().ok_or_else(|| {
        Diagnostic::input(
            "Select a branch before binding issues; detached HEAD cannot own a delivery.",
        )
    })?;
    if let Some(branch) = &options.branch
        && (!config::valid_branch(branch)
            || branch == &target
            || branch == &current_branch
            || context.dirty)
    {
        return Err(Diagnostic::input(
            "A new delivery branch must be valid, distinct from source/target, and start in a clean worktree.",
        ));
    }
    let previous = selection::read(&context)?;
    let mut selection = previous.clone().unwrap_or(Selection {
        version: 2,
        repository: context.repository.clone(),
        project_id: project_facts.id,
        branch: current_branch,
        target: target.clone(),
        issues: vec![],
        intents: vec![],
        request: None,
        request_write_started: false,
        request_intent: None,
    });
    if selection.project_id != project_facts.id || selection.target != target {
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
    let pool = native_delivery::label_pool(&reader, &context.repository).await?;
    let mut prepared = vec![];
    let mut candidate_reports = vec![];
    let mut adopted = vec![];
    let mut title_index = 0;
    for value in &options.specs {
        if let Ok(number) = value.parse::<u64>() {
            if number == 0 {
                return Err(Diagnostic::input("Issue IDs must be positive."));
            }
            let issue =
                native_delivery::issue(&reader, &context.repository, project_facts.id, number)
                    .await?;
            validate(&d, &issue.title, &issue.body, &issue.labels)?;
            adopted.push(issue);
            continue;
        }
        spec::kind(value)?;
        let vars = BTreeMap::from([("title", value.clone()), ("summary", value.clone())]);
        let p = templates::prepare(
            &root,
            &d.templates.issue,
            d.language,
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
        let labels = spec::selected_labels(&d, &title, explicit, &pool)?;
        validate(&d, &title, &p.body, &labels)?;
        if context.repository.provider == project::Provider::Gitlab {
            templates::reject_quick_actions(&p.body)?;
        }
        let found =
            native_delivery::candidates(&reader, &context.repository, project_facts.id, &title)
                .await?;
        candidate_reports.push(serde_json::json!({"title":title,"issues":found}));
        prepared.push(IssueIntent {
            title,
            body: p.body,
            labels,
            issue: None,
            write_started: false,
        });
    }
    for number in &selection.issues {
        let issue =
            native_delivery::issue(&reader, &context.repository, project_facts.id, *number).await?;
        validate(&d, &issue.title, &issue.body, &issue.labels)?;
    }
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
    // Every persisted intent is subject to today's declaration and fresh native
    // duplicate evidence, even when this invocation supplied only adopted IDs.
    for intent in selection.intents.iter().filter(|i| i.issue.is_none()) {
        validate(&d, &intent.title, &intent.body, &intent.labels)?;
        spec::selected_labels(&d, &intent.title, Some(&intent.labels), &pool)?;
        if context.repository.provider == project::Provider::Gitlab {
            templates::reject_quick_actions(&intent.body)?;
        }
        let candidates = native_delivery::candidates(
            &reader,
            &context.repository,
            project_facts.id,
            &intent.title,
        )
        .await?;
        let evidence = serde_json::json!({"title":intent.title,"issues":candidates});
        if options.inspect || options.dry_run {
            candidate_reports.push(evidence);
            continue;
        }
        if intent.write_started {
            return Ok(uncertain(evidence));
        }
        if !candidates.is_empty() {
            let mut report = Report::success("issue", "candidate_review_required", evidence);
            report.exit = 3;
            report.diagnostics.push(Diagnostic::new(Code::AmbiguousRequest, "issue", "Similar open issues require a WHY comparison before creation.", "Read the candidates and adopt the exact existing ID when it covers this work; uncertain intent mappings require one explicit adoption at a time."));
            return Ok(report);
        }
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
        return Ok(Report::success(
            "issue",
            "prepared",
            serde_json::json!({"prepared":selection.intents,"adopted":selection.issues,"selection":selection,"candidates":candidate_reports,"writes":false,"repository":context.repository,"project_id":project_facts.id,"target":target,"new_branch":options.branch,"missing_labels":missing_labels,"label_creation_requested":options.create_labels}),
        ));
    }
    if !options.create_labels && !missing_labels.is_empty() {
        return Err(Diagnostic::new(
            Code::ConfirmationRequired,
            "issue",
            "Selected labels are missing from the native project.",
            "Inspect --dry-run and explicitly request --create-labels, or choose existing labels.",
        ));
    }
    let mut lock = Locked::acquire(&context)?;
    if serde_json::to_value(selection::read(&context)?)
        .map_err(|_| Diagnostic::input("Cannot compare selection."))?
        != serde_json::to_value(&previous)
            .map_err(|_| Diagnostic::input("Cannot compare selection."))?
    {
        return Err(Diagnostic::new(
            Code::ConcurrentEdit,
            "selection",
            "The selection changed during preflight.",
            "Read the current selection and retry.",
        ));
    }
    if let Some(branch) = &options.branch {
        // Recheck dirty state at the actual checkout boundary.
        if !project::git(&process, &root, &["status", "--porcelain=v1", "-z"])
            .await?
            .is_empty()
        {
            return Err(Diagnostic::input(
                "The worktree changed before branch creation.",
            ));
        }
        let branch_effect = effects.begin(
            "local",
            "create_branch",
            serde_json::json!({"branch":branch,"repository":context.repository}),
        );
        project::git(&process, &root, &["switch", "-c", branch]).await?;
        effects.applied(branch_effect);
        context.branch = Some(branch.clone());
        selection.branch = branch.clone();
    }
    let local_effect = effects.begin(
        "local",
        "save_selection",
        serde_json::json!({"branch":selection.branch,"repository":selection.repository}),
    );
    lock.save(&selection)?;
    effects.applied(local_effect);
    let writer = native_delivery::IssueWrite::new(process, &root, &context.repository)?;
    let catalog = spec::catalog(&d);
    for index in 0..selection.intents.len() {
        let intent = selection.intents[index].clone();
        if intent.issue.is_some() {
            continue;
        }
        if intent.write_started {
            return Ok(uncertain(serde_json::json!({"title":intent.title})));
        }
        for label in &intent.labels {
            let pool = native_delivery::label_pool(&reader, &context.repository).await?;
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
                    serde_json::json!({"label":label,"repository":context.repository}),
                );
                writer.create_label(tag).await?;
                if !native_delivery::label_pool(&reader, &context.repository)
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
        selection.intents[index].write_started = true;
        let local_effect = effects.begin(
            "local",
            "save_selection",
            serde_json::json!({"branch":selection.branch,"repository":selection.repository}),
        );
        lock.save(&selection)?;
        effects.applied(local_effect);
        let issue_effect = effects.begin("native", "create_issue", serde_json::json!({"title":intent.title,"repository":context.repository,"branch":selection.branch,"next_action":"inspect_candidates_then_adopt_exact_id"}));
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
        lock.save(&selection)?;
        effects.applied(local_effect);
        let observed =
            native_delivery::issue(&reader, &context.repository, project_facts.id, number).await?;
        if observed.title != intent.title
            || observed.body != intent.body
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
    }
    // Resume always validates remote facts, including preserved user edits.
    let mut issues = vec![];
    for number in &selection.issues {
        let issue =
            native_delivery::issue(&reader, &context.repository, project_facts.id, *number).await?;
        validate(&d, &issue.title, &issue.body, &issue.labels)?;
        issues.push(issue);
    }
    Ok(Report::success(
        "issue",
        "selected",
        serde_json::json!({"selection":selection,"issues":issues,"request":"pending_request"}),
    ))
}
fn validate(
    d: &config::Declaration,
    title: &str,
    body: &str,
    labels: &[String],
) -> Result<(), Diagnostic> {
    let errors = spec::check(d, true, title, body, labels);
    if errors.is_empty() {
        Ok(())
    } else {
        Err(Diagnostic::input(
            &errors
                .iter()
                .map(|e| e.message.clone())
                .collect::<Vec<_>>()
                .join(" "),
        ))
    }
}
fn uncertain(evidence: serde_json::Value) -> Report {
    let mut report = Report::failure(
        "issue",
        Diagnostic::new(
            Code::AmbiguousRequest,
            "issue",
            "A prior creation may have applied without a confirmed issue ID.",
            "Inspect the native candidates and rerun with the exact issue ID to reconcile the intent. Automatic creation is stopped to prevent duplicates.",
        ),
    );
    report.evidence = evidence;
    report
}
