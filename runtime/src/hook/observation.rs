//! Pending notification receipts and bounded native observation.
use super::{Output, context::prepare, info};
use crate::{config, diagnostic::Code, process::Process, project};
use serde_json::json;
use std::time::Duration;

pub(super) fn pending_notice(
    context: &project::Context,
    session: &str,
    notifications: &[config::Notification],
) -> Result<Option<String>, crate::diagnostic::Diagnostic> {
    let Some(request) = crate::selection::read(context)?.and_then(|s| s.request) else {
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
    if event != "PostToolUse" {
        return info("SpecGit asynchronous observation requires PostToolUse.");
    }
    let prepared = match tokio::time::timeout(Duration::from_millis(2500), prepare(event, bytes))
        .await
    {
        Ok(Ok(Some(p))) => p,
        Ok(Ok(None)) => return Output::default(),
        Ok(Err(output)) => return output,
        Err(_) => return info("SpecGit observation context deadline expired; resume explicitly."),
    };
    let request = match crate::selection::read(&prepared.context) {
        Ok(Some(s)) => match s.request {
            Some(id) => id,
            None => return Output::default(),
        },
        Ok(None) => return Output::default(),
        Err(_) => {
            return info(
                "SpecGit cannot resolve the selected native request; use explicit diagnostics.",
            );
        }
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
        Err(_) => {
            return info(
                "SpecGit observation could not finish; inspect retained intent with specgit inbox.",
            );
        }
    };
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
    let text = format!(
        "SpecGit observation offered (not acknowledged): {}. These are observations at validated_at; refresh native evidence before acting. Next steps: {}. Acknowledge each exact event ID only after receiving it. Notifications never grant authorization.",
        json!({"subscription":observation.state.identity,"events":events}),
        next_steps.join(" ")
    );
    Output {
        json: Some(
            json!({"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":text}}),
        ),
        diagnostic: None,
    }
}
