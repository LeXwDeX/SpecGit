//! Bounded native observation; durable transport never authorizes mutations.
use crate::{
    config,
    diagnostic::Diagnostic,
    process::Process,
    project::{self, Context},
    report::Report,
    watch_store::{self, ActionKind, EventState, Goal, Identity, State, Store},
};
use serde_json::json;
use std::path::{Path, PathBuf};

#[derive(Debug, clap::Args)]
pub struct Options {
    #[arg(long)]
    pub request: u64,
    #[arg(long)]
    pub session: String,
    #[arg(long, value_enum)]
    pub goal: Goal,
    #[arg(long, value_parser=clap::value_parser!(u64).range(1..=86400))]
    pub timeout_seconds: Option<u64>,
    #[arg(long, value_parser=clap::value_parser!(u64).range(1..=3600))]
    pub poll_seconds: Option<u64>,
    /// Refresh once, retaining pending intent instead of waiting for the goal.
    #[arg(long)]
    pub once: bool,
}
#[derive(Debug, clap::Args)]
pub struct InboxOptions {
    #[arg(long)]
    pub request: u64,
    #[arg(long)]
    pub session: String,
    #[arg(long, value_enum)]
    pub goal: Goal,
    /// Show receipt IDs only; cached terminal results are never current evidence.
    #[arg(long, conflicts_with = "ack")]
    pub no_refresh: bool,
    /// Acknowledge receipt of an exact event ID, not acceptance or human reading.
    #[arg(long)]
    pub ack: Option<String>,
}
pub async fn local(process: &Process, cwd: &Path) -> Result<Context, Diagnostic> {
    local_with_observation(process, cwd)
        .await
        .map(|(context, _)| context)
}
async fn local_with_observation(
    process: &Process,
    cwd: &Path,
) -> Result<(Context, config::Observation), Diagnostic> {
    let bytes = project::git(process, cwd, &["rev-parse", "--show-toplevel"]).await?;
    let root = PathBuf::from(
        String::from_utf8(bytes)
            .map_err(|_| Diagnostic::input("Invalid Git root."))?
            .trim_end_matches(['\r', '\n']),
    );
    let declaration = config::read(&root)?
        .ok_or_else(|| Diagnostic::input("Initialize a v2 project before observing a delivery."))?;
    let context = config::resolve(
        process,
        &root,
        declaration.remote.as_deref(),
        declaration.provider,
        None,
    )
    .await?;
    Ok((context, declaration.observation))
}
#[derive(Clone, Copy)]
struct Timing {
    max_wait_seconds: u64,
    poll_seconds: u64,
}
fn timing(o: &Options, configured: &config::Observation) -> Result<Timing, Diagnostic> {
    let max_wait_seconds = o.timeout_seconds.unwrap_or(configured.max_wait_seconds);
    let poll_seconds = o.poll_seconds.unwrap_or(configured.poll_seconds);
    if !(1..=86400).contains(&max_wait_seconds)
        || !(1..=3600).contains(&poll_seconds)
        || (!o.once && max_wait_seconds < poll_seconds)
    {
        return Err(Diagnostic::input(
            "Invalid observer polling or deadline bound.",
        ));
    }
    Ok(Timing {
        max_wait_seconds,
        poll_seconds,
    })
}
mod actions;
mod classification;
mod normalized;
mod projection;
mod transport;
use normalized::empty_next_step;

pub struct ObservedEvents {
    pub state: State,
    pub event_state: EventState,
}
pub(crate) fn notification_enabled(
    state: &EventState,
    notifications: &[config::Notification],
) -> bool {
    let category = match state {
        EventState::Completed => config::Notification::Completed,
        _ => config::Notification::Attention,
    };
    notifications.contains(&category)
}
impl ObservedEvents {
    pub fn pending(&self) -> Vec<&watch_store::Event> {
        self.state
            .events
            .iter()
            .filter(|e| !e.superseded && e.acknowledged_at.is_none())
            .collect()
    }
}
fn report(state: &State, event_state: &EventState) -> Report {
    let events: Vec<_> = state
        .events
        .iter()
        .filter(|e| !e.superseded && e.acknowledged_at.is_none())
        .collect();
    let status = serde_json::to_value(event_state)
        .expect("state serializes")
        .as_str()
        .unwrap()
        .to_owned();
    let mut result = Report::success(
        "watch",
        &status,
        json!({"subscription":state.identity,"events":events,"expired_unacknowledged":state.expired_unacknowledged,"transport":"offered_not_acknowledged","native_observation":true}),
    );
    result.next_actions = events
        .iter()
        .map(|event| {
            let action = event.next_step.clone().unwrap_or_else(|| {
                let mut action = empty_next_step(
                    &state.identity,
                    ActionKind::RefreshNativeEvidence,
                    &event.next_action,
                );
                action.request_state = None;
                action
            });
            serde_json::to_value(action).expect("typed watch action serializes")
        })
        .collect();
    result.exit = match event_state {
        EventState::Cancelled => 130,
        EventState::Unknown | EventState::TimedOut | EventState::IdentityChanged => 3,
        _ => 0,
    };
    result
}
pub async fn run(o: Options, process: Process, cwd: &Path) -> Report {
    match Box::pin(observe_subscription(o, process, cwd)).await {
        Ok(r) => report(&r.state, &r.event_state),
        Err(d) => Report::failure("watch", d),
    }
}
pub async fn observe_subscription(
    o: Options,
    process: Process,
    cwd: &Path,
) -> Result<ObservedEvents, Diagnostic> {
    transport::subscribe(o, process, cwd, false).await
}
pub async fn observe_until_attention(
    o: Options,
    process: Process,
    cwd: &Path,
) -> Result<ObservedEvents, Diagnostic> {
    transport::subscribe(o, process, cwd, true).await
}
pub async fn inbox(o: InboxOptions, process: Process, cwd: &Path) -> Report {
    match Box::pin(inbox_inner(o, process, cwd)).await {
        Ok(r) => r,
        Err(d) => Report::failure("inbox", d),
    }
}
async fn inbox_inner(o: InboxOptions, process: Process, cwd: &Path) -> Result<Report, Diagnostic> {
    let (context, configured) = local_with_observation(&process, cwd).await?;
    let identity = Identity::new(&context, &o.session, o.request, o.goal)?;
    if let Some(id) = o.ack {
        let state = Store::new(identity)?.acknowledge(&id, watch_store::now())?;
        return Ok(Report::success(
            "inbox",
            "acknowledged",
            json!({"subscription":state.identity,"event_id":id,"acknowledgement":"explicit_transport_receipt","human_read":false}),
        ));
    }
    if o.no_refresh {
        let state = watch_store::read(&identity)?;
        let ids: Vec<_> = state
            .as_ref()
            .into_iter()
            .flat_map(|s| &s.events)
            .filter(|e| e.acknowledged_at.is_none())
            .map(|e| &e.id)
            .collect();
        return Ok(Report::success(
            "inbox",
            "unverified",
            json!({"subscription":identity,"pending_event_ids":ids,"requires_refresh":true,"expired_unacknowledged":state.as_ref().map_or(0, |s|s.expired_unacknowledged)}),
        ));
    }
    let mut r = run(
        Options {
            request: o.request,
            session: o.session,
            goal: o.goal,
            timeout_seconds: Some(configured.max_wait_seconds.min(90)),
            poll_seconds: Some(configured.poll_seconds),
            once: true,
        },
        process,
        cwd,
    )
    .await;
    r.operation = "inbox".into();
    Ok(r)
}
