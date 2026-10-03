//! Compose bounded transport facts from pure state classification and next-action policy.
use super::{actions, classification, projection};
use crate::{
    observation::{CheckOutcome, Observation as NativeObservation},
    project::Context,
    watch_store::{ActionKind, EventState, Goal, Identity, NextAction, Revision},
};

pub(super) struct Observation {
    pub revision: Revision,
    pub state: EventState,
    pub reason: String,
    pub next_step: NextAction,
    pub terminal: bool,
    pub retryable: bool,
    pub same_source_mismatch: bool,
}

pub(super) fn normalized(
    assessment: &NativeObservation,
    context: &Context,
    goal: Goal,
    request_id: u64,
) -> Observation {
    let evidence = &assessment.evidence;
    let request = evidence.request.as_ref();
    let revision = projection::revision(assessment, context);
    let classification::Classified {
        state,
        reason,
        terminal,
        retryable,
    } = classification::classify(assessment, context, goal, &revision);
    let next_step = actions::next_step(assessment, goal, request_id, &state);
    Observation {
        revision,
        state,
        reason,
        next_step,
        terminal,
        retryable,
        same_source_mismatch: request.is_some_and(|r| {
            evidence
                .project_id
                .is_some_and(|id| id > 0 && r.source_project == id && r.target_project == id)
                && evidence.target.as_deref() == Some(r.target.as_str())
                && Some(r.source.as_str()) == context.branch.as_deref()
        }),
    }
}

pub(super) fn empty_next_step(identity: &Identity, kind: ActionKind, message: &str) -> NextAction {
    NextAction {
        kind,
        goal: identity.goal,
        request_id: identity.request,
        request_state: None,
        check_outcome: CheckOutcome::Unobserved,
        draft: None,
        auto_merge: None,
        close_issues_after_merge: false,
        issue_ids: Vec::new(),
        failed_checks: Vec::new(),
        diagnostics: Vec::new(),
        message: message.into(),
        command: None,
        requires_user_authorization: false,
    }
}
pub(super) fn override_next_step(observation: &mut Observation, kind: ActionKind, message: &str) {
    observation.next_step.kind = kind;
    observation.next_step.message = message.into();
    observation.next_step.command = None;
    observation.next_step.requires_user_authorization = false;
}
