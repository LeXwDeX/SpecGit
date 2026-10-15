//! Pending notification receipts and bounded native observation.
use super::{Output, notice};
use crate::{config, process::Process, project, selection};

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
pub async fn observe_handle(event: &str, _bytes: &[u8], _process: Process) -> Output {
    if matches!(event, "SessionStart" | "PreToolUse") {
        notice(
            "Automatic host observation is unsupported; use bounded specgit watch or inbox tools.",
        )
    } else {
        Output::default()
    }
}
