//! Bounded polling owns leases, local revalidation and durable event publication.
use super::normalized::{Observation, empty_next_step, normalized, override_next_step};
use super::{ObservedEvents, Options, Timing, local_snapshot, timing};
use crate::{
    config,
    diagnostic::{Code, Diagnostic},
    observation::{self, Observation as NativeObservation},
    process::Process,
    project::{self, Context},
    watch_store::{self, ActionKind, EventState, Identity, Revision, Store},
};
use std::{
    path::Path,
    time::{Duration, Instant},
};

async fn observe(
    identity: &Identity,
    context: &Context,
    process: &Process,
    budget: Duration,
    cycle: &Cycle<'_>,
    verified: &mut Option<String>,
) -> (Observation, Option<Diagnostic>) {
    let read = async {
        let collected =
            observation::collect(identity.request, process.clone(), &context.root).await?;
        let fingerprint = collected.fingerprint(cycle.digest.as_deref());
        let candidate = normalized(
            &collected.assessment,
            context,
            identity.goal,
            identity.request,
            cycle.digest.as_deref(),
        );
        let complete = collected.complete();
        let terminal = candidate.terminal
            || collected
                .assessment
                .evidence
                .request
                .as_ref()
                .is_some_and(|r| matches!(r.state.as_str(), "merged" | "closed"));
        let assessment =
            if !cycle.once && complete && !terminal && verified.as_ref() == Some(&fingerprint) {
                // Two independent collections agree with this loop's verified facts.
                collected.assessment
            } else {
                collected.verify().await?
            };
        Ok::<_, Diagnostic>((assessment, (complete && !terminal).then_some(fingerprint)))
    };
    let result = tokio::time::timeout(budget, Box::pin(read)).await;
    let (assessment, persistence_failure) = match result {
        Ok(Ok((assessment, fingerprint))) => {
            *verified = fingerprint;
            let persistence_failure = retire_delivered(context, &assessment);
            (assessment, persistence_failure)
        }
        Ok(Err(d)) => {
            *verified = None;
            (NativeObservation::unavailable(d), None)
        }
        Err(_) => {
            *verified = None;
            (
                NativeObservation::unavailable(Diagnostic::new(
                    Code::Timeout,
                    "watch",
                    "The native observation deadline expired.",
                    "Resume; partial evidence is not acceptance.",
                )),
                None,
            )
        }
    };
    (
        normalized(
            &assessment,
            context,
            identity.goal,
            identity.request,
            cycle.digest.as_deref(),
        ),
        persistence_failure,
    )
}

/// A verified merged read of this checkpoint's own request retires it. A failed
/// write leaves the checkpoint unchanged and stays visible to the caller.
fn retire_delivered(context: &Context, assessment: &NativeObservation) -> Option<Diagnostic> {
    use crate::observation::Status;
    if !matches!(
        assessment.status,
        Status::Merged | Status::Completed | Status::MergedIssuesOpen
    ) || !assessment.diagnostics.is_empty()
        || assessment.evidence.repository.as_ref() != Some(&context.repository)
    {
        return None;
    }
    let (request, project_id) = (
        assessment.evidence.request.as_ref()?,
        assessment.evidence.project_id?,
    );
    crate::selection::record_delivery(context, project_id, request)
        .err()
        .map(|d| crate::selection::delivered_persistence_failure(d, true))
}

struct Cycle<'a> {
    declaration: &'a config::Declaration,
    digest: &'a Option<String>,
    once: bool,
}

