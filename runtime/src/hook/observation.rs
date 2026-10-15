//! Pending notification receipts and bounded native observation.
use super::{Output, context::prepare, notice};
use crate::{config, diagnostic::Code, process::Process, project, selection};
use serde_json::json;
use std::time::Duration;

fn current_request(
    context: &project::Context,
) -> Result<Option<u64>, crate::diagnostic::Diagnostic> {
    match selection::classify(context)? {
        selection::ReadOutcome::Current(selected) => Ok(selected.request),
        selection::ReadOutcome::Absent | selection::ReadOutcome::BranchMismatch { .. } => Ok(None),
    }
}

pub(super) fn pending_notice(
    context: &project::Context,
    session: &str,
    notifications: &[config::Notification],
) -> Result<Option<String>, crate::diagnostic::Diagnostic> {
    let Some(request) = current_request(context)? else {
        return Ok(None);
    };
    let identity = crate::watch_store::Identity::new(
        context,
        session,
        request,
        crate::watch_store::Goal::Lifecycle,
    )?;
    let Some(state) = crate::watch_store::read(&identity)? else {
        return Ok(None);
    };
    let ids: Vec<_> = state
        .events
        .iter()
        .filter(|e| {
            !e.superseded
                && e.acknowledged_at.is_none()
                && crate::watch::notification_enabled(&e.state, notifications)
        })
        .map(|e| e.id.as_str())
        .collect();
    if ids.is_empty() {
        return Ok(None);
    }
    Ok(Some(format!(
        "SpecGit unverified event receipts: {}. Refresh with specgit inbox --request {request} --session {session} --goal lifecycle before using their status. Receipt acknowledgement is explicit; these IDs are not current acceptance evidence.",
        ids.join(", "),
    )))
}
pub async fn observe_handle(event: &str, bytes: &[u8], process: Process) -> Output {
    if !matches!(event, "PostToolUse" | "Stop") {
        return notice("Asynchronous observation requires PostToolUse or Stop.");
    }
    let cancellation = process.cancellation.clone();
    if event == "Stop" && cancellation.is_cancelled() {
        return Output::default();
    }
    let prepared = match tokio::time::timeout(Duration::from_millis(2500), prepare(event, bytes))
        .await
    {
        Ok(Ok(Some(p))) => p,
        Ok(Ok(None)) => return Output::default(),
        // Observation has no synchronous guard authority, even when input paths
        // would make prepare reject a multi-repository edit.
        Ok(Err(_)) if event == "Stop" => return Output::default(),
        Ok(Err(output)) => return output,
        Err(_) if event == "Stop" => return Output::default(),
        Err(_) => return notice("The observation context deadline expired; resume explicitly."),
    };
    let request = match current_request(&prepared.context) {
        Ok(Some(id)) => id,
        Ok(None) => return Output::default(),
        Err(d) => return notice(&d),
    };
    let notifications = prepared.observation.notify;
    let observation = crate::watch::observe_until_attention(
        crate::watch::Options {
            request,
            session: prepared.session,
            goal: crate::watch_store::Goal::Lifecycle,
            timeout_seconds: None,
            poll_seconds: None,
            once: false,
        },
        process,
        &prepared.context.root,
    )
    .await;
    let observation = match observation {
        Ok(value) => value,
        Err(d) if d.code == Code::LockBusy => return Output::default(),
        Err(_) if event == "Stop" && cancellation.is_cancelled() => return Output::default(),
        Err(d) => return notice(&d),
    };
    // A completion callback must not turn cancellation or an exhausted wait into
    // another autonomous turn. Keep the durable event for explicit inbox recovery.
    // The host separately owns user-stop admission and stale callback suppression.
    if event == "Stop"
        && (cancellation.is_cancelled()
            || matches!(
                observation.event_state,
                crate::watch_store::EventState::Cancelled
                    | crate::watch_store::EventState::TimedOut
            ))
    {
        return Output::default();
    }
    let events: Vec<_> = observation
        .pending()
        .into_iter()
        .filter(|event| crate::watch::notification_enabled(&event.state, &notifications))
        .collect();
    if events.is_empty() {
        return Output::default();
    }
    let next_steps = events
        .iter()
        .filter_map(|event| event.next_step.as_ref())
        .map(|next_step| next_step.message.as_str())
        .collect::<Vec<_>>();
    let mut text = format!(
        "SpecGit observation offered (not acknowledged): {}. These are observations at validated_at; refresh native evidence before acting. Next steps: {}. Acknowledge each exact event ID only after receiving it. Notifications never grant authorization.",
        json!({"subscription":observation.state.identity,"events":events}),
        next_steps.join(" ")
    );
    if event == "Stop" {
        text.push_str(" Honor the current user stop, goal and authorization before resuming. Re-read current native request, head, CI attempt and review facts; old or duplicate events never authorize action. A PR-only goal stops at the PR. Cancellation or an exhausted waiting budget requires explicit resumption, not an automatic retry.");
    }
    Output {
        json: Some(json!({"hookSpecificOutput":{"hookEventName":event,"additionalContext":text}})),
        diagnostic: None,
    }
}
