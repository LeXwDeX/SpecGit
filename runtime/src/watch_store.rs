//! Bounded local subscription intent and transport receipts, never remote truth.
use crate::{
    assets::{self, AssetStore, Snapshot},
    diagnostic::{Code, Diagnostic},
    project::{Context, Repository},
};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
pub const RETENTION: u64 = 7 * 24 * 60 * 60;
const MAX_EVENTS: usize = 64;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, clap::ValueEnum)]
#[serde(rename_all = "snake_case")]
pub enum Goal {
    Checks,
    Lifecycle,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Identity {
    pub repository: Repository,
    pub worktree: PathBuf,
    pub git_dir: PathBuf,
    pub session: String,
    pub request: u64,
    pub goal: Goal,
}
impl Identity {
    pub fn new(
        context: &Context,
        session: &str,
        request: u64,
        goal: Goal,
    ) -> Result<Self, Diagnostic> {
        if !valid_session(session) || request == 0 {
            return Err(Diagnostic::input(
                "A valid session and positive native request ID are required.",
            ));
        }
        Ok(Self {
            repository: context.repository.clone(),
            worktree: context.root.clone(),
            git_dir: context.git_dir.clone(),
            session: session.into(),
            request,
            goal,
        })
    }
    pub fn key(&self) -> String {
        assets::hash(&serde_json::to_vec(self).expect("identity serializes"))
    }
}
pub fn valid_session(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EventState {
    Pending,
    ChecksPassed,
    ChecksCompleted,
    Completed,
    MergedIssuesOpen,
    ClosedUnmerged,
    Failed,
    Unknown,
    TimedOut,
    Cancelled,
    IdentityChanged,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Revision {
    pub head: String,
    pub local_head: String,
    pub target: String,
    pub declaration: String,
    pub evidence_digest: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub id: String,
    pub fingerprint: String,
    pub revision: Revision,
    pub state: EventState,
    pub reason: String,
    pub next_action: String,
    pub observed_at: u64,
    pub validated_at: u64,
    pub acknowledged_at: Option<u64>,
    pub superseded: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Lease {
    pub owner: String,
    pub pid: u32,
    pub started_at: u64,
    pub deadline: u64,
    pub polls_completed: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    pub version: u8,
    pub identity: Identity,
    pub sequence: u64,
    pub lease: Option<Lease>,
    pub events: Vec<Event>,
    pub expired_unacknowledged: u64,
}
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn invalid() -> Diagnostic {
    Diagnostic::new(
        Code::OwnershipConflict,
        "watch_state",
        "The subscription state is malformed or belongs to another session/worktree.",
        "Preserve the state and inspect the exact subscription; pending events were not acknowledged.",
    )
}
fn root(identity: &Identity, state_root: Option<&Path>) -> Result<PathBuf, Diagnostic> {
    let base = state_root
        .map(Path::to_path_buf)
        .unwrap_or_else(|| identity.git_dir.join("specgit-v2"));
    if !base.is_absolute() {
        return Err(Diagnostic::input("Observer state root must be absolute."));
    }
    assets::safe_path(&base)?;
    Ok(base.join("subscriptions").join(identity.key()))
}
pub fn read(identity: &Identity, state_root: Option<&Path>) -> Result<Option<State>, Diagnostic> {
    let path = root(identity, state_root)?.join("state.json");
    let snapshot = Snapshot::read(&path)?;
    let Some(bytes) = snapshot.bytes else {
        return Ok(None);
    };
    let state: State =
        serde_json::from_value(crate::input::json(&bytes, crate::config::MAX_BYTES, 24)?)
            .map_err(|_| invalid())?;
    validate(&state, identity)?;
    Ok(Some(state))
}
fn validate(state: &State, identity: &Identity) -> Result<(), Diagnostic> {
    if state.version != 2
        || state.identity != *identity
        || state.events.len() > MAX_EVENTS
        || state.events.iter().any(|e| {
            e.id.len() != 64
                || e.fingerprint.len() != 64
                || e.reason.len() > 4096
                || e.next_action.len() > 1024
        })
        || state
            .events
            .iter()
            .enumerate()
            .any(|(i, e)| state.events[..i].iter().any(|old| old.id == e.id))
    {
        return Err(invalid());
    }
    Ok(())
}
pub struct Store {
    root: PathBuf,
    state_root: Option<PathBuf>,
    identity: Identity,
}
impl Store {
    pub fn new(identity: Identity, state_root: Option<&Path>) -> Result<Self, Diagnostic> {
        let root = root(&identity, state_root)?;
        let parent = root.parent().ok_or_else(invalid)?;
        let _registry = AssetStore::lock(&parent.join("registry"), &[], Duration::from_secs(1))?;
        if !root.exists() {
            for (count, entry) in std::fs::read_dir(parent)
                .map_err(|_| invalid())?
                .enumerate()
            {
                entry.map_err(|_| invalid())?;
                if count >= 128 {
                    return Err(Diagnostic::new(
                        Code::OutputLimit,
                        "watch_state",
                        "This state root reached its 128-subscription limit.",
                        "Inspect retained subscriptions and select a separate explicit state root; existing pending events were preserved.",
                    ));
                }
            }
        }
        drop(AssetStore::lock(
            &root.join("state-lock"),
            std::slice::from_ref(&root),
            Duration::from_secs(1),
        )?);
        Ok(Self {
            root,
            state_root: state_root.map(Path::to_path_buf),
            identity,
        })
    }
    /// The stable OS lock verifies ownership, including after PID reuse. A saved
    /// PID/deadline is informational and never permission to steal a live lock.
    pub fn lease(&self, deadline: u64) -> Result<(AssetStore, Lease), Diagnostic> {
        let lock = AssetStore::lock(&self.root.join("lease"), &[], Duration::from_millis(100))?;
        let nonce =
            tempfile::NamedTempFile::new_in(self.root.join("lease")).map_err(|_| invalid())?;
        let owner =
            assets::hash(format!("{}:{}:{:?}", std::process::id(), now(), nonce.path()).as_bytes());
        let lease = Lease {
            owner,
            pid: std::process::id(),
            started_at: now(),
            deadline,
            polls_completed: 0,
        };
        self.update(|s| {
            s.lease = Some(lease.clone());
            Ok(())
        })?;
        Ok((lock, lease))
    }
    pub fn release(&self, lease: &Lease) -> Result<(), Diagnostic> {
        self.update(|s| {
            if s.lease.as_ref().is_none_or(|l| l.owner != lease.owner) {
                return Err(invalid());
            }
            s.lease = None;
            Ok(())
        })
        .map(|_| ())
    }
    fn update(
        &self,
        mutate: impl FnOnce(&mut State) -> Result<(), Diagnostic>,
    ) -> Result<State, Diagnostic> {
        let lock = AssetStore::lock(
            &self.root.join("state-lock"),
            std::slice::from_ref(&self.root),
            Duration::from_secs(1),
        )?;
        let path = self.root.join("state.json");
        let expected = Snapshot::read(&path)?;
        let mut state =
            read(&self.identity, self.state_root.as_deref())?.unwrap_or_else(|| State {
                version: 2,
                identity: self.identity.clone(),
                sequence: 0,
                lease: None,
                events: vec![],
                expired_unacknowledged: 0,
            });
        mutate(&mut state)?;
        let bytes = serde_json::to_vec(&state).map_err(|_| invalid())?;
        if bytes.len() > crate::config::MAX_BYTES || state.events.len() > MAX_EVENTS {
            return Err(Diagnostic::new(
                Code::OutputLimit,
                "watch_state",
                "The bounded observer outbox is full.",
                "Inspect and acknowledge retained event IDs before resuming; no pending result was silently discarded.",
            ));
        }
        validate(&state, &self.identity)?;
        lock.checkpoint(&path, &expected, &bytes)?;
        Ok(state)
    }
    pub fn publish(
        &self,
        revision: Revision,
        state: EventState,
        reason: String,
        next_action: String,
        at: u64,
    ) -> Result<State, Diagnostic> {
        let fingerprint = assets::hash(
            &serde_json::to_vec(&(&revision, &state, &reason)).map_err(|_| invalid())?,
        );
        self.update(|s| {
            if let Some(lease) = &mut s.lease {
                lease.polls_completed = lease.polls_completed.saturating_add(1);
            }
            s.events.retain(|e| {
                let expired = at.saturating_sub(e.observed_at) >= RETENTION;
                if expired && e.acknowledged_at.is_none() {
                    s.expired_unacknowledged = s.expired_unacknowledged.saturating_add(1);
                }
                !expired
            });
            if let Some(current) = s
                .events
                .last_mut()
                .filter(|e| e.fingerprint == fingerprint && !e.superseded)
            {
                current.validated_at = at;
                return Ok(());
            }
            for event in &mut s.events {
                event.superseded = true;
            }
            // Acknowledged superseded receipts may be compacted. Unacknowledged
            // events remain until the explicit retention policy expires them.
            s.events.retain(|e| e.acknowledged_at.is_none());
            s.sequence = s.sequence.checked_add(1).ok_or_else(invalid)?;
            let id = assets::hash(
                format!("{}:{}:{fingerprint}", s.identity.key(), s.sequence).as_bytes(),
            );
            s.events.push(Event {
                id,
                fingerprint,
                revision,
                state,
                reason,
                next_action,
                observed_at: at,
                validated_at: at,
                acknowledged_at: None,
                superseded: false,
            });
            Ok(())
        })
    }
    pub fn acknowledge(&self, id: &str, at: u64) -> Result<State, Diagnostic> {
        self.update(|s| {
            let event = s.events.iter_mut().find(|e| e.id == id).ok_or_else(|| {
                Diagnostic::input("The event ID is not in this exact subscription.")
            })?;
            event.acknowledged_at.get_or_insert(at);
            Ok(())
        })
    }
}
