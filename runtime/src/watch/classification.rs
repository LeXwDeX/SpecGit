//! Classify lifecycle facts without reads, writes or transport state.
use crate::{
    diagnostic::Code,
    observation::{CheckOutcome, Observation as NativeObservation, Status},
    project::Context,
    watch_store::{EventState, Goal, Revision},
};

pub(super) struct Classified {
    pub state: EventState,
    pub reason: String,
    pub terminal: bool,
    pub retryable: bool,
}

pub(super) fn classify(
    assessment: &NativeObservation,
    context: &Context,
    goal: Goal,
    revision: &Revision,
) -> Classified {
    let evidence = &assessment.evidence;
    let request = evidence.request.as_ref();
    let codes: Vec<_> = assessment.diagnostics.iter().map(|d| &d.code).collect();
    let check_outcome = assessment.checks_outcome();
    let state = if revision.head != revision.local_head
        || request.is_some_and(|r| Some(r.source.as_str()) != context.branch.as_deref())
    {
        EventState::IdentityChanged
    } else if codes.contains(&&Code::Cancelled) {
        EventState::Cancelled
    } else if check_outcome == CheckOutcome::Failed {
        // A confirmed failing check stays actionable even when another optional
        // observation in the same read produced a diagnostic.
        EventState::Failed
    } else if !codes.is_empty()
        || matches!(
            assessment.status,
            Status::Unknown | Status::InvalidInput | Status::Merged
        )
    {
        EventState::Unknown
    } else if assessment.status == Status::Completed {
        EventState::Completed
    } else if assessment.status == Status::MergedIssuesOpen {
        EventState::MergedIssuesOpen
    } else if request.is_some_and(|r| r.state == "closed") {
        EventState::ClosedUnmerged
    } else if check_outcome == CheckOutcome::Passed {
        EventState::ChecksPassed
    } else if check_outcome == CheckOutcome::Completed {
        EventState::ChecksCompleted
    } else {
        EventState::Pending
    };
    let retryable = codes.iter().any(|c| {
        matches!(
            c,
            Code::NetworkFailed
                | Code::RateLimited
                | Code::Timeout
                | Code::ProcessFailed
                | Code::ConcurrentEdit
        )
    });
    let terminal = matches!(
        state,
        EventState::Completed
            | EventState::MergedIssuesOpen
            | EventState::ClosedUnmerged
            | EventState::Failed
            | EventState::Cancelled
            | EventState::IdentityChanged
    ) || (matches!(
        state,
        EventState::ChecksPassed | EventState::ChecksCompleted
    ) && goal == Goal::Checks)
        || (state == EventState::Unknown && !retryable);
    let reason = reason(assessment, &codes);
    Classified {
        state,
        reason,
        terminal,
        retryable,
    }
}

fn reason(assessment: &NativeObservation, codes: &[&Code]) -> String {
    let evidence = &assessment.evidence;
    let mut reason = if codes.is_empty() {
        let failed: Vec<_> = evidence
            .checks
            .iter()
            .flatten()
            .filter(|c| c.failed())
            .map(|c| c.name.as_str())
            .collect();
        if failed.is_empty() {
            assessment.status.as_str().to_owned()
        } else {
            format!("native_checks_failed: {}", failed.join(", "))
        }
    } else {
        serde_json::to_string(&codes).expect("codes serialize")
    };
    if assessment.status == Status::Open {
        match evidence.auto_merge {
            Some(crate::observation::AutoMerge::Registered) => {
                reason.push_str("; native_auto_merge_registered")
            }
            Some(crate::observation::AutoMerge::NotRegistered) => {
                reason.push_str("; native_auto_merge_not_registered")
            }
            _ => reason.push_str("; native_auto_merge_unknown"),
        }
    }
    let mut end = reason.len().min(4096);
    while !reason.is_char_boundary(end) {
        end -= 1;
    }
    reason.truncate(end);
    reason
}
