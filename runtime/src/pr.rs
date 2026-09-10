//! Explicit native request creation/adoption; no implicit push, commit, issue closure or branch deletion.
use crate::{
    delivery_context::Workspace,
    diagnostic::{Code, Diagnostic},
    native_delivery::{self, PullRequest, RequestWrite},
    process::Process,
    project::Provider,
    report::{Effects, Report},
    selection::{self, Locked, RequestIntent, Selection},
    spec, templates,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};
#[derive(Debug, clap::Args)]
pub struct Options {
    /// Adopt this exact native PR/MR ID; otherwise resume or discover the current source branch.
    #[arg(long)]
    pub request: Option<u64>,
    #[arg(long)]
    pub title: Option<String>,
    #[arg(long)]
    pub body_file: Option<PathBuf>,
    #[arg(long, value_delimiter = ',')]
    pub tags: Option<Vec<String>>,
    /// Explicitly update the current request body, preserving every existing deliberate reference.
    #[arg(long, requires = "body_file", conflicts_with = "update_references")]
    pub update_body: bool,
    /// Append missing selected references to a freshly read native body.
    #[arg(long, conflicts_with = "body_file")]
    pub update_references: bool,
    #[arg(long)]
    pub ready: bool,
    #[arg(long, conflicts_with_all = ["ready", "update_body", "update_references"])]
    pub inspect: bool,
    /// Read native lifecycle facts without creating or modifying a request.
    #[arg(long, conflicts_with_all = ["title", "body_file", "tags", "ready", "update_body", "update_references", "inspect"])]
    pub status: bool,
    /// Preview request creation or changes without writing local or remote state.
    #[arg(long, conflicts_with = "status")]
    pub dry_run: bool,
    /// Explicitly create selected catalog labels missing from the native project.
    #[arg(long, conflicts_with = "status")]
    pub create_labels: bool,
}
pub async fn run(options: Options, process: Process, cwd: &Path) -> Report {
    if options.status {
        return Report::observation(
            "pr.status",
            crate::observation::observe(options.request, process, cwd).await,
        );
    }
    let mut effects = Effects::default();
    let mut report = match execute(options, process, cwd, &mut effects).await {
        Ok(r) => r,
        Err(d) => Report::failure("pr", d),
    };
    report.effects = Some(effects);
    report
}
async fn execute(
    mut o: Options,
    process: Process,
    cwd: &Path,
    effects: &mut Effects,
) -> Result<Report, Diagnostic> {
    o.body_file = o
        .body_file
        .map(|p| if p.is_absolute() { p } else { cwd.join(p) });
    if o.request == Some(0) {
        return Err(Diagnostic::input("Request IDs must be positive."));
    }
    let w = Workspace::load(process, cwd).await?;
    let repo = &w.context.repository;
    let branch = w.branch()?;
    if branch == w.target {
        return Err(Diagnostic::input(
            "Select a delivery branch distinct from its target.",
        ));
    }
    let previous = selection::read(&w.context)?;
    let number = o.request.or(previous.as_ref().and_then(|s| s.request));
    let mut request = if let Some(number) = number {
        Some(native_delivery::pull_request(&w.reader, repo, number).await?)
    } else {
        let candidates = native_delivery::request_candidates(&w.reader, repo, branch).await?;
        if candidates.len() > 1 {
            return Err(Diagnostic::new(
                Code::AmbiguousRequest,
                "pr",
                "Several native requests use this source branch.",
                "Inspect them and select one exact --request ID.",
            ));
        }
        candidates.into_iter().next()
    };
    if let Some(r) = &request {
        identity(&w, r)?;
    }
    let mut selected = previous.clone().unwrap_or(Selection {
        version: 2,
        repository: repo.clone(),
        project_id: w.facts.id,
        branch: branch.into(),
        target: w.target.clone(),
        issues: vec![],
        intents: vec![],
        request: None,
        request_write_started: false,
        request_intent: None,
    });
    if selected.project_id != w.facts.id || selected.target != w.target {
        return Err(Diagnostic::input(
            "The selected delivery project or target changed; reconcile its native binding.",
        ));
    }
    if let Some(r) = &request {
        let refs = spec::references(&r.body)?;
        if selected.issues.is_empty() {
            selected.issues = refs.into_iter().collect();
        }
    }
    if selected.issues.is_empty() {
        return Err(Diagnostic::input(
            "Select issue specifications before creating a request, or adopt an existing request with explicit Closes references.",
        ));
    }
    if selected.intents.iter().any(|i| i.issue.is_none()) {
        return Err(Diagnostic::input(
            "Resolve every pending issue intent before preparing its request.",
        ));
    }
    let mut issues = vec![];
    for id in &selected.issues {
        let issue = native_delivery::issue(&w.reader, repo, w.facts.id, *id).await?;
        validate(
            w.specification(),
            true,
            &issue.title,
            &issue.body,
            &issue.labels,
        )?;
        issues.push(issue);
    }
    let pool = native_delivery::label_pool(&w.reader, repo).await?;
    let mut replacement = None;
    let intended = if let Some(r) = &request {
        if o.title.is_some() || o.tags.is_some() || (o.body_file.is_some() && !o.update_body) {
            return Err(Diagnostic::input(
                "Existing request content is preserved. Use --update-body with a final body file; native title/label edits remain explicit native operations.",
            ));
        }
        let mut ids: BTreeSet<_> = selected.issues.iter().copied().collect();
        ids.extend(spec::references(&r.body)?);
        for id in &ids {
            if !selected.issues.contains(id) {
                let issue = native_delivery::issue(&w.reader, repo, w.facts.id, *id).await?;
                validate(
                    w.specification(),
                    true,
                    &issue.title,
                    &issue.body,
                    &issue.labels,
                )?;
                selected.issues.push(*id);
                issues.push(issue);
            }
        }
        if o.update_body || o.update_references {
            let input = if let Some(path) = &o.body_file {
                templates::read_text(path)?
            } else {
                r.body.clone()
            };
            replacement = Some(spec::with_references(
                &input,
                &ids.into_iter().collect::<Vec<_>>(),
            )?);
        } else if !selected
            .issues
            .iter()
            .all(|id| spec::references(&r.body).is_ok_and(|refs| refs.contains(id)))
        {
            return Err(Diagnostic::input(
                "The native request lacks selected closing references; explicitly use --update-references after reviewing its body.",
            ));
        }
        // Resume adds only pending labels, so validate the complete resulting set
        // before any remote write, including a requested body replacement.
        let mut labels = r.labels.clone();
        if let Some(intent) = &selected.request_intent {
            for label in &intent.labels {
                if !labels.contains(label) {
                    labels.push(label.clone());
                }
            }
        }
        RequestIntent {
            head: r.head.clone(),
            title: r.title.clone(),
            body: replacement.clone().unwrap_or_else(|| r.body.clone()),
            labels,
        }
    } else {
        if o.update_body || o.update_references || o.ready {
            return Err(Diagnostic::input(
                "Create or adopt a draft request before updating or marking it ready.",
            ));
        }
        if selected.request_write_started {
            return Err(Diagnostic::new(
                Code::AmbiguousRequest,
                "pr",
                "A prior request creation may have applied without a confirmed response.",
                "Inspect native requests and adopt its exact --request ID; automatic creation is stopped.",
            ));
        }
        let title = o.title.clone().unwrap_or_else(|| issues[0].title.clone());
        let vars = BTreeMap::from([
            ("title", title.clone()),
            ("summary", title.clone()),
            (
                "issues",
                selected
                    .issues
                    .iter()
                    .map(|n| format!("Closes #{n}"))
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
        ]);
        let p = templates::prepare(
            &w.context.root,
            w.specification().request_template(),
            w.specification().language(),
            false,
            o.body_file.as_deref(),
            &vars,
        )?;
        let title = p.title.unwrap_or(title);
        let labels = w.specification().selected_labels(
            &title,
            o.tags
                .as_deref()
                .or_else(|| (!p.labels.is_empty()).then_some(p.labels.as_slice())),
            &pool,
        )?;
        RequestIntent {
            head: w.context.head.clone(),
            title,
            body: spec::with_references(&p.body, &selected.issues)?,
            labels,
        }
    };
    for id in spec::references(&intended.body)? {
        if !selected.issues.contains(&id) {
            let issue = native_delivery::issue(&w.reader, repo, w.facts.id, id).await?;
            validate(
                w.specification(),
                true,
                &issue.title,
                &issue.body,
                &issue.labels,
            )?;
            selected.issues.push(id);
            issues.push(issue);
        }
    }
    validate(
        w.specification(),
        false,
        &intended.title,
        &intended.body,
        &intended.labels,
    )?;
    if repo.provider == Provider::Gitlab && (request.is_none() || replacement.is_some()) {
        templates::reject_quick_actions(&intended.body)?;
    }
    // Inspect/adoption of a terminal request does not require a deleted source branch.
    if request.is_none() || replacement.is_some() || o.ready {
        let source = native_delivery::branch_head(&w.reader, repo, branch).await?;
        if source != w.context.head {
            return Ok(Report::success(
                "pr",
                "pending_request",
                serde_json::json!({"reason":"source_head_not_pushed","local_head":w.context.head,"native_head":source}),
            ));
        }
        if request
            .as_ref()
            .is_some_and(|r| r.head != source || !["open", "opened"].contains(&r.state.as_str()))
        {
            return Err(Diagnostic::input(
                "Only the current open native head can be updated.",
            ));
        }
        let target = native_delivery::branch_head(&w.reader, repo, &w.target).await?;
        if request.is_none()
            && !native_delivery::has_changes(&w.reader, repo, &target, &source).await?
        {
            return Ok(Report::success(
                "pr",
                "pending_request",
                serde_json::json!({"reason":"no_real_diff","source":source,"target":target}),
            ));
        }
        if native_delivery::branch_head(&w.reader, repo, branch).await? != source
            || native_delivery::branch_head(&w.reader, repo, &w.target).await? != target
        {
            return Err(changed());
        }
    }
    let missing_labels: Vec<_> = intended
        .labels
        .iter()
        .filter(|label| !pool.contains(label))
        .cloned()
        .collect();
    if o.inspect || o.dry_run {
        return Ok(Report::success(
            "pr",
            "prepared",
            serde_json::json!({"request":request,"intent":intended,"issues":issues,"flow":crate::init::flow(&w.facts,Some(&w.target)),"repository":repo,"project_id":w.facts.id,"source":branch,"target":w.target,"writes":false,"missing_labels":missing_labels,"label_creation_requested":o.create_labels,"ready_requested":o.ready,"body_update_requested":replacement.is_some(),"create_request":request.is_none()}),
        ));
    }
    if !o.create_labels && !missing_labels.is_empty() {
        return Err(Diagnostic::new(
            Code::ConfirmationRequired,
            "pr",
            "Selected request labels are missing from the native project.",
            "Inspect --dry-run and explicitly request --create-labels, or use existing labels.",
        ));
    }
    let mut lock = Locked::acquire(&w.context)?;
    if serde_json::to_value(selection::read(&w.context)?).ok()
        != serde_json::to_value(&previous).ok()
    {
        return Err(changed());
    }
    w.unchanged().await?;
    let writer = RequestWrite::new(w.process.clone(), &w.context.root, repo)?;
    if request.is_none() {
        selected.request_intent = Some(intended.clone());
        selected.request_write_started = true;
        let local_effect = effects.begin(
            "local",
            "save_selection",
            serde_json::json!({"branch":selected.branch,"repository":selected.repository}),
        );
        lock.save(&selected)?;
        effects.applied(local_effect);
        let create_effect = effects.begin("native", "create_request", serde_json::json!({"repository":repo,"source":branch,"target":w.target,"next_action":"inspect_source_requests_then_adopt_exact_id"}));
        let number = writer
            .create_request(branch, &w.target, &intended.title, &intended.body)
            .await?;
        effects.locator(create_effect, "request", number);
        selected.request = Some(number);
        let local_effect = effects.begin(
            "local",
            "save_selection",
            serde_json::json!({"branch":selected.branch,"repository":selected.repository}),
        );
        lock.save(&selected)?;
        effects.applied(local_effect);
        let created = native_delivery::pull_request(&w.reader, repo, number).await?;
        identity(&w, &created)?;
        if created.head != intended.head
            || !native_delivery::written_body_matches(repo.provider, &intended.body, &created.body)
            || !created.draft
        {
            return Err(changed());
        }
        effects.applied(create_effect);
        request = Some(created);
    }
    let mut r = request.ok_or_else(changed)?;
    selected.request = Some(r.id);
    let local_effect = effects.begin(
        "local",
        "save_selection",
        serde_json::json!({"branch":selected.branch,"repository":selected.repository}),
    );
    lock.save(&selected)?;
    effects.applied(local_effect);
    // A native edit after the prepared read stops before any body/label/ready write.
    if native_delivery::pull_request(&w.reader, repo, r.id).await? != r {
        return Err(changed());
    }
    if let Some(body) = replacement
        .filter(|body| !native_delivery::written_body_matches(repo.provider, body, &r.body))
    {
        w.unchanged().await?;
        let request_effect = effects.begin("native", "update_request_body", serde_json::json!({"repository":repo,"request":r.id,"next_action":"read_native_request_before_retry"}));
        writer.update_request_body(r.id, &body).await?;
        let after = native_delivery::pull_request(&w.reader, repo, r.id).await?;
        identity(&w, &after)?;
        if after.head != r.head
            || !native_delivery::written_body_matches(repo.provider, &body, &after.body)
            || after.title != r.title
            || after.labels != r.labels
            || after.state != r.state
            || after.draft != r.draft
        {
            return Err(changed());
        }
        effects.applied(request_effect);
        r = after;
    }
    let missing: Vec<_> = intended
        .labels
        .iter()
        .filter(|name| !r.labels.contains(name))
        .cloned()
        .collect();
    if !missing.is_empty() {
        let catalog = w.specification().catalog();
        for label in &missing {
            if !native_delivery::label_pool(&w.reader, repo)
                .await?
                .contains(label)
            {
                if !o.create_labels {
                    return Err(Diagnostic::new(
                        Code::ConfirmationRequired,
                        "label",
                        "A selected label disappeared after preflight.",
                        "Inspect the native pool before explicitly requesting label creation.",
                    ));
                }
                w.unchanged().await?;
                let label_effect = effects.begin("native", "create_label", serde_json::json!({"repository":repo,"label":label,"next_action":"read_native_label_pool_before_retry"}));
                writer
                    .create_label(catalog.get(label).ok_or_else(|| {
                        Diagnostic::input("A required existing label disappeared from its pool.")
                    })?)
                    .await?;
                if !native_delivery::label_pool(&w.reader, repo)
                    .await?
                    .contains(label)
                {
                    return Err(changed());
                }
                effects.applied(label_effect);
            }
        }
        if native_delivery::pull_request(&w.reader, repo, r.id).await? != r {
            return Err(changed());
        }
        w.unchanged().await?;
        let request_effect = effects.begin("native", "add_request_labels", serde_json::json!({"repository":repo,"request":r.id,"next_action":"read_native_request_before_retry"}));
        writer.add_request_labels(r.id, &missing).await?;
        let after = native_delivery::pull_request(&w.reader, repo, r.id).await?;
        identity(&w, &after)?;
        if after.head != r.head
            || after.body != r.body
            || after.title != r.title
            || after.state != r.state
            || after.draft != r.draft
            || !intended.labels.iter().all(|n| after.labels.contains(n))
            || !r.labels.iter().all(|n| after.labels.contains(n))
        {
            return Err(changed());
        }
        effects.applied(request_effect);
        r = after;
    }
    validate(w.specification(), false, &r.title, &r.body, &r.labels)?;
    if o.ready && r.draft {
        if native_delivery::pull_request(&w.reader, repo, r.id).await? != r {
            return Err(changed());
        }
        w.unchanged().await?;
        let request_effect = effects.begin("native", "ready_request", serde_json::json!({"repository":repo,"request":r.id,"next_action":"read_native_request_before_retry"}));
        writer.ready(r.id).await?;
        let after = native_delivery::pull_request(&w.reader, repo, r.id).await?;
        identity(&w, &after)?;
        if after.head != r.head
            || after.body != r.body
            || after.draft
            || after.state != r.state
            || after.labels != r.labels
        {
            return Err(changed());
        }
        effects.applied(request_effect);
        r = after;
    }
    selected.request_intent = None;
    let local_effect = effects.begin(
        "local",
        "save_selection",
        serde_json::json!({"branch":selected.branch,"repository":selected.repository}),
    );
    lock.save(&selected)?;
    effects.applied(local_effect);
    Ok(Report::success(
        "pr",
        if r.draft { "draft" } else { "bound" },
        serde_json::json!({"request":r,"selection":selected,"issues":issues,"flow":crate::init::flow(&w.facts,Some(&w.target)),"body_concurrency":"prewrite_read_and_readback"}),
    ))
}
fn identity(w: &Workspace, r: &PullRequest) -> Result<(), Diagnostic> {
    if r.source_project != w.facts.id
        || r.target_project != w.facts.id
        || r.source != w.branch()?
        || r.target != w.target
    {
        return Err(Diagnostic::new(
            Code::IdentityMismatch,
            "pr",
            "Request source/project/target differs from the selected same-project delivery.",
            "Select the exact request and reconcile branch/target explicitly; fork-write bootstrap is unsupported.",
        ));
    }
    Ok(())
}
fn validate(
    d: spec::Specification<'_>,
    issue: bool,
    title: &str,
    body: &str,
    labels: &[String],
) -> Result<(), Diagnostic> {
    let violations = d.check(issue, title, body, labels);
    if let Some(v) = violations.first() {
        Err(Diagnostic::input(&v.message))
    } else {
        Ok(())
    }
}
fn changed() -> Diagnostic {
    Diagnostic::new(
        Code::ConcurrentEdit,
        "pr",
        "The request or local selection changed during the operation.",
        "Read the current native content and resume with its exact ID; a prior write may have applied.",
    )
}