pub(super) async fn subscribe(
    o: Options,
    process: Process,
    cwd: &Path,
    stop_on_attention: bool,
) -> Result<(ObservedEvents, Option<Diagnostic>), Diagnostic> {
    let (initial, mut declaration, mut digest) = local_snapshot(&process, cwd).await?;
    let configured = declaration.observation.clone();
    let timing = timing(&o, &configured)?;
    let identity = Identity::new(&initial, &o.session, o.request, o.goal)?;
    let store = Store::new(identity.clone())?;
    let (_lock, lease) = store.lease(watch_store::now().saturating_add(timing.max_wait_seconds))?;
    let deadline = Instant::now() + Duration::from_secs(timing.max_wait_seconds);
    let subscription = Subscription {
        options: &o,
        process: &process,
        cwd,
        identity: &identity,
        deadline,
    };
    let mut failures = 0_u32;
    let mut context = initial;
    let mut verified = None;
    let mut previous_digest = digest.clone();
    let mut first = true;
    let result = loop {
        let mut declaration_error = None;
        if !first {
            let snapshot = config::snapshot(&context.root)?;
            digest = snapshot.digest();
            let parsed = snapshot
                .bytes
                .as_deref()
                .ok_or_else(|| {
                    Diagnostic::input("Initialize a v2 project before observing a delivery.")
                })
                .and_then(config::Declaration::parse);
            match parsed {
                Ok(current) => declaration = current,
                Err(d) => declaration_error = Some(d),
            }
        }
        first = false;
        let cycle = Cycle {
            declaration: &declaration,
            digest: &digest,
            once: o.once,
        };
        let remaining = deadline.saturating_duration_since(Instant::now());
        let (mut observation, persistence_failure) = if let Some(d) = declaration_error {
            verified = None;
            (
                normalized(
                    &NativeObservation::unavailable(d),
                    &context,
                    identity.goal,
                    identity.request,
                    digest.as_deref(),
                ),
                None,
            )
        } else {
            current_observation(
                &identity,
                &context,
                &process,
                remaining,
                &cycle,
                &mut verified,
            )
            .await
        };
        refresh(
            &subscription,
            &mut context,
            &mut observation,
            previous_digest.as_deref(),
            &cycle,
        )
        .await?;
        previous_digest = digest.clone();
        // Local refresh may supersede otherwise verified native evidence.
        if observation.revision.local_head != context.head || observation.terminal {
            verified = None;
        }
        finish_poll(&process, deadline, &mut observation);
        let state = store.publish_next_action(
            observation.revision,
            observation.state.clone(),
            observation.reason,
            observation.next_step,
            watch_store::now(),
        )?;
        if o.once
            || observation.terminal
            || (stop_on_attention
                && configured.notify.contains(&config::Notification::Attention)
                && matches!(
                    observation.state,
                    EventState::ChecksPassed | EventState::ChecksCompleted
                ))
        {
            break (
                ObservedEvents {
                    state,
                    event_state: observation.state,
                },
                persistence_failure,
            );
        }
        failures = if observation.retryable {
            failures.saturating_add(1).min(4)
        } else {
            0
        };
        let delay = backoff_delay(timing, failures, &lease.owner, deadline);
        tokio::select! { _ = tokio::time::sleep(delay) => {}, _ = process.cancellation.cancelled() => {} }
    };
    store.release(&lease)?;
    Ok(result)
}

fn append_bounded(text: &mut String, suffix: &str, limit: usize) {
    if text.len().saturating_add(suffix.len()) <= limit {
        text.push_str(suffix);
    }
}

struct Subscription<'a> {
    options: &'a Options,
    process: &'a Process,
    cwd: &'a Path,
    identity: &'a Identity,
    deadline: Instant,
}

