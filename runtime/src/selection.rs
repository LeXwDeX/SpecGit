//! Ignored worktree locators and write intent. Native references remain binding authority.
use crate::{
    assets::{AssetStore, Snapshot},
    diagnostic::{Code, Diagnostic},
    project::{Context, Repository},
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
    pub request: Option<u64>,
    pub request_write_started: bool,
    #[serde(default)]
    pub request_intent: Option<RequestIntent>,
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
pub fn path(context: &Context) -> PathBuf {
    context.git_dir.join("specgit-v2/selection.json")
}
pub fn read_path(path: &Path) -> Result<Option<Selection>, Diagnostic> {
    let snapshot = Snapshot::read(path)?;
    let Some(bytes) = snapshot.bytes else {
        return Ok(None);
    };
    let value = crate::input::json(&bytes, crate::config::MAX_BYTES, 16)?;
    let s: Selection = serde_json::from_value(value).map_err(|_| invalid())?;
    if s.version != 2
        || s.project_id == 0
        || !crate::config::valid_branch(&s.branch)
        || !crate::config::valid_branch(&s.target)
        || s.issues.len() > 100
        || s.issues.contains(&0)
        || s.intents.len() > 100
        || s.request == Some(0)
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
    Ok(Some(s))
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
    let checkpoint = BranchMismatch {
        status: "branch_mismatch",
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
        let bytes = serde_json::to_vec_pretty(selection).map_err(|_| invalid())?;
        if bytes.len() > crate::config::MAX_BYTES {
            return Err(Diagnostic::input(
                "Delivery checkpoint exceeds 1 MiB; use smaller independently verifiable specs.",
            ));
        }
        self.store.checkpoint(&self.path, &self.expected, &bytes)?;
        self.expected = Snapshot::read(&self.path)?;
        Ok(())
    }
}
