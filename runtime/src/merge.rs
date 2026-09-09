//! Explicit native merge delegation. No fallback mutation or closure capability.
use crate::{
    assets::{AssetStore, Snapshot},
    delivery_context::Workspace,
    diagnostic::{Code, Diagnostic},
    finish,
    native_delivery::{self, ForgeWrite, PullRequest},
    process::Process,
    project::Provider,
    report::Report,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};

#[derive(Debug, Clone, Copy, clap::ValueEnum, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Now,
    Auto,
}
#[derive(Debug, Clone, Copy, clap::ValueEnum, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Strategy {
    Merge,
    Squash,
    Rebase,
}
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
fn route(w: &Workspace, number: u64) -> String {
    format!(
        "{}/{}/{number}",
        native_delivery::prefix(&w.context.repository),
        if w.context.repository.provider == Provider::Github {
            "pulls"
        } else {
            "merge_requests"
        }
    )
}
fn queued(raw: &Value, provider: Provider) -> bool {
    if provider == Provider::Github {
        // REST exposes an enabled native auto-merge request; an opaque queue-only
        // response remains unknown rather than being inferred from CLI stdout.
        raw.get("auto_merge").is_some_and(|v| {
            v.is_object()
                && v.get("merge_method")
                    .and_then(Value::as_str)
                    .is_some_and(|s| ["merge", "squash", "rebase"].contains(&s))
                && v.pointer("/enabled_by/id")
                    .and_then(Value::as_u64)
                    .is_some_and(|id| id > 0)
        })
    } else {
        raw.get("merge_when_pipeline_succeeds")
            .and_then(Value::as_bool)
            == Some(true)
    }
}
async fn readback(w: &Workspace, expected: &PullRequest) -> Result<Option<Report>, Diagnostic> {
    let raw = w.reader.get(&route(w, expected.id)).await?;
    let r = native_delivery::request_value(&raw, &w.context.repository, expected.id)?;
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
        let mut report = finish::run(
            finish::Options {
                request: Some(r.id),
            },
            w.process.clone(),
            &w.context.root,
        )
        .await;
        report.operation = "merge".into();
        return Ok(Some(report));
    }
    if ["open", "opened"].contains(&r.state.as_str())
        && !r.draft
        && queued(&raw, w.context.repository.provider)
    {
        return Ok(Some(Report::success(
            "merge",
            "queued",
            json!({"request":r,"native_auto_merge":true,"completed":false}),
        )));
    }
    Ok(None)
}
pub async fn run(o: Options, process: Process, cwd: &Path) -> Report {
    match Box::pin(execute(o, process, cwd)).await {
        Ok(r) => r,
        Err(d) => Report::failure("merge", d),
    }
}
async fn execute(o: Options, process: Process, cwd: &Path) -> Result<Report, Diagnostic> {
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
    if repo.provider == Provider::Gitlab {
        if o.strategy == Strategy::Rebase {
            return Err(unknown(
                "GitLab rebase is a separate head-changing operation and is not delegated by merge.",
            ));
        }
        // Older GitLab APIs can bypass trains. Require explicit native evidence
        // that trains are disabled until the train API is separately qualified.
        let project = w.reader.get(&native_delivery::prefix(repo)).await?;
        if project.get("id").and_then(Value::as_u64) != Some(w.facts.id)
            || project.get("merge_trains_enabled").and_then(Value::as_bool) != Some(false)
        {
            return Err(unknown(
                "GitLab merge-train routing is enabled or cannot be proven disabled.",
            ));
        }
    }
    let mut assessment = finish::run(
        finish::Options {
            request: Some(r.id),
        },
        w.process.clone(),
        cwd,
    )
    .await;
    assessment.operation = "merge".into();
    if !["accepted", "accepted_initial_adoption"].contains(&assessment.status.as_str())
        || assessment.exit != 0
    {
        return Ok(assessment);
    }
    let current = native_delivery::pull_request(&w.reader, repo, r.id).await?;
    if current != r
        || assessment.evidence["request"]
            != serde_json::to_value(&r)
                .map_err(|_| unknown("Request identity cannot be serialized."))?
    {
        return Err(unknown(
            "The request changed between selection and fresh acceptance.",
        ));
    }
    w.unchanged().await?;
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
