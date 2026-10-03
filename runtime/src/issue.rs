//! Preflight all selected specs before native issue writes; persist intent first.
use crate::{
    config,
    delivery_context::Workspace,
    diagnostic::{Code, Diagnostic},
    native_delivery,
    process::Process,
    project,
    report::{Effects, Report},
    selection::{self, IssueIntent, Locked, Selection},
    spec, templates,
};
use std::{
    collections::{BTreeMap, BTreeSet},
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
    /// Exact review digests from --inspect after comparing candidates and confirming a distinct WHY.
    #[arg(long)]
    pub reviewed_candidates: Vec<String>,
}
pub async fn run(options: Options, process: Process, cwd: &Path) -> Report {
    let mut effects = Effects::default();
    let preflight = process.with_inspection_budget(crate::process::configured_inspection_budget());
    let mut report = match execute(options, preflight.clone(), process, cwd, &mut effects).await {
        Ok(report) => report,
        Err(d) => {
            preflight.mark_inspection_incomplete();
            Report::failure("issue", d)
        }
    };
    report.effects = Some(effects);
    attach_inspection(&mut report, &preflight);
    report
}

fn attach_inspection(report: &mut Report, process: &Process) {
    let Some(summary) = process.inspection_summary() else {
        return;
    };
    if !report.evidence.is_object() {
        report.evidence = serde_json::json!({});
    }
    if let Some(evidence) = report.evidence.as_object_mut() {
        evidence.insert(
            "inspection".into(),
            serde_json::to_value(summary).expect("inspection summary serializes"),
        );
    }
}
mod candidates;
mod preparation;
mod write;

async fn execute(
    mut options: Options,
    process: Process,
    write_process: Process,
    cwd: &Path,
    effects: &mut Effects,
) -> Result<Report, Diagnostic> {
    preparation::normalize(&mut options, cwd)?;
    let mut prepared = preparation::prepare(&options, process, cwd).await?;
    // Keep the project creation lock through candidate reads, writes and readback.
    let _creation_lock = candidates::creation_lock(&options, &prepared)?;
    if let Some(report) = candidates::inspect(&options, &prepared).await? {
        return Ok(report);
    }
    write::apply(&options, &mut prepared, write_process, effects).await
}
fn candidate_review_digest(
    repository: &project::Repository,
    project_id: u64,
    branch: &str,
    target: &str,
    intent: &IssueIntent,
    candidates: &[crate::delivery_model::Issue],
) -> String {
    let review = serde_json::json!({
        "version": 1,
        "repository": repository,
        "project_id": project_id,
        "branch": branch,
        "target": target,
        "title": intent.title,
        "body": intent.body,
        "labels": intent.labels,
        "candidates": candidates,
    });
    crate::assets::hash(review.to_string().as_bytes())
}
fn validate(
    d: spec::Specification<'_>,
    title: &str,
    body: &str,
    labels: &[String],
) -> Result<(), Diagnostic> {
    let errors = d.check(true, title, body, labels);
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
