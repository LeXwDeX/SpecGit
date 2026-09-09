//! Preflight all selected specs before native issue writes; persist intent first.
use crate::{
    config,
    diagnostic::{Code, Diagnostic},
    native_delivery,
    probe::ForgeRead,
    process::Process,
    project,
    report::Report,
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
}
pub async fn run(options: Options, process: Process, cwd: &Path) -> Report {
    match execute(options, process, cwd).await {
        Ok(report) => report,
        Err(d) => Report::failure("issue", d),
    }
}
async fn execute(options: Options, process: Process, cwd: &Path) -> Result<Report, Diagnostic> {
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
    if options.inspect {
        return Ok(Report::success(
            "issue",
            "prepared",
            serde_json::json!({"prepared":prepared,"adopted":adopted,"candidates":candidate_reports,"writes":false}),
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
    for number in &selection.issues {
        let issue =
            native_delivery::issue(&reader, &context.repository, project_facts.id, *number).await?;
        validate(&d, &issue.title, &issue.body, &issue.labels)?;
    }
    for (intent, candidates) in prepared.iter().zip(&candidate_reports) {
        let resumed = selection.intents.iter().find(|i| {
            i.title == intent.title && i.body == intent.body && i.labels == intent.labels
        });
        if let Some(existing) = resumed {
            if existing.write_started && existing.issue.is_none() {
                return Ok(uncertain(candidates.clone()));
            }
        } else if candidates["issues"]
            .as_array()
            .is_some_and(|a| !a.is_empty())
        {
            let mut report =
                Report::success("issue", "candidate_review_required", candidates.clone());
            report.exit = 3;
            report.diagnostics.push(Diagnostic::new(Code::AmbiguousRequest, "issue", "Similar open issues require a WHY comparison before creation.", "Read the reported candidates and adopt the exact existing ID when it covers this work; refine an independent specification before creating another issue."));
            return Ok(report);
        }
    }
    for issue in adopted {
        if !selection.issues.contains(&issue.id) {
            selection.issues.push(issue.id);
        }
        for intent in &mut selection.intents {
            if intent.write_started
                && intent.issue.is_none()
                && intent.title == issue.title
                && intent.body == issue.body
                && intent.labels.iter().all(|l| issue.labels.contains(l))
            {
                intent.issue = Some(issue.id);
            }
        }
    }
    for intent in prepared {
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
        project::git(&process, &root, &["switch", "-c", branch]).await?;
        context.branch = Some(branch.clone());
        selection.branch = branch.clone();
    }
    lock.save(&selection)?;
    let writer = native_delivery::ForgeWrite::new(process, &root, &context.repository)?;
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
                let tag = catalog.get(label).ok_or_else(|| {
                    Diagnostic::input(
                        "A selected existing label disappeared; arbitrary labels cannot be seeded.",
                    )
                })?;
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
            }
        }
        selection.intents[index].write_started = true;
        lock.save(&selection)?;
        let number = writer
            .create_issue(&intent.title, &intent.body, &intent.labels)
            .await?;
        // Save the returned locator before any fallible readback.
        selection.intents[index].issue = Some(number);
        if !selection.issues.contains(&number) {
            selection.issues.push(number);
        }
        lock.save(&selection)?;
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
