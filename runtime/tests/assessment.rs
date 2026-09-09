use specgit::{
    assessment::{self, DeclarationEvidence, Lifecycle, Snapshot, Status},
    config::Declaration,
    delivery_model::{Check, Flow, Issue, PullRequest, RequiredCheck, Requirements, SourceCleanup},
    diagnostic::{Code, Diagnostic},
};
fn snapshot() -> Snapshot {
    let rules =
        Declaration::parse(b"version: 2\nverification:\n  required_checks: [Build]\n").unwrap();
    Snapshot {
        request: PullRequest {
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
        },
        issues: vec![Issue {
            id: 1,
            title: "feat: example".into(),
            body: "example".into(),
            labels: vec![],
            state: "open".into(),
            updated_at: "2026-09-09T00:00:00Z".into(),
        }],
        declaration: DeclarationEvidence {
            source: "target_revision",
            target_commit: "b".repeat(40),
            approved_digest: "c".repeat(64),
            candidate_digest: "c".repeat(64),
            candidate_changed: false,
            candidate_rules: rules.clone(),
        },
        rules,
        dirty: false,
        lifecycle: Lifecycle::Open {
            requirements: Requirements {
                checks: vec![],
                pipeline_required: false,
                approvals_required: 0,
                approvals_satisfied: true,
                mergeable: true,
            },
            checks: vec![Check {
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
            }],
        },
        flow: Flow {
            target: "main".into(),
            native_default: "main".into(),
            targets_native_default: true,
            issue_closing: "unknown",
            source_cleanup: "unknown",
            warnings: vec![],
        },
    }
}
#[test]
fn pure_acceptance_rejection_and_initial_adoption() {
    assert_eq!(assessment::assess(Ok(snapshot())).status, Status::Accepted);
    let mut s = snapshot();
    s.dirty = true;
    let a = assessment::assess(Ok(s));
    assert_eq!(a.status, Status::Rejected);
    assert!(
        a.evidence
            .blockers
            .unwrap()
            .contains(&"local_worktree_dirty".into())
    );
    let mut s = snapshot();
    s.declaration.source = "initial_adoption";
    assert_eq!(assessment::assess(Ok(s)).status, Status::InitialAdoption);
}
#[test]
fn missing_and_changed_snapshots_never_become_empty_success() {
    for code in [
        Code::MalformedResponse,
        Code::NetworkFailed,
        Code::ConcurrentEdit,
    ] {
        let a = assessment::assess(Err(Diagnostic::new(
            code.clone(),
            "finish",
            "unavailable",
            "read again",
        )));
        assert_eq!(a.status, Status::Unknown);
        assert_eq!(a.exit(), 3);
        assert!(!a.accepted());
        assert_eq!(a.diagnostics[0].code, code);
    }
    let mut s = snapshot();
    s.issues.clear();
    assert_eq!(assessment::assess(Ok(s)).status, Status::Unknown);
    let mut s = snapshot();
    s.issues.push(s.issues[0].clone());
    assert_eq!(assessment::assess(Ok(s)).status, Status::Unknown);
}
#[test]
fn native_required_app_and_optional_failures_remain_distinct() {
    let mut s = snapshot();
    if let Lifecycle::Open { requirements, .. } = &mut s.lifecycle {
        requirements.checks.push(RequiredCheck {
            name: "Build".into(),
            app: Some(9),
        });
    }
    let a = assessment::assess(Ok(s));
    assert_eq!(a.status, Status::Rejected);
    assert!(
        a.evidence
            .blockers
            .unwrap()
            .contains(&"check_missing:Build".into())
    );
    let mut s = snapshot();
    if let Lifecycle::Open { checks, .. } = &mut s.lifecycle {
        checks[0].allow_failure = true;
        checks[0].conclusion = Some("failure".into());
    }
    assert_eq!(assessment::assess(Ok(s)).status, Status::Rejected);
    let mut s = snapshot();
    s.rules.verification.required_checks.clear();
    if let Lifecycle::Open { checks, .. } = &mut s.lifecycle {
        checks[0].allow_failure = true;
        checks[0].conclusion = Some("failure".into());
    }
    assert_eq!(assessment::assess(Ok(s)).status, Status::Accepted);
}
#[test]
fn completed_requires_merge_and_all_associated_issues_closed() {
    let mut s = snapshot();
    s.request.state = "merged".into();
    s.lifecycle = Lifecycle::Merged(SourceCleanup::Unknown);
    assert_eq!(assessment::assess(Ok(s)).status, Status::MergedIssuesOpen);
    let mut s = snapshot();
    s.request.state = "merged".into();
    s.issues[0].state = "closed".into();
    s.lifecycle = Lifecycle::Merged(SourceCleanup::Present);
    s.dirty = true;
    assert_eq!(assessment::assess(Ok(s)).status, Status::Completed);
    let mut s = snapshot();
    s.lifecycle = Lifecycle::Merged(SourceCleanup::Unknown);
    assert_eq!(assessment::assess(Ok(s)).status, Status::Unknown);
}
#[test]
fn pure_preflight_rejects_identity_authority_and_unresolved_selection() {
    let s = snapshot();
    assert!(assessment::identity(&s.request, 7, &s.request.head, "feature", "main").is_ok());
    let a = assessment::identity(&s.request, 7, &"b".repeat(40), "feature", "main").unwrap_err();
    assert_eq!(a.status, Status::Rejected);
    assert_eq!(a.evidence.project_id, Some(7));
    let mut rules = s.rules.clone();
    rules.target = Some("dev".into());
    assert!(
        assessment::associations(
            &s.request,
            &rules,
            &s.rules,
            specgit::project::Provider::Github,
            "main",
            None
        )
        .is_err()
    );
    assert!(
        assessment::associations(
            &s.request,
            &s.rules,
            &s.rules,
            specgit::project::Provider::Github,
            "main",
            Some(assessment::SelectionIntent {
                issues: &[1],
                unresolved: true
            })
        )
        .is_err()
    );
}
