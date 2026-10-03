//! Native request writes preserve durable recovery locators and verify every changed field.
use super::preparation::Prepared;
use super::*;

pub(super) async fn apply(
    o: &Options,
    prepared: Prepared,
    effects: &mut Effects,
) -> Result<Report, Diagnostic> {
    let Prepared {
        workspace: w,
        previous,
        mut selected,
        mut request,
        issues,
        intended,
        replacement,
    } = prepared;
    let repo = &w.context.repository;
    let mut lock = Locked::acquire(&w.context)?;
    if serde_json::to_value(selection::read(&w.context)?).ok()
        != serde_json::to_value(&previous).ok()
    {
        return Err(changed());
    }
    w.unchanged().await?;
    let writer = RequestWrite::new(w.process.clone(), &w.context.root, repo)?;
    create_request(
        &w,
        &writer,
        &mut lock,
        &mut selected,
        &mut request,
        &intended,
        effects,
    )
    .await?;
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
    r = update_body(&w, &writer, r, replacement, effects).await?;
    r = add_labels(o, &w, &writer, r, &intended, effects).await?;
    validate(w.specification(), false, &r.title, &r.body, &r.labels)?;
    r = mark_ready(o, &w, &writer, r, effects).await?;
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

async fn create_request(
    w: &Workspace,
    writer: &RequestWrite,
    lock: &mut Locked,
    selected: &mut Selection,
    request: &mut Option<PullRequest>,
    intended: &RequestIntent,
    effects: &mut Effects,
) -> Result<(), Diagnostic> {
    let repo = &w.context.repository;
    let branch = w.branch()?;
    if request.is_none() {
        selected.request_intent = Some(intended.clone());
        selected.request_write_started = true;
        let local_effect = effects.begin(
            "local",
            "save_selection",
            serde_json::json!({"branch":selected.branch,"repository":selected.repository}),
        );
        lock.save(selected)?;
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
        lock.save(selected)?;
        effects.applied(local_effect);
        let created = native_delivery::pull_request(&w.reader, repo, number).await?;
        identity(w, &created)?;
        if created.head != intended.head
            || !native_delivery::written_body_matches(repo.provider, &intended.body, &created.body)
            || !created.draft
        {
            return Err(changed());
        }
        effects.applied(create_effect);
        *request = Some(created);
    }
    Ok(())
}

async fn update_body(
    w: &Workspace,
    writer: &RequestWrite,
    mut r: PullRequest,
    replacement: Option<String>,
    effects: &mut Effects,
) -> Result<PullRequest, Diagnostic> {
    let repo = &w.context.repository;
    if let Some(body) = replacement
        .filter(|body| !native_delivery::written_body_matches(repo.provider, body, &r.body))
    {
        w.unchanged().await?;
        let request_effect = effects.begin("native", "update_request_body", serde_json::json!({"repository":repo,"request":r.id,"next_action":"read_native_request_before_retry"}));
        writer.update_request_body(r.id, &body).await?;
        let after = native_delivery::pull_request(&w.reader, repo, r.id).await?;
        identity(w, &after)?;
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
    Ok(r)
}

async fn add_labels(
    o: &Options,
    w: &Workspace,
    writer: &RequestWrite,
    mut r: PullRequest,
    intended: &RequestIntent,
    effects: &mut Effects,
) -> Result<PullRequest, Diagnostic> {
    let repo = &w.context.repository;
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
        identity(w, &after)?;
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
    Ok(r)
}

async fn mark_ready(
    o: &Options,
    w: &Workspace,
    writer: &RequestWrite,
    mut r: PullRequest,
    effects: &mut Effects,
) -> Result<PullRequest, Diagnostic> {
    let repo = &w.context.repository;
    if o.ready && r.draft {
        if native_delivery::pull_request(&w.reader, repo, r.id).await? != r {
            return Err(changed());
        }
        w.unchanged().await?;
        let request_effect = effects.begin("native", "ready_request", serde_json::json!({"repository":repo,"request":r.id,"next_action":"read_native_request_before_retry"}));
        writer.ready(r.id).await?;
        let after = native_delivery::pull_request(&w.reader, repo, r.id).await?;
        identity(w, &after)?;
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
    Ok(r)
}
