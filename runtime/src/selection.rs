//! Ignored worktree locators and write intent. Native references remain binding authority.
use crate::{
    assets::{AssetStore, Snapshot},
    diagnostic::{Code, Diagnostic},
    identity::Repository,
    project::Context,
};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct IssueIntent {
    pub title: String,
    pub body: String,
    pub labels: Vec<String>,
    pub issue: Option<u64>,
    pub write_started: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    pub version: u8,
    pub repository: Repository,
    pub project_id: u64,
    pub branch: String,
    pub target: String,
    pub issues: Vec<u64>,
    pub intents: Vec<IssueIntent>,
    /// Validated native specs adopted independently of creation/recovery intents.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub adopted: Vec<crate::delivery_model::Issue>,
    pub request: Option<u64>,
    pub request_write_started: bool,
    #[serde(default)]
    pub request_intent: Option<RequestIntent>,
    /// The checkpoint's own request was read back merged. The checkpoint then
    /// admits no new commits; it is a local fact, never write authorization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivered_request: Option<u64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestIntent {
    pub head: String,
    pub title: String,
    pub body: String,
    pub labels: Vec<String>,
}
/// Public, redacted metadata for a valid checkpoint owned by another branch.
///
/// `status` is `delivered` when the recorded request merged and no write is pending;
/// such a checkpoint has nothing to resume and only gives way to new work.
#[derive(Debug, Clone, Serialize)]
pub struct BranchMismatch {
    pub status: &'static str,
    pub path: PathBuf,
    pub recorded_branch: String,
    pub recorded_target: String,
    pub recorded_project_id: u64,
    pub current_branch: Option<String>,
    pub pending_write: bool,
    pub write_eligible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivered_request: Option<u64>,
}
impl BranchMismatch {
    pub fn delivered(&self) -> bool {
        self.delivered_request.is_some()
    }
}
/// Ownership classification for callers that explicitly support read-only foreign checkpoints.
#[derive(Debug, Clone)]
pub enum ReadOutcome {
    Absent,
    Current(Selection),
    BranchMismatch {
        selection: Selection,
        checkpoint: BranchMismatch,
    },
}
fn invalid() -> Diagnostic {
    Diagnostic::new(
        Code::OwnershipConflict,
        "selection",
        "The local delivery checkpoint is invalid or belongs to another project/branch.",
        "Inspect the checkpoint and adopt explicit native IDs in the correct worktree; do not discard an unresolved write intent.",
    )
}
impl Selection {
    pub fn checkpoint_valid(&self, target: Option<&str>) -> bool {
        self.delivered_request.is_none()
            && !self.issues.is_empty()
            && target.is_none_or(|target| target == self.target)
            && self.issues.iter().all(|id| {
                self.intents.iter().any(|intent| intent.issue == Some(*id))
                    || self.adopted.iter().any(|issue| issue.id == *id)
            })
    }
    /// An unconfirmed native write that must stay visible until it is adopted.
    pub fn pending_write(&self) -> bool {
        self.intents
            .iter()
            .any(|intent| intent.write_started && intent.issue.is_none())
            || (self.request_write_started && self.request.is_none())
    }
    /// A delivered checkpoint without pending writes may give way to new work.
    pub fn replaceable(&self) -> bool {
        self.delivered_request.is_some() && !self.pending_write()
    }
    pub fn record_adopted(&mut self, issue: crate::delivery_model::Issue) {
        self.adopted.retain(|old| old.id != issue.id);
        self.adopted.push(issue);
    }
}
pub fn path(context: &Context) -> PathBuf {
    context.git_dir.join("specgit-v2/selection.json")
}
pub fn read_path(path: &Path) -> Result<Option<Selection>, Diagnostic> {
    let snapshot = Snapshot::read(path)?;
    let Some(bytes) = snapshot.bytes else {
        return Ok(None);
    };
    let value = crate::input::json(&bytes, crate::declaration::MAX_BYTES, 16)?;
    let s: Selection = serde_json::from_value(value).map_err(|_| invalid())?;
    validate(&s)?;
    Ok(Some(s))
}
fn validate(s: &Selection) -> Result<(), Diagnostic> {
    if s.version != 2
        || s.project_id == 0
        || !crate::declaration::valid_branch(&s.branch)
        || !crate::declaration::valid_branch(&s.target)
        || s.issues.len() > 100
        || s.issues.contains(&0)
        || s.adopted.len() > 100
        || s.adopted
            .iter()
            .any(|i| i.id == 0 || !s.issues.contains(&i.id) || i.title.trim().is_empty())
        || s.intents.len() > 100
        || s.request == Some(0)
        || s.delivered_request == Some(0)
        || s.issues
            .iter()
            .enumerate()
            .any(|(i, id)| s.issues[..i].contains(id))
        || s.intents
            .iter()
            .any(|i| i.issue == Some(0) || i.labels.len() > 100 || i.title.trim().is_empty())
    {
        return Err(invalid());
    }
    Ok(())
}
/// Read a checkpoint for mutation-capable flows, rejecting every ownership mismatch.
pub fn read(context: &Context) -> Result<Option<Selection>, Diagnostic> {
    match classify(context)? {
        ReadOutcome::Absent => Ok(None),
        ReadOutcome::Current(selection) => Ok(Some(selection)),
        ReadOutcome::BranchMismatch { checkpoint, .. } => {
            Err(branch_mismatch_diagnostic(&checkpoint))
        }
    }
}
/// Classify a valid same-repository checkpoint without exposing its intent in reports.
///
/// Native operations must separately verify the recorded project ID and target.
/// Offline diagnostics report recorded identity without claiming remote verification.
pub fn classify(context: &Context) -> Result<ReadOutcome, Diagnostic> {
    let checkpoint_path = path(context);
    let Some(selection) = read_path(&checkpoint_path)? else {
        return Ok(ReadOutcome::Absent);
    };
    if selection.repository != context.repository {
        return Err(invalid());
    }
    if Some(&selection.branch) == context.branch.as_ref() {
        return Ok(ReadOutcome::Current(selection));
    }
    let delivered_request = selection
        .replaceable()
        .then_some(selection.delivered_request)
        .flatten();
    let checkpoint = BranchMismatch {
        status: if delivered_request.is_some() {
            "delivered"
        } else {
            "branch_mismatch"
        },
        delivered_request,
        path: checkpoint_path,
        recorded_branch: selection.branch.clone(),
        recorded_target: selection.target.clone(),
        recorded_project_id: selection.project_id,
        current_branch: context.branch.clone(),
        pending_write: selection
            .intents
            .iter()
            .any(|intent| intent.write_started && intent.issue.is_none())
            || (selection.request_write_started && selection.request.is_none()),
        write_eligible: false,
    };
    Ok(ReadOutcome::BranchMismatch {
        selection,
        checkpoint,
    })
}
/// Build the strict failure used when a mutation-capable flow crosses branches.
pub fn branch_mismatch_diagnostic(checkpoint: &BranchMismatch) -> Diagnostic {
    Diagnostic::new(
        Code::OwnershipConflict,
        "selection_branch",
        &format!(
            "The delivery checkpoint at {} belongs to branch '{}', not the current branch {}.",
            checkpoint.path.display(),
            checkpoint.recorded_branch,
            checkpoint
                .current_branch
                .as_deref()
                .unwrap_or("<detached HEAD>")
        ),
        "Return to the recorded branch or use a separate worktree for independent delivery; the checkpoint remains unchanged.",
    )
}
pub struct Locked {
    store: AssetStore,
    path: PathBuf,
    expected: Snapshot,
}
impl Locked {
    pub fn acquire(context: &Context) -> Result<Self, Diagnostic> {
        let path = path(context);
        let store = AssetStore::lock(
            &context.git_dir.join("specgit-v2/delivery-transactions"),
            &[context.git_dir.join("specgit-v2")],
            Duration::from_secs(2),
        )?;
        let expected = Snapshot::read(&path)?;
        Ok(Self {
            store,
            path,
            expected,
        })
    }
    pub fn save(&mut self, selection: &Selection) -> Result<(), Diagnostic> {
        validate(selection)?;
        let bytes = serde_json::to_vec_pretty(selection).map_err(|_| invalid())?;
        if bytes.len() > crate::declaration::MAX_BYTES {
            return Err(Diagnostic::input(
                "Delivery checkpoint exceeds 1 MiB; use smaller independently verifiable specs.",
            ));
        }
        self.store.checkpoint(&self.path, &self.expected, &bytes)?;
        self.expected = Snapshot::read(&self.path)?;
        Ok(())
    }
}

