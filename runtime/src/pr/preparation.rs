//! Resolve same-project request identity and prepare complete references before writes.
use super::*;

pub(super) struct Prepared {
    pub workspace: Workspace,
    pub previous: Option<Selection>,
    pub selected: Selection,
    pub request: Option<PullRequest>,
    pub issues: Vec<crate::delivery_model::Issue>,
    pub intended: RequestIntent,
    pub replacement: Option<String>,
}
pub(super) enum Outcome {
    Ready(Box<Prepared>),
    Deferred(Box<Report>),
}
struct Discovery {
    previous: Option<Selection>,
    selected: Selection,
    request: Option<PullRequest>,
    issues: Vec<crate::delivery_model::Issue>,
    pool: Vec<String>,
}

pub(super) async fn prepare(
    o: &Options,
    process: Process,
    cwd: &Path,
) -> Result<Outcome, Diagnostic> {
    let w = Workspace::load(process, cwd).await?;
    let repo = &w.context.repository;
    let branch = w.branch()?;
    if branch == w.target {
        return Err(Diagnostic::input(
            "Select a delivery branch distinct from its target.",
        ));
    }
    let Discovery {
        previous,
        mut selected,
        request,
        mut issues,
        pool,
    } = discover(o, &w).await?;
    let (intended, replacement) =
        content(o, &w, &request, &mut selected, &mut issues, &pool).await?;
    if let Some(report) = native_heads(o, &w, &request, replacement.is_some()).await? {
        return Ok(Outcome::Deferred(Box::new(report)));
    }
    let missing_labels: Vec<_> = intended
        .labels
        .iter()
        .filter(|label| !pool.contains(label))
        .cloned()
        .collect();
    if o.inspect || o.dry_run {
        return Ok(Outcome::Deferred(Box::new(Report::success(
            "pr",
            "prepared",
            serde_json::json!({"request":request,"intent":intended,"issues":issues,"flow":crate::init::flow(&w.facts,Some(&w.target)),"repository":repo,"project_id":w.facts.id,"source":branch,"target":w.target,"writes":false,"missing_labels":missing_labels,"label_creation_requested":o.create_labels,"ready_requested":o.ready,"body_update_requested":replacement.is_some(),"create_request":request.is_none()}),
        ))));
    }
    if !o.create_labels && !missing_labels.is_empty() {
        return Err(Diagnostic::new(
            Code::ConfirmationRequired,
            "pr",
            "Selected request labels are missing from the native project.",
            "Inspect --dry-run and explicitly request --create-labels, or use existing labels.",
        ));
    }
    if replacement.as_ref().is_some_and(|body| {
        request
            .as_ref()
            .is_some_and(|r| !native_delivery::written_body_matches(repo.provider, body, &r.body))
    }) {
        return Err(Diagnostic::new(
            Code::UnsupportedOperation,
            "update_request_body",
            "Atomic conditional body updates are unavailable; the native body was preserved.",
            "Use --dry-run to review the proposed body and all closing references, edit in the native UI with conflict review, then run pr --status before resuming.",
        ));
    }
    Ok(Outcome::Ready(Box::new(Prepared {
        workspace: w,
        previous,
        selected,
        request,
        issues,
        intended,
        replacement,
    })))
}

async fn discover(o: &Options, w: &Workspace) -> Result<Discovery, Diagnostic> {
    let repo = &w.context.repository;
    let branch = w.branch()?;
    let previous = selection::read(&w.context)?;
    let number = o.request.or(previous.as_ref().and_then(|s| s.request));
    let request = if let Some(number) = number {
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
        identity(w, r)?;
    }
    let mut selected = previous.clone().unwrap_or(Selection {
        version: 2,
        repository: repo.clone(),
        project_id: w.facts.id,
        branch: branch.into(),
        target: w.target.clone(),
        issues: vec![],
        intents: vec![],
        adopted: vec![],
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
    for id in &selected.issues.clone() {
        let issue = native_delivery::issue(&w.reader, repo, w.facts.id, *id).await?;
        validate(
            w.specification(),
            true,
            &issue.title,
            &issue.body,
            &issue.labels,
        )?;
        selected.record_adopted(issue.clone());
        issues.push(issue);
    }
    let pool = native_delivery::label_pool(&w.reader, repo).await?;
    Ok(Discovery {
        previous,
        selected,
        request,
        issues,
        pool,
    })
}

async fn content(
    o: &Options,
    w: &Workspace,
    request: &Option<PullRequest>,
    selected: &mut Selection,
    issues: &mut Vec<crate::delivery_model::Issue>,
    pool: &[String],
) -> Result<(RequestIntent, Option<String>), Diagnostic> {
    let repo = &w.context.repository;
    let (intended, replacement) = if let Some(r) = request {
        existing_content(o, w, r, selected, issues).await?
    } else {
        (draft_content(o, w, selected, issues, pool)?, None)
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
    Ok((intended, replacement))
}

async fn native_heads(
    o: &Options,
    w: &Workspace,
    request: &Option<PullRequest>,
    replacing_body: bool,
) -> Result<Option<Report>, Diagnostic> {
    let repo = &w.context.repository;
    let branch = w.branch()?;
    // Inspect/adoption of a terminal request does not require a deleted source branch.
    if request.is_none() || replacing_body || o.ready {
        let source = native_delivery::branch_head(&w.reader, repo, branch).await?;
        if source != w.context.head {
            return Ok(Some(Report::success(
                "pr",
                "pending_request",
                serde_json::json!({"reason":"source_head_not_pushed","local_head":w.context.head,"native_head":source}),
            )));
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
            return Ok(Some(Report::success(
                "pr",
                "pending_request",
                serde_json::json!({"reason":"no_real_diff","source":source,"target":target}),
            )));
        }
        if native_delivery::branch_head(&w.reader, repo, branch).await? != source
            || native_delivery::branch_head(&w.reader, repo, &w.target).await? != target
        {
            return Err(changed());
        }
    }
    Ok(None)
}

async fn existing_content(
    o: &Options,
    w: &Workspace,
    r: &PullRequest,
    selected: &mut Selection,
    issues: &mut Vec<crate::delivery_model::Issue>,
) -> Result<(RequestIntent, Option<String>), Diagnostic> {
    let repo = &w.context.repository;
    let mut replacement = None;
    if o.title.is_some() || o.tags.is_some() || (o.body_file.is_some() && !o.update_body) {
        return Err(Diagnostic::input(
            "Existing request content is preserved. Use --update-body with a final body file and --dry-run to preview; edit existing content on the native platform.",
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
            selected.record_adopted(issue.clone());
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
            "The native request lacks selected closing references; use --update-references --dry-run to preview, then reconcile its body on the native platform.",
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
    let intended = RequestIntent {
        head: r.head.clone(),
        title: r.title.clone(),
        body: replacement.clone().unwrap_or_else(|| r.body.clone()),
        labels,
    };
    Ok((intended, replacement))
}

fn draft_content(
    o: &Options,
    w: &Workspace,
    selected: &Selection,
    issues: &[crate::delivery_model::Issue],
    pool: &[String],
) -> Result<RequestIntent, Diagnostic> {
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
        pool,
    )?;
    Ok(RequestIntent {
        head: w.context.head.clone(),
        title,
        body: spec::with_references(&p.body, &selected.issues)?,
        labels,
    })
}
