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
pub fn read(context: &Context) -> Result<Option<Selection>, Diagnostic> {
    let selection = read_path(&path(context))?;
    if selection.as_ref().is_some_and(|s| {
        s.repository != context.repository || Some(&s.branch) != context.branch.as_ref()
    }) {
        return Err(invalid());
    }
    Ok(selection)
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
