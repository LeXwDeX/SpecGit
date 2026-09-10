use specgit::{
    delivery_model::{Check, Issue, PullRequest},
    diagnostic::{Code, Diagnostic},
    observation::{self, AutoMerge, CheckOutcome, Evidence, Observation, Status},
};

fn evidence() -> Evidence {
    Evidence {
        project_id: Some(7),
        request: Some(PullRequest {
            id: 2,
            title: "feat: example".into(),
            body: "Closes #1".into(),
            labels: vec![],
            state: "open".into(),
            draft: false,
            head: "a".repeat(40),
            source: "feature".into(),
            target: "main".into(),
            source_project: 7,
            target_project: 7,
            updated_at: "2026-09-09T00:00:00Z".into(),
        }),
        issues: Some(vec![Issue {
            id: 1,
            title: "feat: example".into(),
            body: "example".into(),
            labels: vec![],
            state: "open".into(),
            updated_at: "2026-09-09T00:00:00Z".into(),
        }]),
        association_source: Some("closing_references"),
        checks: Some(vec![Check {
            name: "Build".into(),
            source: "check_run".into(),
            head: "a".repeat(40),
            id: 3,
            app: Some(8),
            workflow: Some(4),
            workflow_attempt: Some(1),
            pipeline: None,
            project: Some(7),
            status: "completed".into(),
            conclusion: Some("success".into()),
            started_at: None,
            completed_at: None,
            allow_failure: false,
        }]),
        auto_merge: Some(AutoMerge::NotRegistered),
        ..Evidence::default()
    }
}

#[test]
fn lifecycle_describes_native_states_without_acceptance() {
    for (state, expected) in [
        ("open", Status::Open),
        ("opened", Status::Open),
        ("closed", Status::ClosedUnmerged),
        ("merged", Status::MergedIssuesOpen),
    ] {
        let mut e = evidence();
        e.request.as_mut().unwrap().state = state.into();
        let observed = observation::describe(e);
        assert_eq!(observed.status, expected);
        assert_eq!(observed.exit(), 0);
    }
    let mut e = evidence();
    e.request.as_mut().unwrap().draft = true;
    e.local_head = Some("b".repeat(40));
    let observed = observation::describe(e);
    assert_eq!(observed.status, Status::Open);
    assert_eq!(observed.checks_outcome(), CheckOutcome::Passed);
    assert_eq!(observed.exit(), 0);
    assert!(!observed.evidence.close_issues_after_merge);
}

#[test]
fn missing_failed_and_changed_reads_remain_unavailable() {
    for code in [
        Code::MalformedResponse,
        Code::NetworkFailed,
        Code::ConcurrentEdit,
    ] {
        let observed = Observation::unavailable(Diagnostic::new(
            code.clone(),
            "observe",
            "unavailable",
            "read again",
        ));
        assert_eq!(observed.status, Status::Unknown);
        assert_eq!(observed.exit(), 3);
        assert_eq!(observed.checks_outcome(), CheckOutcome::Unobserved);
        assert_eq!(observed.diagnostics[0].code, code);
    }
    for (code, status, exit) in [
        (Code::InvalidInput, Status::InvalidInput, 2),
        (Code::Cancelled, Status::Cancelled, 130),
    ] {
        let observed =
            Observation::unavailable(Diagnostic::new(code, "observe", "stopped", "retry"));
        assert_eq!(observed.status, status);
        assert_eq!(observed.exit(), exit);
    }
}

#[test]
fn malformed_native_identity_or_state_cannot_be_a_successful_observation() {
    let cases: &[fn(&mut Evidence)] = &[
        |e| e.request = None,
        |e| e.request.as_mut().unwrap().state = "unknown".into(),
        |e| e.request.as_mut().unwrap().id = 0,
        |e| e.request.as_mut().unwrap().head = "not-a-sha".into(),
        |e| e.request.as_mut().unwrap().source_project = 0,
        |e| e.request.as_mut().unwrap().target_project = 0,
        |e| e.issues.as_mut().unwrap()[0].id = 0,
        |e| e.issues.as_mut().unwrap()[0].state = "unknown".into(),
        |e| e.checks.as_mut().unwrap()[0].head = "f".repeat(40),
        |e| e.checks.as_mut().unwrap()[0].project = Some(99),
        |e| e.checks.as_mut().unwrap()[0].workflow_attempt = Some(0),
        |e| {
            let issues = e.issues.as_mut().unwrap();
            issues.push(issues[0].clone());
        },
    ];
    for (index, mutate) in cases.iter().enumerate() {
        let mut e = evidence();
        mutate(&mut e);
        let observed = observation::describe(e);
        assert_eq!(observed.status, Status::Unknown, "case {index}");
        assert_eq!(observed.exit(), 3, "case {index}");
    }
}

