//! Bounded observation through read-only finish; durable transport is not acceptance.
use crate::{
    assessment::{Assessment, Status},
    config,
    diagnostic::{Code, Diagnostic},
    observation,
    process::Process,
    project::{self, Context},
    report::Report,
    watch_store::{self, EventState, Goal, Identity, Revision, State, Store},
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
    #[arg(long, default_value_t=1800, value_parser=clap::value_parser!(u64).range(1..=3600))]
    pub timeout_seconds: u64,
    #[arg(long, default_value_t=15, value_parser=clap::value_parser!(u64).range(1..=300))]
    pub poll_seconds: u64,
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
    let bytes = project::git(process, cwd, &["rev-parse", "--show-toplevel"]).await?;
    let root = PathBuf::from(
        String::from_utf8(bytes)
            .map_err(|_| Diagnostic::input("Invalid Git root."))?
            .trim_end_matches(['\r', '\n']),
    );
    let declaration = config::read(&root)?
        .ok_or_else(|| Diagnostic::input("Initialize a v2 project before observing a delivery."))?;
    config::resolve(
        process,
        &root,
        declaration.remote.as_deref(),
        declaration.provider,
        None,
    )
    .await
}
struct Observation {
    revision: Revision,
    state: EventState,
    reason: String,
    next_action: String,
    terminal: bool,
    retryable: bool,
    same_source_mismatch: bool,
}
fn normalized(assessment: &Assessment, context: &Context, goal: Goal) -> Observation {
    let evidence = &assessment.evidence;
    let request = evidence.request.as_ref();
    let declaration = evidence.declaration.as_ref();
    let head = request.map_or_else(|| context.head.clone(), |r| r.head.clone());
    let target = request.map_or_else(String::new, |r| r.target.clone());
    let declaration_digest = declaration
        .map(|d| d.approved_digest.clone())
        .or_else(|| {
            config::snapshot(&context.root)
                .ok()
                .and_then(|s| s.digest())
        })
        .unwrap_or_default();
    #[derive(serde::Serialize)]
    struct IssueState<'a> {
        id: u64,
        state: &'a str,
    }
    #[derive(serde::Serialize)]
    struct Projection<'a> {
        checks: &'a Option<Vec<crate::delivery_model::Check>>,
        required: &'a Option<Vec<crate::delivery_model::RequiredCheck>>,
        blockers: &'a Option<Vec<String>>,
        issues: Vec<IssueState<'a>>,
        request_state: Option<&'a str>,
        draft: Option<bool>,
        target_commit: Option<&'a str>,
        diagnostics: Vec<&'a Code>,
    }
    // Only the bounded typed projection enters durable transport; never private descriptions.
    let projection = Projection {
        checks: &evidence.checks,
        required: &evidence.required_checks,
        blockers: &evidence.blockers,
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
        target_commit: declaration.map(|d| d.target_commit.as_str()),
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
    let blockers = evidence.blockers.as_deref().unwrap_or(&[]);
    let codes: Vec<_> = assessment.diagnostics.iter().map(|d| &d.code).collect();
    let required_terminal_failure = evidence.required_checks.iter().flatten().any(|required| {
        evidence.checks.iter().flatten().any(|check| {
            check.name == required.name
                && required.app.is_none_or(|app| check.app == Some(app))
                && check.status == "completed"
                && check.conclusion.as_deref() != Some("success")
        })
    });
    let state = if revision.head != revision.local_head
        || request.is_some_and(|r| Some(r.source.as_str()) != context.branch.as_deref())
    {
        EventState::IdentityChanged
    } else if assessment.status == Status::Completed {
        EventState::Completed
    } else if assessment.status == Status::MergedIssuesOpen {
        EventState::MergedIssuesOpen
    } else if request.is_some_and(|r| r.state == "closed") {
        EventState::ClosedUnmerged
    } else if codes.contains(&&Code::Cancelled) {
        EventState::Cancelled
    } else if matches!(assessment.status, Status::Unknown | Status::InvalidInput) {
        EventState::Unknown
    } else if required_terminal_failure
        || (assessment.exit() == 1 && evidence.checks.is_none())
        || blockers
            .iter()
            .any(|b| b.starts_with("check_failed:") || b == "spec_invalid")
    {
        EventState::Failed
    } else if evidence.checks.is_some()
        && !blockers
            .iter()
            .any(|b| b.starts_with("check_") || b == "head_pipeline_missing")
    {
        EventState::ChecksPassed
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
    ) || (state == EventState::ChecksPassed && goal == Goal::Checks)
        || (state == EventState::Unknown && !retryable);
    let mut reason = if blockers.is_empty() {
        if codes.is_empty() {
            assessment.status.as_str().to_owned()
        } else {
            serde_json::to_string(&codes).expect("codes serialize")
        }
    } else {
        blockers.join(", ")
    };
    let mut end = reason.len().min(4096);
    while !reason.is_char_boundary(end) {
        end -= 1;
    }
    reason.truncate(end);
    let next_action = match state {
        EventState::Completed => "The selected native request and associated issues are complete; programme completion is separate.",
        EventState::ChecksPassed if goal == Goal::Checks => "Current checks passed. Review, merge and issue closure remain separate native facts.",
        EventState::ChecksPassed => "Current checks passed; continue observing the explicitly selected native lifecycle.",
        EventState::MergedIssuesOpen => "Inspect native issue-closing eligibility; the observer will not close issues itself.",
        EventState::ClosedUnmerged => "The native request closed without merge; select subsequent work explicitly.",
        EventState::IdentityChanged => "Reconcile the current source/head/target and resume this exact subscription.",
        EventState::Failed => "Inspect the native failure and perform an ordinary reviewed repair.",
        _ => "Resume this exact session/worktree subscription after fresh native evidence is available.",
    }.into();
    Observation {
        revision,
        state,
        reason,
        next_action,
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
        Err(_) => Assessment::unavailable(Diagnostic::new(
            Code::Timeout,
            "watch",
            "The native observation deadline expired.",
            "Resume; partial evidence is not acceptance.",
        )),
    };
    normalized(&assessment, context, identity.goal)
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
        json!({"subscription":state.identity,"events":events,"expired_unacknowledged":state.expired_unacknowledged,"transport":"offered_not_acknowledged","programme_completed":false}),
    );
    result.exit = match event_state {
        EventState::Completed => 0,
        EventState::ChecksPassed if state.identity.goal == Goal::Checks => 0,
        EventState::Failed | EventState::MergedIssuesOpen | EventState::ClosedUnmerged => 1,
        EventState::Cancelled => 130,
        _ => 3,
    };
    result
}
pub async fn run(o: Options, process: Process, cwd: &Path) -> Report {
    match Box::pin(execute(o, process, cwd)).await {
        Ok(r) => r,
        Err(d) => Report::failure("watch", d),
    }
}
async fn execute(o: Options, process: Process, cwd: &Path) -> Result<Report, Diagnostic> {
    if !(1..=3600).contains(&o.timeout_seconds) || !(1..=300).contains(&o.poll_seconds) {
        return Err(Diagnostic::input(
            "Invalid observer polling or deadline bound.",
        ));
    }
    let initial = local(&process, cwd).await?;
    let identity = Identity::new(&initial, &o.session, o.request, o.goal)?;
    let store = Store::new(identity.clone(), o.state_root.as_deref())?;
    let (_lock, lease) = store.lease(watch_store::now().saturating_add(o.timeout_seconds))?;
    let deadline = Instant::now() + Duration::from_secs(o.timeout_seconds);
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
                next_action: "Resume this exact subscription for fresh native evidence.".into(),
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
                        observation.revision.local_head = current.head.clone();
                        observation.terminal = true;
                    } else if local_ahead {
                        observation.state = EventState::Pending;
                        observation.reason = "Local commits are ahead of the selected native source head; previous success is superseded.".into();
                        observation.next_action = "Push the reviewed commits through the ordinary native workflow; observation will continue for the selected request.".into();
                        observation.revision.local_head = current.head.clone();
                        observation.terminal = false;
                        observation.retryable = false;
                    } else if current.head != context.head || current.dirty != context.dirty {
                        observation.state = EventState::Pending;
                        observation.reason = "Local changes superseded the assessment; the selected source branch will be observed again.".into();
                        observation.next_action = "Continue this subscription with fresh native evidence for the current local revision.".into();
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
            observation.next_action =
                "Resume this exact subscription for fresh native evidence.".into();
            observation.terminal = true;
        }
        if observation.state == EventState::IdentityChanged {
            observation.next_action = "Reconcile the current subscriber identity and resume for a fresh native assessment.".into();
        }
        let state = store.publish(
            observation.revision,
            observation.state.clone(),
            observation.reason,
            observation.next_action,
            watch_store::now(),
        )?;
        if o.once || observation.terminal {
            break report(&state, &observation.state);
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
            o.poll_seconds
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
    let context = local(&process, cwd).await?;
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
            timeout_seconds: 90,
            poll_seconds: 15,
            once: true,
        },
        process,
        cwd,
    )
    .await;
    r.operation = "inbox".into();
    Ok(r)
}
