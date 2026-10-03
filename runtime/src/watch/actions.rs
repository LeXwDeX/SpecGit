//! Next actions describe native evidence and never grant mutation authorization.
use crate::{
    delivery_model::AutoMerge,
    observation::{CheckOutcome, Observation as NativeObservation, Status},
    watch_store::{ActionKind, EventState, Goal, NextAction},
};

pub(super) fn next_step(
    assessment: &NativeObservation,
    goal: Goal,
    request_id: u64,
    state: &EventState,
) -> NextAction {
    let evidence = &assessment.evidence;
    let request = evidence.request.as_ref();
    let codes: Vec<_> = assessment.diagnostics.iter().map(|d| &d.code).collect();
    let check_outcome = assessment.checks_outcome();
    let failed_checks: Vec<String> = evidence
        .checks
        .iter()
        .flatten()
        .filter(|check| check.failed())
        .map(|check| check.name.clone())
        .collect();
    let observed_issue_ids: Vec<u64> = evidence
        .issues
        .iter()
        .flatten()
        .map(|issue| issue.id)
        .collect();
    let open_issue_ids: Vec<u64> = evidence
        .issues
        .iter()
        .flatten()
        .filter(|issue| issue.state != "closed")
        .map(|issue| issue.id)
        .collect();
    let diagnostics: Vec<String> = codes
        .iter()
        .map(|code| {
            serde_json::to_value(code)
                .ok()
                .and_then(|value| value.as_str().map(str::to_owned))
                .unwrap_or_else(|| "unknown".into())
        })
        .collect();
    let (kind, message, command, requires_user_authorization, issue_ids) = if let Some(action) =
        checks_action(assessment, goal, request_id, state, &failed_checks)
    {
        action
    } else {
        match state {
        EventState::Completed => (
            ActionKind::Completed,
            "Native evidence confirms the selected request was merged and its associated issues were closed. No further action is indicated.".to_owned(),
            None,
            false,
            Vec::new(),
        ),
        EventState::MergedIssuesOpen => {
            let closure_preference = if evidence.close_issues_after_merge {
                "The Agent closure preference is on, but it does not grant authorization and this observer will not close issues."
            } else {
                "The Agent closure preference is off and this observer will not close issues."
            };
            (
                ActionKind::InspectOpenIssues,
                format!(
                    "The request is merged, but these associated issues remain open: {}. Read the current native status and issue facts. {closure_preference}",
                    open_issue_ids.iter().map(|id| format!("#{id}")).collect::<Vec<_>>().join(", ")
                ),
                Some(format!("specgit pr --status --request {request_id} --json")),
                false,
                open_issue_ids,
            )
        }
        EventState::ClosedUnmerged => (
            ActionKind::ReopenOrChooseFollowup,
            "The request is closed without native merge evidence. Choose explicitly whether to reopen it or select follow-up work; closure alone is not delivery completion.".into(),
            Some(format!("specgit pr --status --request {request_id} --json")),
            false,
            Vec::new(),
        ),
        EventState::IdentityChanged => (
            ActionKind::ReconcileSubscription,
            "The selected worktree, source, head, or target changed. Reconcile the subscription identity, then refresh native evidence.".into(),
            None,
            false,
            Vec::new(),
        ),
        EventState::Unknown if assessment.status == Status::Merged => {
            let issue_ids = evidence
                .associations
                .as_ref()
                .map(|associations| associations.iter().map(|association| association.issue).collect())
                .unwrap_or(observed_issue_ids);
            (
                ActionKind::VerifyIssueClosure,
                "The request is merged, but native evidence does not confirm the associated issue set and closure. Refresh the request and issue facts; do not treat this as complete or close issues automatically.".into(),
                Some(format!("specgit pr --status --request {request_id} --json")),
                false,
                issue_ids,
            )
        }
        EventState::Unknown => (
            ActionKind::RefreshNativeEvidence,
            if diagnostics.is_empty() {
                "The native lifecycle is unknown. Refresh the exact request and inspect the returned facts before acting.".into()
            } else {
                format!("The native lifecycle is unknown because this observation reported {}. Refresh the exact request before acting; no missing fact is inferred.", diagnostics.join(", "))
            },
            Some(format!("specgit pr --status --request {request_id} --json")),
            false,
            Vec::new(),
        ),
        EventState::TimedOut | EventState::Cancelled => (
            ActionKind::ResumeSubscription,
            "The bounded observation stopped before confirming the goal. Resume this exact subscription to collect fresh native evidence.".into(),
            None,
            false,
            Vec::new(),
        ),
        EventState::Failed | EventState::ChecksPassed | EventState::ChecksCompleted | EventState::Pending => unreachable!("check states are interpreted by checks_action"),
    }
    };
    NextAction {
        kind,
        goal,
        request_id,
        request_state: request.map(|r| r.state.clone()),
        check_outcome,
        draft: request.map(|r| r.draft),
        auto_merge: evidence.auto_merge,
        close_issues_after_merge: evidence.close_issues_after_merge,
        issue_ids,
        failed_checks,
        diagnostics,
        message,
        command,
        requires_user_authorization,
    }
}