#[test]
fn completion_requires_merge_and_nonempty_known_closed_associations() {
    let mut e = evidence();
    e.issues.as_mut().unwrap()[0].state = "closed".into();
    assert_eq!(observation::describe(e).status, Status::Open);
    let mut e = evidence();
    e.request.as_mut().unwrap().state = "merged".into();
    e.issues.as_mut().unwrap()[0].state = "closed".into();
    let observed = observation::describe(e);
    assert_eq!(observed.status, Status::Completed);
    assert_eq!(observed.exit(), 0);
    let mut e = evidence();
    e.request.as_mut().unwrap().state = "merged".into();
    e.issues.as_mut().unwrap()[0].state = "closed".into();
    e.association_discrepancies = vec![4];
    let observed = observation::describe(e);
    assert_eq!(observed.status, Status::Merged);
    assert_eq!(observed.evidence.association_discrepancies, vec![4]);
    for issues in [None, Some(vec![])] {
        let mut e = evidence();
        e.request.as_mut().unwrap().state = "merged".into();
        e.issues = issues;
        assert_eq!(observation::describe(e).status, Status::Merged);
    }
    let mut e = evidence();
    e.request.as_mut().unwrap().state = "merged".into();
    let issues = e.issues.as_mut().unwrap();
    let mut closed = issues[0].clone();
    closed.id = 4;
    closed.state = "closed".into();
    issues.push(closed);
    assert_eq!(observation::describe(e).status, Status::MergedIssuesOpen);
}

#[test]
fn check_outcomes_are_facts_independent_of_command_exit() {
    for (status, conclusion, expected) in [
        ("completed", Some("success"), CheckOutcome::Passed),
        ("completed", Some("failure"), CheckOutcome::Failed),
        ("completed", Some("skipped"), CheckOutcome::Completed),
        ("completed", Some("neutral"), CheckOutcome::Completed),
        ("in_progress", None, CheckOutcome::Pending),
    ] {
        let mut e = evidence();
        let check = &mut e.checks.as_mut().unwrap()[0];
        check.status = status.into();
        check.conclusion = conclusion.map(Into::into);
        check.allow_failure = true;
        let observed = observation::describe(e);
        assert_eq!(observed.checks_outcome(), expected);
        assert_eq!(observed.status, Status::Open);
        assert_eq!(observed.exit(), 0);
    }
    for checks in [None, Some(vec![])] {
        let mut e = evidence();
        e.checks = checks;
        let observed = observation::describe(e);
        assert_eq!(observed.checks_outcome(), CheckOutcome::Unobserved);
        assert_eq!(observed.exit(), 0);
    }
}

#[test]
fn native_check_identity_rejects_stale_heads_projects_and_attempts() {
    let e = evidence();
    let request = e.request.as_ref().unwrap();
    let checks = e.checks.as_ref().unwrap();
    assert!(checks[0].valid_for(request, checks));
    for mutate in [
        (|c: &mut Check| c.head = "f".repeat(40)) as fn(&mut Check),
        |c| c.project = Some(99),
        |c| c.workflow_attempt = Some(0),
    ] {
        let mut altered = checks.clone();
        mutate(&mut altered[0]);
        assert!(!altered[0].valid_for(request, &altered));
    }
    let mut conflicting = checks.clone();
    let mut other = conflicting[0].clone();
    other.workflow_attempt = Some(2);
    conflicting.push(other);
    assert!(
        conflicting
            .iter()
            .all(|c| !c.valid_for(request, &conflicting))
    );
}
