//! Bounded native observation; durable transport never authorizes mutations.
use crate::{
    config,
    delivery_model::AutoMerge,
    diagnostic::{Code, Diagnostic},
    observation,
    observation::{CheckOutcome, Observation as NativeObservation, Status},
    process::Process,
    project::{self, Context},
    report::Report,
    watch_store::{
        self, ActionKind, EventState, Goal, Identity, NextAction, Revision, State, Store,
    },
};
use serde_json::json;
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Debug, clap::Args)]
pub struct Options {
    #[arg(long)]
    pub request: u64,
    #[arg(long)]
    pub session: String,
    #[arg(long, value_enum)]
    pub goal: Goal,
    #[arg(long)]
    pub state_root: Option<PathBuf>,
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
    #[arg(long)]
    pub state_root: Option<PathBuf>,
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
struct Observation {
    revision: Revision,
    state: EventState,
    reason: String,
    next_step: NextAction,
    terminal: bool,
    retryable: bool,
    same_source_mismatch: bool,
}
fn empty_next_step(identity: &Identity, kind: ActionKind, message: &str) -> NextAction {
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
fn override_next_step(observation: &mut Observation, kind: ActionKind, message: &str) {
    observation.next_step.kind = kind;
    observation.next_step.message = message.into();
    observation.next_step.command = None;
    observation.next_step.requires_user_authorization = false;
}
fn normalized(
    assessment: &NativeObservation,
    context: &Context,
    goal: Goal,
    request_id: u64,
) -> Observation {
    let evidence = &assessment.evidence;
    let request = evidence.request.as_ref();
    let head = request.map_or_else(|| context.head.clone(), |r| r.head.clone());
    let target = request.map_or_else(String::new, |r| r.target.clone());
    let declaration_digest = config::snapshot(&context.root)
        .ok()
        .and_then(|s| s.digest())
        .unwrap_or_default();
    #[derive(serde::Serialize)]
    struct IssueState<'a> {
        id: u64,
        state: &'a str,
    }
    #[derive(serde::Serialize)]
    struct Projection<'a> {
        checks: &'a Option<Vec<crate::delivery_model::Check>>,
        issues: Vec<IssueState<'a>>,
        associations: &'a Option<Vec<crate::observation::IssueAssociation>>,
        native_closing_available: bool,
        request_state: Option<&'a str>,
        draft: Option<bool>,
        auto_merge: &'a Option<crate::observation::AutoMerge>,
        diagnostics: Vec<&'a Code>,
    }
    // Only the bounded typed projection enters durable transport; never private descriptions.
    let projection = Projection {
        checks: &evidence.checks,
        associations: &evidence.associations,
        native_closing_available: evidence.native_closing_available,
        issues: evidence
            .issues
            .iter()
            .flatten()
            .map(|i| IssueState {
                id: i.id,
                state: &i.state,
            })
            .collect(),
        request_state: request.map(|r| r.state.as_str()),
        draft: request.map(|r| r.draft),
        auto_merge: &evidence.auto_merge,
        diagnostics: assessment.diagnostics.iter().map(|d| &d.code).collect(),
    };
    let revision = Revision {
        head,
        local_head: context.head.clone(),
        target,
        declaration: declaration_digest,
        evidence_digest: crate::assets::hash(
            &serde_json::to_vec(&serde_json::to_value(&projection).expect("projection serializes"))
                .expect("canonical projection serializes"),
        ),
    };
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
    let merge_registration = match evidence.auto_merge {
        Some(AutoMerge::Registered) => "Auto-merge is registered.",
        Some(AutoMerge::NotRegistered) => "Auto-merge is not registered.",
        Some(AutoMerge::Unknown) | None => {
            "Auto-merge registration is unknown from this observation."
        }
    };
    let (kind, message, command, requires_user_authorization, issue_ids) = match state {
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
    };
    let next_step = NextAction {
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
    };
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
async fn observe(
    identity: &Identity,
    context: &Context,
    process: &Process,
    budget: Duration,
) -> Observation {
    let assessment = match tokio::time::timeout(
        budget,
        Box::pin(observation::observe(
            Some(identity.request),
            process.clone(),
            &context.root,
        )),
    )
    .await
    {
        Ok(a) => a,
        Err(_) => NativeObservation::unavailable(Diagnostic::new(
            Code::Timeout,
            "watch",
            "The native observation deadline expired.",
            "Resume; partial evidence is not acceptance.",
        )),
    };
    normalized(&assessment, context, identity.goal, identity.request)
}

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
    let (initial, configured) = local_with_observation(&process, cwd).await?;
    let timing = timing(&o, &configured)?;
    let identity = Identity::new(&initial, &o.session, o.request, o.goal)?;
    let store = Store::new(identity.clone(), o.state_root.as_deref())?;
    let (_lock, lease) = store.lease(watch_store::now().saturating_add(timing.max_wait_seconds))?;
    let deadline = Instant::now() + Duration::from_secs(timing.max_wait_seconds);
    let mut failures = 0_u32;
    let mut context = initial;
    let result = loop {
        let declaration_before = config::snapshot(&context.root)?.digest();
        let remaining = deadline.saturating_duration_since(Instant::now());
        let mut observation = if remaining.is_zero() || process.cancellation.is_cancelled() {
            Observation {
                revision: Revision {
                    head: context.head.clone(),
                    local_head: context.head.clone(),
                    target: String::new(),
                    declaration: String::new(),
                    evidence_digest: String::new(),
                },
                state: if process.cancellation.is_cancelled() {
                    EventState::Cancelled
                } else {
                    EventState::TimedOut
                },
                reason: "The bounded subscription remains resumable.".into(),
                next_step: empty_next_step(
                    &identity,
                    ActionKind::ResumeSubscription,
                    "The bounded observation stopped before confirming the goal. Resume this exact subscription to collect fresh native evidence.",
                ),
                terminal: true,
                retryable: false,
                same_source_mismatch: false,
            }
        } else {
            observe(
                &identity,
                &context,
                &process,
                remaining.min(Duration::from_secs(90)),
            )
            .await
        };
        if !process.cancellation.is_cancelled() && Instant::now() < deadline {
            let refreshed =
                tokio::time::timeout(deadline.saturating_duration_since(Instant::now()), async {
                    let current = local(&process, cwd).await?;
                    let digest = config::snapshot(&current.root)?.digest();
                    let local_ahead = observation.same_source_mismatch
                        && observation.revision.head != current.head
                        && project::git(
                            &process,
                            &current.root,
                            &[
                                "merge-base",
                                "--is-ancestor",
                                &observation.revision.head,
                                &current.head,
                            ],
                        )
                        .await
                        .is_ok();
                    Ok::<_, Diagnostic>((current, digest, local_ahead))
                })
                .await;
            match refreshed {
                Ok(Ok((current, digest, local_ahead)))
                    if Identity::new(&current, &o.session, o.request, o.goal)? == identity =>
                {
                    if current.branch != context.branch || digest != declaration_before {
                        observation.state = EventState::IdentityChanged;
                        observation.reason = "Local branch/declaration changed during observation; the previous assessment was superseded.".into();
                        override_next_step(
                            &mut observation,
                            ActionKind::ReconcileSubscription,
                            "The local branch or declaration changed during observation. Reconcile the subscription, then refresh native evidence.",
                        );
                        observation.revision.local_head = current.head.clone();
                        observation.terminal = true;
                    } else if local_ahead {
                        observation.state = EventState::Pending;
                        observation.reason = "Local commits are ahead of the selected native source head; previous success is superseded.".into();
                        override_next_step(
                            &mut observation,
                            ActionKind::RefreshNativeEvidence,
                            "Local commits are ahead of the selected request. Push reviewed commits through the ordinary native workflow, then refresh native evidence.",
                        );
                        observation.revision.local_head = current.head.clone();
                        observation.terminal = false;
                        observation.retryable = false;
                    } else if current.head != context.head || current.dirty != context.dirty {
                        observation.state = EventState::Pending;
                        observation.reason = "Local changes superseded the assessment; the selected source branch will be observed again.".into();
                        override_next_step(
                            &mut observation,
                            ActionKind::RefreshNativeEvidence,
                            "Local changes superseded this assessment. Continue the subscription and refresh native evidence for the current revision.",
                        );
                        observation.revision.local_head = current.head.clone();
                        observation.terminal = false;
                        observation.retryable = false;
                    }
                    context = current;
                }
                Err(_) => {} // The deadline is classified below, after child cleanup.
                Ok(Err(d)) if d.code == Code::Cancelled => {}
                _ => {
                    observation.state = EventState::IdentityChanged;
                    observation.reason =
                        "The subscriber worktree or project identity changed.".into();
                    override_next_step(
                        &mut observation,
                        ActionKind::ReconcileSubscription,
                        "The subscriber worktree or project identity changed. Reconcile the subscription, then refresh native evidence.",
                    );
                    observation.terminal = true;
                }
            }
        }
        if process.cancellation.is_cancelled() || Instant::now() >= deadline {
            observation.state = if process.cancellation.is_cancelled() {
                EventState::Cancelled
            } else {
                EventState::TimedOut
            };
            observation.reason = "The bounded subscription remains resumable.".into();
            override_next_step(
                &mut observation,
                ActionKind::ResumeSubscription,
                "The bounded observation stopped before confirming the goal. Resume this exact subscription to collect fresh native evidence.",
            );
            observation.terminal = true;
        }
        if observation.state == EventState::IdentityChanged {
            override_next_step(
                &mut observation,
                ActionKind::ReconcileSubscription,
                "The selected worktree, source, head, or target changed. Reconcile the subscription, then refresh native evidence.",
            );
        }
        let state = store.publish_next_action(
            observation.revision,
            observation.state.clone(),
            observation.reason,
            observation.next_step,
            watch_store::now(),
        )?;
        if o.once || observation.terminal {
            break ObservedEvents {
                state,
                event_state: observation.state,
            };
        }
        failures = if observation.retryable {
            failures.saturating_add(1).min(4)
        } else {
            0
        };
        let jitter = if failures == 0 {
            0
        } else {
            u64::from(lease.owner.as_bytes()[failures as usize] % 3)
        };
        let delay = Duration::from_secs(
            timing
                .poll_seconds
                .saturating_mul(1 << failures)
                .saturating_add(jitter)
                .min(300),
        )
        .min(deadline.saturating_duration_since(Instant::now()));
        tokio::select! { _ = tokio::time::sleep(delay) => {}, _ = process.cancellation.cancelled() => {} }
    };
    store.release(&lease)?;
    Ok(result)
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
        let state =
            Store::new(identity, o.state_root.as_deref())?.acknowledge(&id, watch_store::now())?;
        return Ok(Report::success(
            "inbox",
            "acknowledged",
            json!({"subscription":state.identity,"event_id":id,"acknowledgement":"explicit_transport_receipt","human_read":false}),
        ));
    }
    if o.no_refresh {
        let state = watch_store::read(&identity, o.state_root.as_deref())?;
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
            state_root: o.state_root,
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