type SuggestedAction = (ActionKind, String, Option<String>, bool, Vec<u64>);

fn checks_action(
    assessment: &NativeObservation,
    goal: Goal,
    request_id: u64,
    state: &EventState,
    failed_checks: &[String],
) -> Option<SuggestedAction> {
    let evidence = &assessment.evidence;
    let request = evidence.request.as_ref();
    let check_outcome = assessment.checks_outcome();
    let merge_registration = match evidence.auto_merge {
        Some(AutoMerge::Registered) => "Auto-merge is registered.",
        Some(AutoMerge::NotRegistered) => "Auto-merge is not registered.",
        Some(AutoMerge::Unknown) | None => {
            "Auto-merge registration is unknown from this observation."
        }
    };
    Some(match state {
        EventState::Failed => (
            ActionKind::RepairChecks,
            format!(
                "Native checks failed{}; inspect their logs, repair the cause, and observe the request again. A draft state does not hide failing checks.",
                if failed_checks.is_empty() { String::new() } else { format!(": {}", failed_checks.join(", ")) }
            ),
            None,
            false,
            Vec::new(),
        ),
        EventState::ChecksPassed if evidence.request.as_ref().is_some_and(|request| request.draft) => {
            let message = if goal == Goal::Checks {
                "The checks goal is satisfied, but this request is still a draft. The suggested ready action only marks it ready; it does not approve or merge it, and passing checks are not delivery completion."
            } else {
                "For the lifecycle goal, checks passed but this request is still a draft. Prepare it for review; marking it ready does not approve or merge it, and passing checks are not delivery completion."
            };
            (
                ActionKind::PrepareReview,
                message.into(),
                Some(format!("specgit pr --ready --request {request_id} --json")),
                true,
                Vec::new(),
            )
        }
        EventState::ChecksPassed if evidence.request.as_ref().is_some_and(|request| !request.draft) => {
            let message = if goal == Goal::Checks {
                format!("The checks goal is satisfied, but this is not delivery completion. The request is ready for platform review. {merge_registration} Review approval and merge are separate native facts and are not inferred; verify them on the platform.")
            } else {
                format!("For the lifecycle goal, checks passed and the request is ready for platform review. {merge_registration} Review approval and merge are separate native facts and are not inferred; verify them on the platform before treating delivery as complete.")
            };
            (
                ActionKind::ReviewOrMergeOnPlatform,
                message,
                Some(format!("specgit pr --status --request {request_id} --json")),
                true,
                Vec::new(),
            )
        }
        EventState::ChecksPassed => (
            ActionKind::RefreshNativeEvidence,
            "Checks passed, but the request's draft/ready state is unknown. Refresh the native request before choosing a review action.".into(),
            Some(format!("specgit pr --status --request {request_id} --json")),
            false,
            Vec::new(),
        ),
        EventState::ChecksCompleted => (
            ActionKind::InterpretChecks,
            "Checks completed with neutral or skipped results. Interpret their platform meaning; no merge eligibility or delivery completion is inferred.".into(),
            Some(format!("specgit pr --status --request {request_id} --json")),
            false,
            Vec::new(),
        ),
        EventState::Pending if check_outcome == CheckOutcome::Pending => {
            let draft_context = if request.is_some_and(|request| request.draft) {
                "This request remains a draft."
            } else {
                "The request is not marked as a draft."
            };
            let goal_context = if goal == Goal::Checks {
                "The checks goal remains open."
            } else {
                "The lifecycle goal remains open."
            };
            (
                ActionKind::WaitForChecks,
                format!("Native checks are still running. {draft_context} Wait for their result, then refresh this request. {goal_context}"),
                Some(format!("specgit pr --status --request {request_id} --json")),
                false,
                Vec::new(),
            )
        }
        EventState::Pending => (
            ActionKind::InspectChecks,
            "No usable native check result is available yet. Inspect or refresh the checks before inferring review readiness or lifecycle completion.".into(),
            Some(format!("specgit pr --status --request {request_id} --json")),
            false,
            Vec::new(),
        ),
        _ => return None,
    })
}