async fn refresh(
    subscription: &Subscription<'_>,
    context: &mut Context,
    observation: &mut Observation,
    declaration_before: Option<&str>,
    cycle: &Cycle<'_>,
) -> Result<(), Diagnostic> {
    let o = subscription.options;
    let process = subscription.process;
    let cwd = subscription.cwd;
    let identity = subscription.identity;
    let deadline = subscription.deadline;
    if !process.cancellation.is_cancelled() && Instant::now() < deadline {
        let refreshed =
            tokio::time::timeout(deadline.saturating_duration_since(Instant::now()), async {
                let current = config::resolve(
                    process,
                    cwd,
                    cycle.declaration.remote.as_deref(),
                    cycle.declaration.provider,
                    None,
                )
                .await?;
                let local_ahead = observation.same_source_mismatch
                    && observation.revision.head != current.head
                    && project::git(
                        process,
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
                Ok::<_, Diagnostic>((current, local_ahead))
            })
            .await;
        match refreshed {
            Ok(Ok((current, local_ahead)))
                if Identity::new(&current, &o.session, o.request, o.goal)? == *identity =>
            {
                if current.branch != context.branch || cycle.digest.as_deref() != declaration_before
                {
                    observation.state = EventState::IdentityChanged;
                    observation.reason = "Local branch/declaration changed during observation; the previous assessment was superseded.".into();
                    override_next_step(
                        observation,
                        ActionKind::ReconcileSubscription,
                        "The local branch or declaration changed during observation. Reconcile the subscription, then refresh native evidence.",
                    );
                    observation.revision.local_head = current.head.clone();
                    observation.terminal = true;
                } else if observation
                    .next_step
                    .request_state
                    .as_deref()
                    .is_some_and(|state| matches!(state, "merged" | "closed"))
                {
                    // The native request state is merged or closed. Local
                    // divergence stays in the revision and bounded guidance; it
                    // is never treated as new deliverable work for that request.
                    let divergent = context.dirty
                        || observation.revision.head != observation.revision.local_head
                        || current.head != context.head
                        || current.dirty != context.dirty;
                    if divergent {
                        match observation.state {
                            EventState::Completed => {
                                observation.next_step.message = "Native evidence confirms the selected request was merged and its associated issues were closed. This merged request accepts no new work; local commits or edits do not change that result. Start additional work from a new branch or worktree and select new Issues.".into();
                            }
                            EventState::MergedIssuesOpen => append_bounded(
                                &mut observation.reason,
                                " Local commits or edits do not change this native merge; this request accepts no new work. Start additional work from a new branch or worktree and select new Issues. The listed open Issues still require inspection.",
                                4096,
                            ),
                            EventState::Unknown => append_bounded(
                                &mut observation.reason,
                                " Local commits or edits do not change the native state. Verify the current request and issue facts first; additional local work requires a new branch or worktree and a new Issue selection.",
                                4096,
                            ),
                            EventState::ClosedUnmerged => append_bounded(
                                &mut observation.reason,
                                " Local commits or edits do not change this closed request, and a push cannot reopen it. Choose reopen or follow-up explicitly; additional local work requires a new branch or worktree and a new Issue selection.",
                                4096,
                            ),
                            _ => {}
                        }
                        observation.revision.local_head = current.head.clone();
                    }
                } else if local_ahead {
                    observation.state = EventState::Pending;
                    observation.reason = "Local commits are ahead of the selected native source head; previous success is superseded.".into();
                    override_next_step(
                        observation,
                        ActionKind::RefreshNativeEvidence,
                        "Local commits are ahead of the selected request. Push reviewed commits through the ordinary native workflow, then refresh native evidence.",
                    );
                    observation.next_step.requires_user_authorization = true;
                    observation.next_step.message.push_str(
                        " The Agent can execute this scoped push under existing task authorization; seek permission only for missing scope.",
                    );
                    observation.revision.local_head = current.head.clone();
                    observation.terminal = false;
                    observation.retryable = false;
                } else if current.head != context.head || current.dirty != context.dirty {
                    observation.state = EventState::Pending;
                    observation.reason = "Local changes superseded the assessment; the selected source branch will be observed again.".into();
                    override_next_step(
                        observation,
                        ActionKind::RefreshNativeEvidence,
                        "Local changes superseded this assessment. Continue the subscription and refresh native evidence for the current revision.",
                    );
                    observation.revision.local_head = current.head.clone();
                    observation.terminal = false;
                    observation.retryable = false;
                }
                *context = current;
            }
            Err(_) => {} // The deadline is classified below, after child cleanup.
            Ok(Err(d)) if d.code == Code::Cancelled => {}
            _ => {
                observation.state = EventState::IdentityChanged;
                observation.reason = "The subscriber worktree or project identity changed.".into();
                override_next_step(
                    observation,
                    ActionKind::ReconcileSubscription,
                    "The subscriber worktree or project identity changed. Reconcile the subscription, then refresh native evidence.",
                );
                observation.terminal = true;
            }
        }
    }
    Ok(())
}

async fn current_observation(
    identity: &Identity,
    context: &Context,
    process: &Process,
    remaining: Duration,
    cycle: &Cycle<'_>,
    verified: &mut Option<String>,
) -> (Observation, Option<Diagnostic>) {
    if remaining.is_zero() || process.cancellation.is_cancelled() {
        (
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
                    identity,
                    ActionKind::ResumeSubscription,
                    "The bounded observation stopped before confirming the goal. Resume this exact subscription to collect fresh native evidence.",
                ),
                terminal: true,
                retryable: false,
                same_source_mismatch: false,
            },
            None,
        )
    } else {
        observe(
            identity,
            context,
            process,
            remaining.min(Duration::from_secs(90)),
            cycle,
            verified,
        )
        .await
    }
}

fn finish_poll(process: &Process, deadline: Instant, observation: &mut Observation) {
    if process.cancellation.is_cancelled() || Instant::now() >= deadline {
        observation.state = if process.cancellation.is_cancelled() {
            EventState::Cancelled
        } else {
            EventState::TimedOut
        };
        observation.reason = "The bounded subscription remains resumable.".into();
        override_next_step(
            observation,
            ActionKind::ResumeSubscription,
            "The bounded observation stopped before confirming the goal. Resume this exact subscription to collect fresh native evidence.",
        );
        observation.terminal = true;
    }
    if observation.state == EventState::IdentityChanged {
        override_next_step(
            observation,
            ActionKind::ReconcileSubscription,
            "The selected worktree, source, head, or target changed. Reconcile the subscription, then refresh native evidence.",
        );
    }
}

fn backoff_delay(timing: Timing, failures: u32, owner: &str, deadline: Instant) -> Duration {
    let jitter = if failures == 0 {
        0
    } else {
        u64::from(owner.as_bytes()[failures as usize] % 3)
    };
    Duration::from_secs(
        timing
            .poll_seconds
            .saturating_mul(1 << failures)
            .saturating_add(jitter)
            .min(300),
    )
    .min(deadline.saturating_duration_since(Instant::now()))
}
