//! Explicit native merge delegation. No fallback mutation or closure capability.
use crate::{
    assessment::Assessment,
    assets::{AssetStore, Snapshot},
    delivery_context::Workspace,
    diagnostic::{Code, Diagnostic},
    forge,
    native_delivery::{self, ForgeWrite, PullRequest},
    observation,
    process::Process,
    project::Provider,
    report::Report,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{path::Path, time::Duration};

pub use crate::delivery_model::{Mode, Strategy};
#[derive(Debug, clap::Args)]
pub struct Options {
    /// Exact request to merge. This command never creates or marks a request ready.
    #[arg(long)]
    pub request: u64,
    /// Explicitly authorize immediate native delegation or native auto-merge.
    #[arg(long, value_enum)]
    pub mode: Mode,
    #[arg(long, value_enum)]
    pub strategy: Strategy,
}
#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Intent {
    version: u8,
    repository: crate::project::Repository,
    request: u64,
    head: String,
    target: String,
    mode: Mode,
    strategy: Strategy,
}
fn unknown(message: &str) -> Diagnostic {
    Diagnostic::new(
        Code::UnsupportedOperation,
        "merge",
        message,
        "Inspect the exact request in the native forge. No fallback merge, issue closure or branch deletion was attempted.",
    )
}
async fn readback(w: &Workspace, expected: &PullRequest) -> Result<Option<Outcome>, Diagnostic> {
    let observed = forge::request(&w.reader, &w.context.repository, expected.id).await?;
    let r = &observed.facts;
    if r.head != expected.head
        || r.source != expected.source
        || r.target != expected.target
        || r.source_project != expected.source_project
        || r.target_project != expected.target_project
    {
        return Err(unknown(
            "The request identity changed after native merge delegation.",
        ));
    }
    if r.state == "merged" {
        return Ok(Some(Outcome::Assessed(
            observation::observe(Some(r.id), w.process.clone(), &w.context.root).await,
        )));
    }

    if ["open", "opened"].contains(&r.state.as_str()) && !r.draft && observed.queued() {
        return Ok(Some(Outcome::Queued(r.clone())));
    }
    Ok(None)
}
pub async fn run(o: Options, process: Process, cwd: &Path) -> Report {
    match Box::pin(execute(o, process, cwd)).await {
        Ok(Outcome::Assessed(a)) => Report::assessment("merge", a),
        Ok(Outcome::Queued(r)) => Report::success(
            "merge",
            "queued",
            json!({"request":r,"native_auto_merge":true,"completed":false}),
        ),
        Err(d) => Report::failure("merge", d),
    }
}
enum Outcome {
    Assessed(Assessment),
    Queued(PullRequest),
}
async fn execute(o: Options, process: Process, cwd: &Path) -> Result<Outcome, Diagnostic> {
    if o.request == 0 {
        return Err(Diagnostic::input("Request IDs must be positive."));
    }
    let w = Workspace::load(process, cwd).await?;
    let repo = &w.context.repository;
    let root = w.context.git_dir.join("specgit-v2");
    // Share the delivery lock with issue/pr writes throughout assessment and submission.
    let store = AssetStore::lock(
        &root.join("delivery-transactions"),
        std::slice::from_ref(&root),
        Duration::from_secs(2),
    )?;
    let r = native_delivery::pull_request(&w.reader, repo, o.request).await?;
    if r.head != w.context.head
        || r.source != w.branch()?
        || r.target != w.target
        || r.target_project != w.facts.id
        || r.source_project != w.facts.id
    {
        return Err(unknown(
            "Merge requires the exact selected same-project source/head/target.",
        ));
    }
    // Native terminal/queued state is observed on every invocation, including recovery.
    if let Some(report) = readback(&w, &r).await? {
        return Ok(report);
    }
    let path = root.join(format!("merge-{}-{}.json", r.id, r.head));
    let before = Snapshot::read(&path)?;
    if let Some(bytes) = &before.bytes {
        let intent: Intent =
            serde_json::from_value(crate::input::json(bytes, crate::config::MAX_BYTES, 16)?)
                .map_err(|_| unknown("The prior native merge intent is malformed."))?;
        let detail = if intent.version == 2
            && intent.repository == *repo
            && intent.request == r.id
            && intent.head == r.head
        {
            "A prior submission has no confirmed terminal or queued result; automatic resubmission is stopped."
        } else {
            "The stored merge intent belongs to a different identity."
        };
        return Err(unknown(detail));
    }
    let capability = if repo.provider == Provider::Gitlab {
        Some(forge::gitlab::capability(&w.reader, repo, w.facts.id, &r, o.mode, o.strategy).await?)
    } else {
        None
    };
    let assessment = observation::observe(Some(r.id), w.process.clone(), cwd).await;
    if !assessment.accepted() {
        return Ok(Outcome::Assessed(assessment));
    }
    let current = native_delivery::pull_request(&w.reader, repo, r.id).await?;
    if current != r || assessment.evidence.request.as_ref() != Some(&r) {
        return Err(unknown(
            "The request changed between selection and fresh acceptance.",
        ));
    }
    w.unchanged().await?;
    if let Some(previous) = capability
        && forge::gitlab::capability(&w.reader, repo, w.facts.id, &r, o.mode, o.strategy).await?
            != previous
    {
        return Err(unknown(
            "Native GitLab merge capabilities changed before submission.",
        ));
    }
    let writer = ForgeWrite::new(w.process.clone(), &w.context.root, repo)?;
    let intent = Intent {
        version: 2,
        repository: repo.clone(),
        request: r.id,
        head: r.head.clone(),
        target: r.target.clone(),
        mode: o.mode,
        strategy: o.strategy,
    };
    store.checkpoint(
        &path,
        &before,
        &serde_json::to_vec(&intent).map_err(|_| unknown("Merge intent cannot be saved."))?,
    )?;
    let result = writer.merge(r.id, &r.head, o.mode, o.strategy).await;
    // Even a lost/failed CLI response can follow a successful native write.
    if let Some(report) = readback(&w, &r).await? {
        return Ok(report);
    }
    result?;
    Err(unknown(
        "The native CLI returned success but no queued or merged state was confirmed.",
    ))
}
