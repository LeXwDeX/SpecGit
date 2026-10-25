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
    /// Read this exact request with --status, or adopt it for delivery; otherwise resume/discover locally.
    #[arg(long)]
    pub request: Option<u64>,
    #[arg(long)]
    pub title: Option<String>,
    #[arg(long)]
    pub body_file: Option<PathBuf>,
    /// Comma-separated labels for a new PR/MR per validation.labels; when omitted, repository template labels
    /// apply first. kind derives one kind::<type> from the title when omitted, and explicit tags need exactly
    /// one kind; project requires declared tags; off: pass only when the user or project asks.
    #[arg(long, value_delimiter = ',')]
    pub tags: Option<Vec<String>>,
    /// Preview a body replacement with --dry-run; differing bodies require native editing.
    #[arg(long, requires = "body_file", conflicts_with = "update_references")]
    pub update_body: bool,
    /// Preview missing closing references with --dry-run; apply through native editing.
    #[arg(long, conflicts_with = "body_file")]
    pub update_references: bool,
    #[arg(long)]
    pub ready: bool,
    #[arg(long, conflicts_with_all = ["ready", "update_body", "update_references"])]
    pub inspect: bool,
    /// Read native lifecycle facts; an explicit --request permits same-repository cross-checkout reads.
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
        let observation = if let Some(request) = options.request {
            crate::observation::observe_explicit(request, process.clone(), cwd).await
        } else {
            crate::observation::observe(None, process.clone(), cwd).await
        };
        let retired = retire_delivered(&process, cwd, &observation).await;
        let recovery = observation
            .evidence
            .request
            .as_ref()
            .map(|r| serde_json::json!({"branch":r.source,"request":r.id}))
            .unwrap_or_else(|| serde_json::json!({}));
        let mut report = Report::observation("pr.status", observation);
        match retired {
            Ok(Some((branch, request))) => {
                let mut effects = Effects::default();
                let index = effects.begin(
                    "local",
                    "record_delivered_checkpoint",
                    serde_json::json!({"branch":branch,"request":request}),
                );
                effects.applied(index);
                report.effects = Some(effects);
            }
            Ok(None) => {}
            Err(failure) => {
                let record_attempted = failure.record_attempted;
                let d =
                    selection::delivered_persistence_failure(failure.diagnostic, record_attempted);
                crate::report::local_failure(
                    &mut report,
                    "record_delivered_checkpoint",
                    recovery,
                    d,
                    record_attempted,
                );
            }
        }
        return report;
    }
    let mut effects = Effects::default();
    let mut report = match execute(options, process, cwd, &mut effects).await {
        Ok(r) => r,
        Err(d) => Report::failure("pr", d),
    };
    report.effects = Some(effects);
    report
}
mod preparation;
mod write;

/// A failed retirement keeps its stage so a read failure never claims a write.
struct RetireFailure {
    diagnostic: Diagnostic,
    record_attempted: bool,
}
impl RetireFailure {
    fn prepare(diagnostic: Diagnostic) -> Self {
        Self {
            diagnostic,
            record_attempted: false,
        }
    }
    fn record(diagnostic: Diagnostic) -> Self {
        Self {
            diagnostic,
            record_attempted: true,
        }
    }
}

/// Record that this worktree's checkpoint was delivered when the verified read
/// shows its own request merged. The record only stops new commits.
async fn retire_delivered(
    process: &Process,
    cwd: &Path,
    observation: &crate::observation::Observation,
) -> Result<Option<(String, u64)>, RetireFailure> {
    use crate::observation::Status;
    let (Some(request), Some(project_id)) = (
        observation.evidence.request.as_ref(),
        observation.evidence.project_id,
    ) else {
        return Ok(None);
    };
    if !matches!(
        observation.status,
        Status::Merged | Status::Completed | Status::MergedIssuesOpen
    ) || !observation.diagnostics.is_empty()
    {
        return Ok(None);
    }
    let bytes = crate::project::git(process, cwd, &["rev-parse", "--show-toplevel"])
        .await
        .map_err(RetireFailure::prepare)?;
    let root = PathBuf::from(
        String::from_utf8(bytes)
            .map_err(|_| Diagnostic::input("Invalid Git root."))
            .map_err(RetireFailure::prepare)?
            .trim_end_matches(['\r', '\n']),
    );
    let Some(declaration) = crate::config::read(&root).map_err(RetireFailure::prepare)? else {
        return Ok(None);
    };
    let context = crate::config::resolve(
        process,
        &root,
        declaration.remote.as_deref(),
        declaration.provider,
        None,
    )
    .await
    .map_err(RetireFailure::prepare)?;
    if observation.evidence.repository.as_ref() != Some(&context.repository) {
        return Ok(None);
    }
    Ok(selection::record_delivery(&context, project_id, request)
        .map_err(RetireFailure::record)?
        .map(|id| (request.source.clone(), id)))
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
    let prepared = match preparation::prepare(&o, process, cwd).await? {
        preparation::Outcome::Ready(prepared) => *prepared,
        preparation::Outcome::Deferred(report) => return Ok(*report),
    };
    write::apply(&o, prepared, effects).await
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
    provider: crate::identity::Provider,
    issue: bool,
    title: &str,
    body: &str,
    labels: &[String],
) -> Result<(), Diagnostic> {
    let violations = d.check(
        issue,
        title,
        body,
        &spec::canonical_labels(provider, labels),
    );
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
