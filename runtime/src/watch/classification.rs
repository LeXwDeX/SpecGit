//! Classify lifecycle facts without reads, writes or transport state.
use crate::{
    delivery_model::PullRequest,
    diagnostic::{Code, Diagnostic},
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
    // A merged or closed request is already a settled lifecycle fact; later
    // local commits cannot make it observably open again. The local divergence
    // stays in revision.local_head. Source identity and inconsistent native
    // evidence still fail closed below.
    let settled = request.is_some_and(|r| matches!(r.state.as_str(), "merged" | "closed"));
    let state = if request.is_some_and(|r| Some(r.source.as_str()) != context.branch.as_deref())
        || (revision.head != revision.local_head && !settled)
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
    let retryable = retryable_diagnostics(&assessment.diagnostics, request);
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

fn retryable_diagnostics(diagnostics: &[Diagnostic], request: Option<&PullRequest>) -> bool {
    if diagnostics.is_empty() {
        return false;
    }
    diagnostics.iter().all(|diagnostic| {
        (diagnostic.code == Code::UnsupportedOperation
            && diagnostic.operation == crate::diagnostic::REQUEST_LIFECYCLE_OPERATION
            && request.is_some_and(|request| request.is_locked()))
            || (diagnostic.code == Code::MalformedResponse
                && diagnostic.operation == "checks_state")
            || matches!(
                diagnostic.code,
                Code::NetworkFailed
                    | Code::RateLimited
                    | Code::Timeout
                    | Code::ProcessFailed
                    | Code::ConcurrentEdit
            )
    })
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

#[cfg(test)]
mod tests {
    use super::retryable_diagnostics;
    use crate::{
        delivery_model::PullRequest,
        diagnostic::{Code, Diagnostic, REQUEST_LIFECYCLE_OPERATION},
    };

    fn request(state: &str) -> PullRequest {
        PullRequest {
            id: 41,
            title: "fix: example".into(),
            body: "Closes #1".into(),
            labels: vec![],
            state: state.into(),
            draft: false,
            head: "a".repeat(40),
            source: "feature".into(),
            target: "main".into(),
            source_project: 7,
            target_project: 7,
            updated_at: "2026-10-25T00:00:00Z".into(),
        }
    }

    fn diagnostic(code: Code, operation: &str) -> Diagnostic {
        Diagnostic::new(code, operation, "message", "remedy")
    }

    fn transient() -> Diagnostic {
        diagnostic(Code::UnsupportedOperation, REQUEST_LIFECYCLE_OPERATION)
    }

    #[test]
    fn exact_locked_transient_is_retryable() {
        assert!(!retryable_diagnostics(&[], Some(&request("locked"))));
        let retry = [transient()];
        assert!(retryable_diagnostics(&retry, Some(&request("locked"))));
        assert!(!retryable_diagnostics(&retry, Some(&request("opened"))));
        assert!(!retryable_diagnostics(&retry, None));
    }

    #[test]
    fn locked_transient_accepts_only_intrinsically_retryable_companions() {
        for code in [
            Code::NetworkFailed,
            Code::RateLimited,
            Code::Timeout,
            Code::ProcessFailed,
            Code::ConcurrentEdit,
        ] {
            let diagnostics = [transient(), diagnostic(code, "read")];
            assert!(retryable_diagnostics(
                &diagnostics,
                Some(&request("locked"))
            ));
        }
        let diagnostics = [
            transient(),
            diagnostic(Code::MalformedResponse, "checks_state"),
        ];
        assert!(retryable_diagnostics(
            &diagnostics,
            Some(&request("locked"))
        ));
    }

    #[test]
    fn locked_transient_cannot_mask_terminal_diagnostics() {
        for (code, operation) in [
            (Code::PermissionDenied, "read"),
            (Code::IdentityMismatch, "observe"),
            (Code::InvalidInput, "input"),
            (Code::Cancelled, "watch"),
            (Code::AuthenticationFailed, "read"),
            (Code::UnsupportedOperation, "native_checks"),
            (Code::MalformedResponse, "observe"),
        ] {
            let diagnostics = [transient(), diagnostic(code, operation)];
            assert!(
                !retryable_diagnostics(&diagnostics, Some(&request("locked"))),
                "{operation} must stay terminal"
            );
        }
    }

    #[test]
    fn unrelated_unsupported_operation_stays_terminal() {
        let diagnostics = [diagnostic(Code::UnsupportedOperation, "native_checks")];
        assert!(!retryable_diagnostics(
            &diagnostics,
            Some(&request("locked"))
        ));
        assert!(!retryable_diagnostics(
            &diagnostics,
            Some(&request("opened"))
        ));
    }
}