/// Keep the verified native facts and name a concrete retry for a failed local record.
///
/// `record_attempted` distinguishes a failure while reading Git/declaration
/// inputs from a failure after the local record path was entered. Only the
/// latter may describe a local write outcome.
pub(crate) fn delivered_persistence_failure(d: Diagnostic, record_attempted: bool) -> Diagnostic {
    if record_attempted {
        Diagnostic::new(
            d.code,
            "delivered_checkpoint",
            &format!(
                "The verified delivered checkpoint could not be recorded locally. {}",
                d.message
            ),
            "Resolve the reported lock or filesystem permission problem, then rerun `specgit pr --status` for the same verified request. The local record is idempotent: a writable checkpoint records delivery once, and this failure does not change the verified native merge or Issue facts.",
        )
    } else {
        Diagnostic::new(
            d.code,
            "delivered_checkpoint_prepare",
            &format!(
                "The verified delivered checkpoint could not be prepared locally. {}",
                d.message
            ),
            "Resolve the reported Git, declaration or filesystem problem, then rerun `specgit pr --status` for the same verified request. No local delivery record was attempted, and the verified native merge or Issue facts are unchanged.",
        )
    }
}

/// Retire the current branch's checkpoint after its recorded request was read
/// back merged into the recorded target. Returns the request ID, or `None` when
/// the checkpoint has no recorded request or the facts identify another one.
pub fn record_delivery(
    context: &Context,
    project_id: u64,
    request: &crate::delivery_model::PullRequest,
) -> Result<Option<u64>, Diagnostic> {
    let matches = |s: &Selection| {
        request.state == "merged"
            && request.id != 0
            && s.delivered_request.is_none()
            && !s.pending_write()
            && s.project_id == project_id
            && request.source_project == project_id
            && request.target_project == project_id
            && request.source == s.branch
            && request.target == s.target
            && s.request == Some(request.id)
    };
    // Only this branch's own checkpoint can be retired; others stay untouched.
    let current = || match classify(context)? {
        ReadOutcome::Current(selection) if matches(&selection) => Ok(Some(selection)),
        _ => Ok::<_, Diagnostic>(None),
    };
    if current()?.is_none() {
        return Ok(None);
    }
    let mut locked = Locked::acquire(context)?;
    // Recheck under the lock; a concurrent selection change wins.
    let Some(mut selection) = current()? else {
        return Ok(None);
    };
    selection.delivered_request = Some(request.id);
    locked.save(&selection)?;
    Ok(Some(request.id))
}
