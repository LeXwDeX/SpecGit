#![cfg(feature = "test-fixtures")]
#[path = "support/acceptance.rs"]
mod acceptance;
#[path = "support/delivery.rs"]
mod delivery;
use acceptance::fixture;
use serde_json::{Value, json};
use specgit::watch_store::{self, ActionKind, EventState, Identity, Revision, Store};

/// Preserve the observer's result on assertion failures and reap the exact child.
struct WatchProcess {
    child: std::process::Child,
    stdout: std::fs::File,
    stderr: std::fs::File,
    identity: Identity,
    scenario: &'static str,
    started: std::time::Instant,
    lease_deadline: Option<u64>,
}
impl WatchProcess {
    fn spawn(
        mut command: std::process::Command,
        identity: &Identity,
        scenario: &'static str,
    ) -> Self {
        let stdout = tempfile::tempfile().unwrap();
        let stderr = tempfile::tempfile().unwrap();
        let child = command
            .stdout(stdout.try_clone().unwrap())
            .stderr(stderr.try_clone().unwrap())
            .spawn()
            .unwrap();
        Self {
            child,
            stdout,
            stderr,
            identity: identity.clone(),
            scenario,
            started: std::time::Instant::now(),
            lease_deadline: None,
        }
    }
    fn output(&mut self) -> (String, String) {
        use std::io::{Read, Seek, SeekFrom};
        let read = |file: &mut std::fs::File| {
            file.seek(SeekFrom::Start(0)).unwrap();
            let mut text = String::new();
            file.read_to_string(&mut text).unwrap();
            text
        };
        (read(&mut self.stdout), read(&mut self.stderr))
    }
    fn diagnostic(&mut self) -> Value {
        let (stdout, stderr) = self.output();
        json!({
            "scenario": self.scenario,
            "elapsed_ms": self.started.elapsed().as_millis(),
            "child_status": self.child.try_wait().unwrap().map(|s| s.to_string()),
            "state": watch_store::read(&self.identity).unwrap(),
            "stdout": stdout,
            "stderr": stderr,
        })
    }
}
impl std::ops::Deref for WatchProcess {
    type Target = std::process::Child;
    fn deref(&self) -> &Self::Target {
        &self.child
    }
}
impl std::ops::DerefMut for WatchProcess {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.child
    }
}
impl Drop for WatchProcess {
    fn drop(&mut self) {
        if let Some(directory) = std::env::var_os("SPECGIT_WATCH_DIAGNOSTICS") {
            let directory = std::path::PathBuf::from(directory);
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(
                directory.join(format!("{}.json", self.scenario)),
                serde_json::to_vec_pretty(&self.diagnostic()).unwrap(),
            )
            .unwrap();
        }
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}
fn watch(goal: &str) -> [&str; 8] {
    [
        "watch",
        "--request",
        "41",
        "--session",
        "session-a",
        "--goal",
        goal,
        "--once",
    ]
}
fn inbox() -> [&'static str; 7] {
    inbox_for("checks")
}
fn inbox_for(goal: &'static str) -> [&'static str; 7] {
    [
        "inbox",
        "--request",
        "41",
        "--session",
        "session-a",
        "--goal",
        goal,
    ]
}
/// Add one ordinary local commit while no guard is installed. This reproduces
/// work that happened after a native merge but before the checkpoint retired.
fn local_commit(f: &delivery::Fixture) -> String {
    use std::process::Command;
    std::fs::write(f.root.join("local-after-merge.txt"), "later work").unwrap();
    for args in [
        &["add", "local-after-merge.txt"][..],
        &["commit", "-q", "-m", "local work after merge"][..],
    ] {
        let output = Command::new("git")
            .current_dir(&f.root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    String::from_utf8(
        Command::new("git")
            .current_dir(&f.root)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_owned()
}

fn request_reads(f: &delivery::Fixture) -> usize {
    f.state()["calls"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|call| {
            call["method"] == "GET"
                && call["endpoint"].as_str().is_some_and(|endpoint| {
                    endpoint.ends_with("/pulls/41") || endpoint.ends_with("/merge_requests/41")
                })
        })
        .count()
}

/// The observer's requested budget in polling tests.
const POLLING_TIMEOUT_SECONDS: u64 = 60;

impl WatchProcess {
    /// Waits assert no tighter bound than the observer's own budget. Once the
    /// child records its lease, its lease deadline bounds the wait: by then it
    /// has polled or published `timed_out`. Before that, the test bounds child
    /// startup by the same requested timeout.
    fn within_budget(&mut self, state: Option<&watch_store::State>) -> bool {
        if let Some(lease) = state
            .and_then(|s| s.lease.as_ref())
            .filter(|l| l.pid == self.child.id())
        {
            self.lease_deadline = Some(lease.deadline);
        }
        match self.lease_deadline {
            Some(deadline) => watch_store::now() < deadline,
            None => {
                self.started.elapsed() < std::time::Duration::from_secs(POLLING_TIMEOUT_SECONDS)
            }
        }
    }
}

fn wait_for_poll(f: &delivery::Fixture, child: &mut WatchProcess, polls: u64) -> usize {
    loop {
        let state = watch_store::read(&child.identity).unwrap().unwrap();
        if state
            .lease
            .as_ref()
            .is_some_and(|l| l.pid == child.id() && l.polls_completed >= polls)
        {
            // The final timed-out or cancelled publication also counts a poll
            // before the lease is released; it is not a completed observation.
            assert!(
                !state.events.last().is_some_and(|e| matches!(
                    e.state,
                    EventState::TimedOut | EventState::Cancelled
                )),
                "{}",
                child.diagnostic()
            );
            return f.state()["calls"].as_array().unwrap().len();
        }
        assert!(
            child.try_wait().unwrap().is_none(),
            "{}",
            child.diagnostic()
        );
        assert!(child.within_budget(Some(&state)), "{}", child.diagnostic());
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

fn polling(f: &delivery::Fixture, scenario: &'static str) -> WatchProcess {
    let initial = f.run(&watch("lifecycle"));
    let identity = serde_json::from_value(initial["evidence"]["subscription"].clone()).unwrap();
    f.edit(|s| s["calls"] = json!([]));
    WatchProcess::spawn(
        f.native_command(&[
            "watch",
            "--request",
            "41",
            "--session",
            "session-a",
            "--goal",
            "lifecycle",
            "--poll-seconds",
            "2",
            "--timeout-seconds",
            &POLLING_TIMEOUT_SECONDS.to_string(),
        ]),
        &identity,
        scenario,
    )
}

#[test]
fn unchanged_poll_reuses_only_this_loops_verified_evidence() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider);
        let mut child = polling(&f, "unchanged-request-count");
        let first = wait_for_poll(&f, &mut child, 1);
        let second = wait_for_poll(&f, &mut child, 2) - first;
        println!("{provider}: first poll={first}, unchanged second poll={second}");
        assert!(
            second * 3 <= first * 2,
            "unchanged poll did not skip verification: {first} -> {second}"
        );
        assert_eq!(
            request_reads(&f),
            3,
            "first poll verifies; second collects once"
        );
        child.kill().unwrap();
        child.wait().unwrap();
        // A new process must not trust the persisted event fingerprint.
        f.edit(|s| s["calls"] = json!([]));
        let once = f.run(&watch("lifecycle"));
        assert_eq!(once["status"], "checks_passed", "{once}");
        assert_eq!(request_reads(&f), 2);
    }
}

#[test]
fn changed_poll_verifies_checks_and_private_evidence_before_publishing() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider);
        set_check_state(&f, provider, "pending");
        let mut child = polling(&f, "changed-request-count");
        let first = wait_for_poll(&f, &mut child, 1);
        set_check_state(&f, provider, "passed");
        let second = wait_for_poll(&f, &mut child, 2);
        assert_eq!(second - first, first, "changed checks must fully verify");
        assert_eq!(request_reads(&f), 4);
        // Private Issue text is omitted from the durable projection, but must
        // still invalidate the polling verification fingerprint.
        f.edit(|s| {
            s["issues"][0][if provider == "github" {
                "body"
            } else {
                "description"
            }] = json!("private issue edit")
        });
        let third = wait_for_poll(&f, &mut child, 3);
        assert_eq!(
            third - second,
            first,
            "private content changes must fully verify"
        );
        // An opaque PR field not present in the presentation is also material.
        f.edit(|s| s["requests"][0]["opaque_fixture_field"] = json!(true));
        let fourth = wait_for_poll(&f, &mut child, 4);
        assert_eq!(
            fourth - third,
            first,
            "opaque request changes must fully verify"
        );
        child.kill().unwrap();
        child.wait().unwrap();
    }
}

fn finish_watcher(child: &mut WatchProcess) {
    use std::time::{Duration, Instant};
    // A timed-out observer still publishes, releases its lease and reaps its
    // children before exiting; this grace only covers that teardown.
    const EXIT_GRACE: Duration = Duration::from_secs(10);
    let mut expired_at = None;
    while child.try_wait().unwrap().is_none() {
        // Read the state only until the lease deadline is known, so these reads
        // do not contend with the observer's final state replacements.
        let state = child
            .lease_deadline
            .is_none()
            .then(|| watch_store::read(&child.identity).unwrap())
            .flatten();
        if !child.within_budget(state.as_ref()) {
            let expired = *expired_at.get_or_insert_with(Instant::now);
            assert!(expired.elapsed() < EXIT_GRACE, "{}", child.diagnostic());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn terminal_poll_fully_verifies_merged_and_closed_requests() {
    for provider in ["github", "gitlab"] {
        for merged in [false, true] {
            let f = fixture(provider);
            let mut child = polling(&f, "terminal-request-count");
            let first = wait_for_poll(&f, &mut child, 1);
            f.edit(|s| {
                s["requests"][0]["state"] = json!(if provider == "gitlab" && merged {
                    "merged"
                } else {
                    "closed"
                });
                s["requests"][0]["merged"] = json!(merged);
                s["issues"][0]["state"] = json!("closed");
            });
            finish_watcher(&mut child);
            let terminal = f.state()["calls"].as_array().unwrap().len() - first;
            println!("{provider}: merged={merged}, terminal poll={terminal}");
            assert_eq!(
                terminal, 8,
                "terminal PR, Issue, closing set and project must each be read twice"
            );
            assert_eq!(request_reads(&f), 4);
            let state = watch_store::read(&child.identity).unwrap().unwrap();
            assert_eq!(
                state.events.last().unwrap().state,
                if merged {
                    EventState::Completed
                } else {
                    EventState::ClosedUnmerged
                }
            );
            assert!(state.lease.is_none());
        }
    }
}

/// GitLab documents `state: "locked"` as a short-lived transitional merge
/// request state: https://docs.gitlab.com/api/merge_requests/#list-merge-requests
/// These bounded polls are fixture evidence, not a live GitLab transition.
#[test]
fn gitlab_locked_transition_refreshes_then_completes_after_merge() {
    let f = fixture("gitlab");
    let mut child = polling(&f, "gitlab-locked-then-merged");
    wait_for_poll(&f, &mut child, 1);
    f.edit(|s| s["requests"][0]["state"] = json!("locked"));
    wait_for_poll(&f, &mut child, 2);
    let state = watch_store::read(&child.identity).unwrap().unwrap();
    let locked = state.events.last().unwrap();
    assert_eq!(locked.state, EventState::Unknown);
    assert!(
        locked.reason.contains("unsupported_operation"),
        "{}",
        child.diagnostic()
    );
    assert_eq!(
        locked.next_step.as_ref().unwrap().request_state.as_deref(),
        Some("locked")
    );
    assert!(
        child.try_wait().unwrap().is_none(),
        "a locked request is retryable within the watch budget: {}",
        child.diagnostic()
    );
    f.edit(|s| {
        s["native_closing"] = json!([1]);
        s["requests"][0]["state"] = json!("merged");
        s["requests"][0]["merged"] = json!(true);
        s["issues"][0]["state"] = json!("closed");
    });
    finish_watcher(&mut child);
    let state = watch_store::read(&child.identity).unwrap().unwrap();
    assert_eq!(state.events.last().unwrap().state, EventState::Completed);
    assert!(state.lease.is_none());
}

#[test]
fn gitlab_locked_transition_can_return_open_without_a_terminal_event() {
    use std::time::{Duration, Instant};
    let f = fixture("gitlab");
    let mut child = polling(&f, "gitlab-locked-then-open");
    wait_for_poll(&f, &mut child, 1);
    f.edit(|s| s["requests"][0]["state"] = json!("locked"));
    wait_for_poll(&f, &mut child, 2);
    let state = watch_store::read(&child.identity).unwrap().unwrap();
    let locked = state.events.last().unwrap();
    assert_eq!(locked.state, EventState::Unknown);
    assert!(locked.reason.contains("unsupported_operation"));
    f.edit(|s| s["requests"][0]["state"] = json!("opened"));
    let started = Instant::now();
    loop {
        let state = watch_store::read(&child.identity).unwrap().unwrap();
        if state.events.last().is_some_and(|event| {
            event.state == EventState::ChecksPassed
                && event
                    .next_step
                    .as_ref()
                    .and_then(|step| step.request_state.as_deref())
                    == Some("opened")
        }) {
            break;
        }
        assert!(
            child.try_wait().unwrap().is_none(),
            "a lock returning to open stopped the watch: {}",
            child.diagnostic()
        );
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "{}",
            child.diagnostic()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let state = watch_store::read(&child.identity).unwrap().unwrap();
    let event = state.events.last().unwrap();
    assert!(!event.reason.contains("unsupported_operation"));
    child.kill().unwrap();
    child.wait().unwrap();
}

#[test]
fn watch_once_reports_locked_as_transient_without_writes() {
    let f = fixture("gitlab");
    f.edit(|s| s["requests"][0]["state"] = json!("locked"));
    let writes = f.writes();
    let result = f.run(&watch("lifecycle"));
    assert_eq!(result["exit"], 3, "{result}");
    assert_eq!(result["status"], "unknown", "{result}");
    let event = &result["evidence"]["events"][0];
    assert_eq!(event["state"], "unknown", "{result}");
    assert_eq!(event["next_step"]["request_state"], "locked", "{result}");
    assert!(
        event["reason"]
            .as_str()
            .unwrap()
            .contains("unsupported_operation"),
        "{result}"
    );
    assert_eq!(f.writes(), writes);
}

#[test]
fn unsupported_operation_without_a_locked_request_stays_terminal() {
    use std::time::{Duration, Instant};
    let f = fixture("gitlab");
    let mut child = polling(&f, "unsupported-operation-terminal");
    wait_for_poll(&f, &mut child, 1);
    // This is an unsupported native operation, but not the verified
    // locked-request diagnostic. It must not enter the retry path.
    f.edit(|s| {
        s["read_routes"]["projects/7/pipelines/71"] = json!({"__fixture_error":"unknown command"});
    });
    let started = Instant::now();
    while child.try_wait().unwrap().is_none() {
        assert!(
            started.elapsed() < Duration::from_secs(15),
            "an unrelated unsupported operation was retried: {}",
            child.diagnostic()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let state = watch_store::read(&child.identity).unwrap().unwrap();
    let last = state.events.last().unwrap();
    assert_eq!(last.state, EventState::Unknown);
    assert!(last.reason.contains("unsupported_operation"));
    assert!(state.lease.is_none());
}

#[test]
fn inconsistent_changed_poll_does_not_publish_unverified_native_facts() {
    let f = fixture("github");
    set_check_state(&f, "github", "pending");
    let mut child = polling(&f, "inconsistent-collect-verify");
    let first = wait_for_poll(&f, &mut child, 1);
    set_check_state(&f, "github", "passed");
    f.edit(|s| {
        let route = s["read_routes"]
            .as_object()
            .unwrap()
            .keys()
            .find(|r| r.contains("/check-runs?"))
            .unwrap()
            .clone();
        let mut replacement = s["read_routes"][&route].clone();
        replacement["check_runs"][0]["conclusion"] = json!("failure");
        s["after_read"] = json!({"endpoint":route,"replacement":replacement});
    });
    let second = wait_for_poll(&f, &mut child, 2);
    assert_eq!(
        second - first,
        first,
        "changed collection must reach verification"
    );
    let state = watch_store::read(&child.identity).unwrap().unwrap();
    assert!(
        !state
            .events
            .iter()
            .any(|e| matches!(e.state, EventState::ChecksPassed | EventState::Failed))
    );
    let last = state.events.last().unwrap();
    assert_eq!(last.state, EventState::Unknown);
    assert!(last.reason.contains("concurrent_edit"));
    assert!(last.next_step.as_ref().unwrap().request_state.is_none());
    // Recovery to the original fingerprint must verify again after an error.
    set_check_state(&f, "github", "pending");
    let third = wait_for_poll(&f, &mut child, 3);
    assert_eq!(
        third - second,
        first,
        "a failed poll must clear the verified fingerprint"
    );
    child.kill().unwrap();
    child.wait().unwrap();
}

#[test]
fn declaration_change_reconciles_the_live_subscription() {
    for change in ["valid", "invalid", "missing"] {
        let f = fixture("github");
        let mut child = polling(&f, "declaration-change");
        wait_for_poll(&f, &mut child, 1);
        let path = f.root.join(".specgit.yaml");
        let mut declaration = std::fs::read_to_string(&path).unwrap();
        match change {
            "valid" => {
                declaration.push_str("\nagent:\n  close_issues_after_merge: true\n");
                std::fs::write(&path, declaration).unwrap();
            }
            "invalid" => std::fs::write(&path, "version: invalid\n").unwrap(),
            "missing" => std::fs::remove_file(&path).unwrap(),
            _ => unreachable!(),
        }
        finish_watcher(&mut child);
        let state = watch_store::read(&child.identity).unwrap().unwrap();
        assert_eq!(
            state.events.last().unwrap().state,
            EventState::IdentityChanged
        );
        assert!(state.lease.is_none());
        assert_eq!(
            request_reads(&f),
            if change == "valid" { 4 } else { 2 },
            "changed declaration must not reuse native verification"
        );
    }
}

#[test]
fn one_shot_watch_inbox_and_status_always_fully_verify() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider);
        for args in [
            watch("lifecycle").to_vec(),
            inbox_for("lifecycle").to_vec(),
            vec!["pr", "--status", "--request", "41"],
        ] {
            for _ in 0..2 {
                f.edit(|s| s["calls"] = json!([]));
                let result = f.run(&args);
                assert_eq!(result["exit"], 0, "{result}");
                assert_eq!(request_reads(&f), 2);
                assert_eq!(
                    f.state()["calls"].as_array().unwrap().len(),
                    if provider == "github" { 14 } else { 10 }
                );
            }
        }
    }
}

fn set_draft(f: &delivery::Fixture) {
    f.edit(|state| state["requests"][0]["draft"] = json!(true));
}

fn set_check_state(f: &delivery::Fixture, provider: &str, state: &str) {
    f.edit(|fixture| {
        for (route, response) in fixture["read_routes"].as_object_mut().unwrap() {
            if route.contains("/check-runs?") {
                response["check_runs"][0]["status"] = json!(match state {
                    "pending" => "in_progress",
                    "failed" => "completed",
                    _ => "completed",
                });
                response["check_runs"][0]["conclusion"] = match state {
                    "pending" => Value::Null,
                    "failed" => json!("failure"),
                    _ => json!("success"),
                };
            } else if route == "projects/7/pipelines/71" {
                response["status"] = json!(match state {
                    "pending" => "running",
                    "failed" => "failed",
                    _ => "success",
                });
            } else if provider == "gitlab" && route.contains("pipelines/71/jobs?") {
                response[0]["status"] = json!(match state {
                    "pending" => "running",
                    "failed" => "failed",
                    _ => "success",
                });
            }
        }
    });
}

fn set_auto_merge(f: &delivery::Fixture, provider: &str, state: &str) {
    f.edit(|fixture| {
        let request = fixture["requests"][0].as_object_mut().unwrap();
        match (provider, state) {
            ("github", "registered") => {
                request.insert(
                    "auto_merge".into(),
                    json!({"merge_method":"squash","enabled_by":{"id":99}}),
                );
            }
            ("github", "not_registered") => {
                request.insert("auto_merge".into(), Value::Null);
            }
            ("github", "unknown") => {
                request.remove("auto_merge");
            }
            ("gitlab", "registered") => {
                request.insert("merge_when_pipeline_succeeds".into(), json!(true));
            }
            ("gitlab", "not_registered") => {
                request.insert("merge_when_pipeline_succeeds".into(), json!(false));
            }
            ("gitlab", "unknown") => {
                request.remove("merge_when_pipeline_succeeds");
            }
            _ => panic!("unsupported fixture provider/state: {provider}/{state}"),
        }
    });
}
#[test]
fn both_native_forges_offer_stable_event_ids_without_remote_writes() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider);
        let writes = f.writes();
        let first = f.run(&watch("checks"));
        assert_eq!(first["status"], "checks_passed", "{first}");
        assert_eq!(first["exit"], 0);
        let id = &first["evidence"]["events"][0]["id"];
        assert!(id.is_string());
        assert_eq!(f.run(&watch("checks"))["evidence"]["events"][0]["id"], *id);
        assert_eq!(f.run(&inbox())["evidence"]["events"][0]["id"], *id);
        let calls = f.state()["calls"].as_array().unwrap().len();
        let mut args = inbox().to_vec();
        args.push("--no-refresh");
        let offline = f.run(&args);
        assert_eq!(offline["status"], "unverified");
        assert!(offline["evidence"].get("events").is_none());
        assert_eq!(f.state()["calls"].as_array().unwrap().len(), calls);
        assert_eq!(f.writes(), writes);
    }
}

#[test]
fn legacy_watch_events_without_typed_actions_remain_readable() {
    let f = fixture("github");
    let result = f.run(&watch("checks"));
    let mut legacy_event = result["evidence"]["events"][0].clone();
    legacy_event.as_object_mut().unwrap().remove("next_step");
    let event: watch_store::Event = serde_json::from_value(legacy_event).unwrap();
    assert!(event.next_step.is_none());
}

#[test]
fn watch_action_kinds_match_the_report_schema() {
    let schema: Value =
        serde_json::from_str(include_str!("../schemas/report.schema.json")).unwrap();
    let schema_kinds = schema["$defs"]["watch_action_kind"]["enum"]
        .as_array()
        .unwrap();
    let action_kinds = [
        ActionKind::WaitForChecks,
        ActionKind::InspectChecks,
        ActionKind::RepairChecks,
        ActionKind::InterpretChecks,
        ActionKind::PrepareReview,
        ActionKind::ReviewOrMergeOnPlatform,
        ActionKind::InspectOpenIssues,
        ActionKind::VerifyIssueClosure,
        ActionKind::ReopenOrChooseFollowup,
        ActionKind::RefreshNativeEvidence,
        ActionKind::ReconcileSubscription,
        ActionKind::ResumeSubscription,
        ActionKind::Completed,
    ];
    assert_eq!(schema_kinds.len(), action_kinds.len());
    for action_kind in action_kinds {
        let serialized = serde_json::to_value(action_kind).unwrap();
        assert!(schema_kinds.contains(&serialized), "{serialized}");
    }
    assert_eq!(
        schema["properties"]["next_actions"]["items"]["oneOf"][0]["$ref"],
        "#/$defs/next_action"
    );
}

#[test]
fn watch_uses_project_observation_defaults_when_cli_values_are_omitted() {
    use std::time::{Duration, Instant};

    let f = acceptance::fixture_with_observation(
        "github",
        "observation:\n  poll_seconds: 1\n  max_wait_seconds: 4\n  notify: []\n",
    );
    let initial = f.run(&watch("lifecycle"));
    let identity: Identity =
        serde_json::from_value(initial["evidence"]["subscription"].clone()).unwrap();
    let before = request_reads(&f);
    let mut child = WatchProcess::spawn(
        f.native_command(&[
            "watch",
            "--request",
            "41",
            "--session",
            "session-a",
            "--goal",
            "lifecycle",
        ]),
        &identity,
        "project-observation-defaults",
    );
    let started = Instant::now();
    let deadline = started + Duration::from_secs(7);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break Some(status);
        }
        if Instant::now() >= deadline {
            break None;
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    assert!(
        status.is_some(),
        "project max_wait_seconds was not applied: {}",
        child.diagnostic()
    );
    assert_eq!(status.unwrap().code(), Some(3), "{}", child.diagnostic());
    assert!(started.elapsed() < Duration::from_secs(6));
    assert!(
        request_reads(&f) >= before + 2,
        "poll_seconds was not applied"
    );
    assert_eq!(
        watch_store::read(&identity)
            .unwrap()
            .unwrap()
            .events
            .last()
            .unwrap()
            .state,
        EventState::TimedOut
    );
}

#[test]
fn explicit_watch_values_override_project_observation_defaults() {
    use std::time::{Duration, Instant};

    let f = acceptance::fixture_with_observation(
        "github",
        "observation:\n  poll_seconds: 5\n  max_wait_seconds: 20\n  notify: []\n",
    );
    let initial = f.run(&watch("lifecycle"));
    let identity: Identity =
        serde_json::from_value(initial["evidence"]["subscription"].clone()).unwrap();
    let writes = f.writes();
    let mut child = WatchProcess::spawn(
        f.native_command(&[
            "watch",
            "--request",
            "41",
            "--session",
            "session-a",
            "--goal",
            "lifecycle",
            "--timeout-seconds",
            "2",
            "--poll-seconds",
            "1",
        ]),
        &identity,
        "explicit-observation-overrides",
    );
    let started = Instant::now();
    let deadline = started + Duration::from_secs(5);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break Some(status);
        }
        if Instant::now() >= deadline {
            break None;
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    assert!(
        status.is_some(),
        "explicit timeout_seconds was not applied: {}",
        child.diagnostic()
    );
    assert_eq!(status.unwrap().code(), Some(3), "{}", child.diagnostic());
    assert!(started.elapsed() < Duration::from_secs(4));
    assert_eq!(f.writes(), writes);
    assert_eq!(
        watch_store::read(&identity)
            .unwrap()
            .unwrap()
            .events
            .last()
            .unwrap()
            .state,
        EventState::TimedOut
    );
}

#[test]
fn watch_preserves_documented_cli_upper_bounds_and_rejects_inconsistent_timing() {
    let f = fixture("github");
    let mut accepted = watch("checks").to_vec();
    accepted.extend(["--timeout-seconds", "86400", "--poll-seconds", "3600"]);
    let result = f.run(&accepted);
    assert_eq!(result["exit"], 0, "{result}");

    let mut inconsistent = f.command(&[
        "watch",
        "--request",
        "41",
        "--session",
        "session-a",
        "--goal",
        "lifecycle",
        "--timeout-seconds",
        "1",
        "--poll-seconds",
        "2",
    ]);
    assert_eq!(
        inconsistent.output().unwrap().status.code(),
        Some(2),
        "timeout must cover at least one poll interval"
    );
}

#[test]
fn configured_notification_filters_do_not_filter_direct_watch_evidence() {
    // Content assertions must allow the sequential native reads on Windows.
    let f = acceptance::fixture_with_observation(
        "github",
        "observation:\n  poll_seconds: 1\n  max_wait_seconds: 30\n  notify: []\n",
    );
    f.edit(|s| {
        s["requests"][0]["state"] = json!("closed");
        s["requests"][0]["merged"] = json!(true);
        s["issues"][0]["state"] = json!("closed");
    });

    let offered = hook_output(&f, "PostToolUse", true);
    assert!(offered["hookSpecificOutput"]["additionalContext"].is_null());
    let resumed = hook_output(&f, "SessionStart", false);
    let resumed_context = resumed["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap();
    assert!(!resumed_context.contains("unverified event receipts"));

    let direct = f.run(&watch("lifecycle"));
    assert_eq!(direct["status"], "completed", "{direct}");
    assert_eq!(direct["evidence"]["events"][0]["state"], "completed");
    let direct_inbox = f.run(&[
        "inbox",
        "--request",
        "41",
        "--session",
        "session-a",
        "--goal",
        "lifecycle",
    ]);
    assert_eq!(direct_inbox["status"], "completed", "{direct_inbox}");
    assert_eq!(direct_inbox["evidence"]["events"][0]["state"], "completed");
}

#[test]
fn draft_check_states_produce_specific_authorized_next_steps_for_both_forges() {
    for provider in ["github", "gitlab"] {
        for check_state in ["pending", "passed", "failed"] {
            let f = fixture(provider);
            set_draft(&f);
            set_check_state(&f, provider, check_state);
            let writes = f.writes();
            let result = f.run(&watch("lifecycle"));
            let event = &result["evidence"]["events"][0];
            let next_step = &event["next_step"];
            assert_eq!(event["next_action"], next_step["message"], "{result}");
            assert_eq!(result["next_actions"][0], *next_step, "{result}");
            assert_eq!(next_step["goal"], "lifecycle", "{result}");
            assert_eq!(next_step["draft"], true, "{result}");
            match check_state {
                "pending" => {
                    assert_eq!(result["status"], "pending", "{provider}: {result}");
                    assert_eq!(next_step["kind"], "wait_for_checks", "{result}");
                    assert_eq!(next_step["requires_user_authorization"], true, "{result}");
                    assert!(next_step["message"].as_str().unwrap().contains("checks"));
                    assert!(next_step["message"].as_str().unwrap().contains("draft"));
                    assert!(
                        next_step["message"]
                            .as_str()
                            .unwrap()
                            .contains("while CI runs")
                    );
                    assert!(
                        next_step["message"]
                            .as_str()
                            .unwrap()
                            .contains("existing task authorization")
                    );
                }
                "passed" => {
                    assert_eq!(result["status"], "checks_passed", "{provider}: {result}");
                    assert_eq!(next_step["kind"], "prepare_review", "{result}");
                    assert_eq!(
                        next_step["command"], "specgit pr --ready --request 41 --json",
                        "{result}"
                    );
                    assert_eq!(next_step["requires_user_authorization"], true, "{result}");
                    assert!(
                        next_step["message"]
                            .as_str()
                            .unwrap()
                            .contains("seek permission only for missing scope")
                    );
                    assert!(
                        next_step["message"]
                            .as_str()
                            .unwrap()
                            .contains("does not approve or merge")
                    );
                }
                "failed" => {
                    assert_eq!(result["status"], "failed", "{provider}: {result}");
                    assert_eq!(next_step["kind"], "repair_checks", "{result}");
                    assert_eq!(
                        next_step["failed_checks"][0],
                        if provider == "github" {
                            "Test"
                        } else {
                            "pipeline"
                        },
                        "{result}"
                    );
                    assert!(next_step["message"].as_str().unwrap().contains("failed"));
                }
                _ => unreachable!(),
            }
            assert_eq!(f.writes(), writes, "{provider}/{check_state}");
        }
    }
}

#[test]
fn ready_request_with_pending_checks_keeps_wait_action_read_only() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider);
        set_check_state(&f, provider, "pending");
        let writes = f.writes();
        let result = f.run(&watch("lifecycle"));
        let action = &result["next_actions"][0];
        assert_eq!(result["status"], "pending", "{provider}: {result}");
        assert_eq!(action["kind"], "wait_for_checks", "{result}");
        assert_eq!(action["draft"], false, "{result}");
        assert_eq!(action["requires_user_authorization"], false, "{result}");
        assert!(
            action["message"]
                .as_str()
                .unwrap()
                .contains("no review state is changed")
        );
        assert_eq!(f.writes(), writes, "{provider}");
    }
}

#[test]
fn absent_ci_keeps_checks_unobserved_and_lifecycle_guidance_actionable() {
    for provider in ["github", "gitlab"] {
        for draft in [true, false] {
            let f = fixture(provider);
            f.edit(|state| {
                state["requests"][0]["draft"] = json!(draft);
                state["requests"][0]["head_pipeline"] = Value::Null;
                state["requests"][0]["pipeline"] = Value::Null;
                state["project"]["only_allow_merge_if_pipeline_succeeds"] = json!(false);
                for (route, response) in state["read_routes"].as_object_mut().unwrap() {
                    if route.contains("/check-runs?") {
                        *response = json!({"total_count":0,"check_runs":[]});
                    } else if route.contains("/actions/runs?") {
                        *response = json!({"total_count":0,"workflow_runs":[]});
                    }
                }
            });
            let writes = f.writes();
            for goal in ["checks", "lifecycle"] {
                let result = f.run(&watch(goal));
                let action = &result["next_actions"][0];
                assert_eq!(
                    result["status"], "pending",
                    "{provider}/{draft}/{goal}: {result}"
                );
                assert_eq!(action["check_outcome"], "unobserved", "{result}");
                assert_eq!(action["kind"], "inspect_checks", "{result}");
                assert_eq!(action["draft"], draft, "{result}");
                assert_eq!(
                    action["requires_user_authorization"],
                    goal == "lifecycle",
                    "{result}"
                );
                let message = action["message"].as_str().unwrap();
                if goal == "checks" {
                    assert!(
                        message.contains("explicit checks goal remains open"),
                        "{result}"
                    );
                    assert!(
                        message.contains("absence is not a passing result"),
                        "{result}"
                    );
                } else {
                    assert!(
                        message.contains("absent optional CI alone does not prevent"),
                        "{result}"
                    );
                    assert!(message.contains("existing task authorization"), "{result}");
                    assert!(message.contains("actual platform requirements"), "{result}");
                }
            }
            assert_eq!(f.writes(), writes, "{provider}/{draft}");
        }
    }
}

#[test]
fn advisory_checks_do_not_infer_native_merge_eligibility() {
    let f = fixture("github");
    f.edit(|state| {
        for (route, response) in state["read_routes"].as_object_mut().unwrap() {
            if route.contains("/check-runs?") {
                response["check_runs"][0]["conclusion"] = json!("neutral");
            }
        }
    });
    let writes = f.writes();
    let result = f.run(&watch("lifecycle"));
    assert_eq!(result["status"], "checks_completed", "{result}");
    assert_eq!(
        result["next_actions"][0]["kind"], "interpret_checks",
        "{result}"
    );
    assert!(
        result["next_actions"][0]["message"]
            .as_str()
            .unwrap()
            .contains("no merge eligibility")
    );
    assert_eq!(f.writes(), writes);
}

#[test]
fn ready_requests_name_auto_merge_fact_without_inferring_review_or_merge() {
    for provider in ["github", "gitlab"] {
        for auto_merge in ["registered", "not_registered", "unknown"] {
            let f = fixture(provider);
            set_auto_merge(&f, provider, auto_merge);
            let writes = f.writes();
            let result = f.run(&watch("checks"));
            let next_step = &result["next_actions"][0];
            assert_eq!(result["evidence"]["events"][0]["next_step"], *next_step);
            assert_eq!(next_step["kind"], "review_or_merge_on_platform", "{result}");
            assert_eq!(next_step["goal"], "checks", "{result}");
            assert_eq!(next_step["draft"], false, "{result}");
            assert_eq!(next_step["auto_merge"], auto_merge, "{result}");
            let message = next_step["message"].as_str().unwrap();
            assert!(message.contains("review"), "{result}");
            assert!(message.contains("approval"), "{result}");
            assert!(message.contains("not inferred"), "{result}");
            assert!(
                message.contains(match auto_merge {
                    "registered" => "registered",
                    "not_registered" => "not registered",
                    _ => "unknown",
                }),
                "{result}"
            );
            assert_eq!(f.writes(), writes, "{provider}/{auto_merge}");
        }
    }
}

#[test]
fn checks_and_lifecycle_goals_keep_their_next_steps_distinct() {
    let f = fixture("github");
    let checks = f.run(&watch("checks"));
    let lifecycle = f.run(&watch("lifecycle"));
    let checks_action = &checks["next_actions"][0];
    let lifecycle_action = &lifecycle["next_actions"][0];
    assert_eq!(checks_action["goal"], "checks", "{checks}");
    assert_eq!(lifecycle_action["goal"], "lifecycle", "{lifecycle}");
    assert!(
        checks_action["message"]
            .as_str()
            .unwrap()
            .contains("checks goal")
    );
    assert!(
        lifecycle_action["message"]
            .as_str()
            .unwrap()
            .contains("lifecycle")
    );
    assert!(
        checks_action["message"]
            .as_str()
            .unwrap()
            .contains("not delivery completion")
    );
}

#[test]
fn merged_open_issues_keep_structured_actions_in_explicit_tools_and_hooks_offer_receipt_ids() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider);
        f.edit(|state| {
            state["requests"][0]["state"] = json!(if provider == "github" {
                "closed"
            } else {
                "merged"
            });
            state["requests"][0]["merged"] = json!(true);
            state["issues"][0]["state"] = json!("open");
        });
        let writes = f.writes();
        let direct = f.run(&watch("lifecycle"));
        assert_eq!(
            direct["status"], "merged_issues_open",
            "{provider}: {direct}"
        );
        let event = &direct["evidence"]["events"][0];
        let next_step = &event["next_step"];
        assert_eq!(next_step["kind"], "inspect_open_issues", "{direct}");
        assert_eq!(next_step["issue_ids"], json!([1]), "{direct}");
        assert_eq!(event["next_action"], next_step["message"], "{direct}");
        assert_eq!(direct["next_actions"][0], *next_step, "{direct}");
        assert!(next_step["message"].as_str().unwrap().contains("#1"));
        assert_eq!(
            next_step["command"],
            "specgit pr --status --request 41 --json"
        );

        let inbox_report = f.run(&inbox_for("lifecycle"));
        assert_eq!(
            inbox_report["next_actions"][0], *next_step,
            "{inbox_report}"
        );
        let calls = f.state()["calls"].as_array().unwrap().len();
        assert!(hook_output(&f, "PostToolUse", true).is_null());
        assert_eq!(f.state()["calls"].as_array().unwrap().len(), calls);
        let recovered = hook_output(&f, "SessionStart", false);
        let text = recovered["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap();
        assert!(text.contains(event["id"].as_str().unwrap()), "{recovered}");
        assert!(text.contains("unverified event receipts"));
        assert!(!text.contains(next_step["message"].as_str().unwrap()));
        assert_eq!(f.writes(), writes, "{provider}");
    }
}

#[test]
fn merged_without_verified_issue_set_stays_unknown_and_closed_unmerged_has_an_explicit_choice() {
    for provider in ["github", "gitlab"] {
        let merged = fixture(provider);
        merged.edit(|state| {
            state["requests"][0]["state"] = json!(if provider == "github" {
                "closed"
            } else {
                "merged"
            });
            state["requests"][0]["merged"] = json!(true);
            state["native_closing_failure"] = json!("forbidden");
            state["issues"][0]["state"] = json!("closed");
        });
        let writes = merged.writes();
        let result = merged.run(&watch("lifecycle"));
        assert_eq!(result["status"], "unknown", "{provider}: {result}");
        let next_step = &result["next_actions"][0];
        assert_eq!(next_step["kind"], "verify_issue_closure", "{result}");
        assert!(
            next_step["message"]
                .as_str()
                .unwrap()
                .contains("does not confirm")
        );
        assert_eq!(next_step["issue_ids"], json!([1]), "{result}");
        assert_eq!(merged.writes(), writes, "{provider}");

        let closed = fixture(provider);
        closed.edit(|state| {
            state["requests"][0]["state"] = json!("closed");
            state["requests"][0]["merged"] = json!(false);
        });
        let writes = closed.writes();
        let result = closed.run(&watch("lifecycle"));
        assert_eq!(result["status"], "closed_unmerged", "{provider}: {result}");
        assert_eq!(
            result["next_actions"][0]["kind"], "reopen_or_choose_followup",
            "{result}"
        );
        assert!(
            result["next_actions"][0]["message"]
                .as_str()
                .unwrap()
                .contains("not delivery completion")
        );
        assert_eq!(closed.writes(), writes, "{provider}");
    }
}

#[test]
fn settled_lifecycle_facts_survive_local_commits_without_push_guidance() {
    for provider in ["github", "gitlab"] {
        let merged = fixture(provider);
        merged.edit(|state| {
            state["requests"][0]["state"] = json!(if provider == "github" {
                "closed"
            } else {
                "merged"
            });
            state["requests"][0]["merged"] = json!(true);
            state["issues"][0]["state"] = json!("open");
        });
        let local = local_commit(&merged);
        let result = merged.run(&watch("lifecycle"));
        assert_eq!(
            result["status"], "merged_issues_open",
            "{provider}: {result}"
        );
        let next_step = &result["next_actions"][0];
        assert_eq!(next_step["kind"], "inspect_open_issues", "{result}");
        assert_eq!(next_step["issue_ids"], json!([1]), "{result}");
        assert!(
            !next_step["message"]
                .as_str()
                .unwrap()
                .contains("new branch"),
            "{result}"
        );
        let reason = result["evidence"]["events"][0]["reason"].as_str().unwrap();
        assert!(
            reason.contains("new branch") && reason.contains("select new Issues"),
            "{result}"
        );
        assert_eq!(
            result["evidence"]["events"][0]["revision"]["local_head"], local,
            "{result}"
        );
        assert!(
            !result.to_string().contains("Push reviewed commits"),
            "{provider}: {result}"
        );
        let inbox = merged.run(&inbox_for("lifecycle"));
        assert_eq!(inbox["status"], "merged_issues_open", "{provider}: {inbox}");
        assert_eq!(inbox["next_actions"][0], *next_step, "{inbox}");

        let closed = fixture(provider);
        closed.edit(|state| {
            state["requests"][0]["state"] = json!("closed");
            state["requests"][0]["merged"] = json!(false);
        });
        let local = local_commit(&closed);
        let result = closed.run(&watch("lifecycle"));
        assert_eq!(result["status"], "closed_unmerged", "{provider}: {result}");
        let next_step = &result["next_actions"][0];
        assert_eq!(next_step["kind"], "reopen_or_choose_followup", "{result}");
        assert!(
            next_step["message"]
                .as_str()
                .unwrap()
                .contains("not delivery completion"),
            "{result}"
        );
        assert!(
            !next_step["message"]
                .as_str()
                .unwrap()
                .contains("new branch"),
            "{result}"
        );
        let reason = result["evidence"]["events"][0]["reason"].as_str().unwrap();
        assert!(
            reason.contains("push cannot reopen") && reason.contains("new branch"),
            "{result}"
        );
        assert_eq!(
            result["evidence"]["events"][0]["revision"]["local_head"], local,
            "{result}"
        );
        assert!(
            !result.to_string().contains("Push reviewed commits"),
            "{provider}: {result}"
        );
        let inbox = closed.run(&inbox_for("lifecycle"));
        assert_eq!(inbox["status"], "closed_unmerged", "{provider}: {inbox}");
        assert_eq!(inbox["next_actions"][0], *next_step, "{inbox}");

        let unknown = fixture(provider);
        unknown.edit(|state| {
            state["requests"][0]["state"] = json!(if provider == "github" {
                "closed"
            } else {
                "merged"
            });
            state["requests"][0]["merged"] = json!(true);
            state["native_closing_failure"] = json!("forbidden");
            state["issues"][0]["state"] = json!("closed");
        });
        let local = local_commit(&unknown);
        let result = unknown.run(&watch("lifecycle"));
        assert_eq!(result["status"], "unknown", "{provider}: {result}");
        let next_step = &result["next_actions"][0];
        assert_eq!(next_step["kind"], "verify_issue_closure", "{result}");
        assert_eq!(next_step["issue_ids"], json!([1]), "{result}");
        assert!(
            next_step["message"]
                .as_str()
                .unwrap()
                .contains("does not confirm"),
            "{result}"
        );
        assert!(
            !next_step["message"]
                .as_str()
                .unwrap()
                .contains("new branch"),
            "{result}"
        );
        let reason = result["evidence"]["events"][0]["reason"].as_str().unwrap();
        assert!(
            reason.contains("Verify") && reason.contains("new branch"),
            "{result}"
        );
        assert_eq!(
            result["evidence"]["events"][0]["revision"]["local_head"], local,
            "{result}"
        );
        assert!(
            !result.to_string().contains("Push reviewed commits"),
            "{provider}: {result}"
        );
        let inbox = unknown.run(&inbox_for("lifecycle"));
        assert_eq!(inbox["status"], "unknown", "{provider}: {inbox}");
        assert_eq!(inbox["next_actions"][0], *next_step, "{inbox}");
    }
}

#[test]
fn merged_open_issue_action_stays_bounded_when_local_commits_diverge() {
    let f = fixture("github");
    let ids: Vec<u64> = std::iter::once(1).chain(10_001..=10_099).collect();
    f.edit(|state| {
        state["native_closing"] = json!(&ids[1..]);
        state["issues"] = json!(
            ids.iter()
                .map(|id| json!({
                    "id": id,
                    "number": id,
                    "title": format!("Issue {id}"),
                    "body": "",
                    "labels": [],
                    "state": "open",
                    "updated_at": "2026-09-09T00:00:00Z",
                }))
                .collect::<Vec<_>>()
        );
        state["requests"][0]["body"] = json!("Scoped native observation.");
        state["requests"][0]["state"] = json!("closed");
        state["requests"][0]["merged"] = json!(true);
    });
    let local = local_commit(&f);
    let result = f.run(&watch("lifecycle"));
    assert_eq!(result["status"], "merged_issues_open", "{result}");
    let event = &result["evidence"]["events"][0];
    let next_step = &event["next_step"];
    assert_eq!(next_step["kind"], "inspect_open_issues", "{result}");
    assert_eq!(next_step["issue_ids"], json!(&ids), "{result}");
    let message = next_step["message"].as_str().unwrap();
    // This unresolved action is 984 bytes: valid alone, but over 1024 once the
    // old local-divergence append was added.
    assert_eq!(message.len(), 984, "{result}");
    assert!(!message.contains("new branch"), "{result}");
    let reason = event["reason"].as_str().unwrap();
    assert!(reason.contains("new branch"), "{result}");
    assert!(reason.contains("select new Issues"), "{result}");
    assert_eq!(event["revision"]["local_head"], local, "{result}");
    assert_eq!(result["next_actions"][0], *next_step, "{result}");
    let inbox = f.run(&inbox_for("lifecycle"));
    assert_eq!(inbox["status"], "merged_issues_open", "{inbox}");
    assert_eq!(inbox["next_actions"][0], *next_step, "{inbox}");
}

#[test]
fn enabled_agent_closure_preference_does_not_authorize_or_execute_issue_closure() {
    for provider in ["github", "gitlab"] {
        let f = acceptance::fixture_with_observation(
            provider,
            "agent:\n  close_issues_after_merge: true\n",
        );
        f.edit(|state| {
            state["requests"][0]["state"] = json!(if provider == "github" {
                "closed"
            } else {
                "merged"
            });
            state["requests"][0]["merged"] = json!(true);
            state["issues"][0]["state"] = json!("open");
        });
        let writes = f.writes();
        let result = f.run(&watch("lifecycle"));
        let next_step = &result["next_actions"][0];
        assert_eq!(next_step["kind"], "inspect_open_issues", "{result}");
        assert!(next_step["close_issues_after_merge"].as_bool().unwrap());
        assert!(
            next_step["message"]
                .as_str()
                .unwrap()
                .contains("does not grant authorization")
        );
        assert!(!next_step["requires_user_authorization"].as_bool().unwrap());
        assert_eq!(
            next_step["command"],
            "specgit pr --status --request 41 --json"
        );
        assert_eq!(f.writes(), writes, "{provider}");
    }
}

#[test]
fn attention_only_notifications_deliver_failed_native_observations() {
    let f = acceptance::fixture_with_observation(
        "github",
        "observation:\n  poll_seconds: 1\n  max_wait_seconds: 5\n  notify: [attention]\n",
    );
    f.edit(|s| s["read_failure"] = json!("auth"));

    let watched = f.run(&watch("lifecycle"));
    assert_eq!(watched["status"], "unknown", "{watched}");
    assert!(hook_output(&f, "PostToolUse", true).is_null());
    let offered = hook_output(&f, "SessionStart", false);
    assert!(
        offered.to_string().contains("unverified event receipts"),
        "{offered}"
    );
}

#[test]
fn completed_only_notifications_suppress_attention_events() {
    let f = acceptance::fixture_with_observation(
        "github",
        "observation:\n  poll_seconds: 1\n  max_wait_seconds: 5\n  notify: [completed]\n",
    );
    f.edit(|s| s["read_failure"] = json!("auth"));

    let watched = f.run(&watch("lifecycle"));
    assert_eq!(watched["status"], "unknown", "{watched}");
    assert!(hook_output(&f, "PostToolUse", true).is_null());
    let offered = hook_output(&f, "SessionStart", false);
    let text = offered.to_string();
    assert!(!text.contains("unknown"), "{offered}");
    assert!(!text.contains("unverified event receipts"), "{offered}");
}

#[test]
fn malformed_body_references_keep_watch_and_inbox_diagnostics() {
    let f = fixture("github");
    f.edit(|s| {
        s["native_closing"] = json!([1]);
        s["requests"][0]["state"] = json!("closed");
        s["requests"][0]["merged"] = json!(true);
        s["requests"][0]["body"] = json!("- Closes #1");
        s["issues"][0]["state"] = json!("closed");
    });

    let observed = f.run(&watch("lifecycle"));
    assert_eq!(observed["status"], "unknown", "{observed}");
    let event = &observed["evidence"]["events"][0];
    assert!(event["reason"].as_str().unwrap().contains("invalid_input"));

    let refreshed = f.run(&[
        "inbox",
        "--request",
        "41",
        "--session",
        "session-a",
        "--goal",
        "lifecycle",
    ]);
    assert_eq!(refreshed["status"], "unknown", "{refreshed}");
    assert_eq!(refreshed["evidence"]["events"][0]["id"], event["id"]);
    assert!(
        refreshed["evidence"]["events"][0]["reason"]
            .as_str()
            .unwrap()
            .contains("invalid_input")
    );
}
#[test]
fn session_receipts_do_not_steal_events_and_ack_is_not_human_reading() {
    let f = fixture("github");
    let first = f.run(&watch("checks"));
    let id = first["evidence"]["events"][0]["id"].as_str().unwrap();
    let mut other = watch("checks");
    other[4] = "session-b";
    let second = f.run(&other);
    assert_ne!(
        first["evidence"]["events"][0]["id"],
        second["evidence"]["events"][0]["id"]
    );
    let mut args = inbox().to_vec();
    args[4] = "session-b";
    args.extend(["--ack", id]);
    assert_eq!(f.run(&args)["exit"], 2);
    args[4] = "session-a";
    let ack = f.run(&args);
    assert_eq!(ack["status"], "acknowledged");
    assert_eq!(ack["evidence"]["human_read"], false);
    assert!(
        f.run(&inbox())["evidence"]["events"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
#[test]
fn refreshed_inbox_supersedes_cached_success_after_a_new_native_head() {
    let f = fixture("github");
    let first = f.run(&watch("checks"));
    f.edit(|s| s["requests"][0]["head"]["sha"] = json!("f".repeat(40)));
    let current = f.run(&inbox());
    assert_eq!(current["status"], "identity_changed", "{current}");
    assert_eq!(current["evidence"]["events"].as_array().unwrap().len(), 1);
    assert_ne!(
        current["evidence"]["events"][0]["id"],
        first["evidence"]["events"][0]["id"]
    );
    assert_eq!(
        current["evidence"]["events"][0]["state"],
        "identity_changed"
    );
}
#[test]
fn native_rerun_and_auth_recovery_are_material_events_not_replayed_success() {
    let f = fixture("github");
    let first = f.run(&watch("checks"));
    f.edit(|s| s["read_failure"] = json!("auth"));
    let unknown = f.run(&inbox());
    assert_eq!(unknown["status"], "unknown", "{unknown}");
    f.edit(|s| {
        s["read_failure"] = Value::Null;
        for (route, value) in s["read_routes"].as_object_mut().unwrap() {
            if route.contains("/check-runs?") {
                value["check_runs"][0]["id"] = json!(82);
                value["check_runs"][0]["status"] = json!("in_progress");
                value["check_runs"][0]["conclusion"] = Value::Null;
            }
        }
    });
    let pending = f.run(&inbox());
    assert_eq!(pending["status"], "pending", "{pending}");
    assert_ne!(
        pending["evidence"]["events"][0]["id"],
        first["evidence"]["events"][0]["id"]
    );
}
#[test]
fn lifecycle_timeout_preserves_resumable_intent_and_never_closes_issues() {
    let f = fixture("gitlab");
    let writes = f.writes();
    let r = f.run(&[
        "watch",
        "--request",
        "41",
        "--session",
        "session-a",
        "--goal",
        "lifecycle",
        "--timeout-seconds",
        "1",
        "--poll-seconds",
        "1",
    ]);
    assert_eq!(r["status"], "timed_out", "{r}");
    assert_eq!(r["exit"], 3);
    let identity: Identity = serde_json::from_value(r["evidence"]["subscription"].clone()).unwrap();
    assert!(
        watch_store::read(&identity)
            .unwrap()
            .unwrap()
            .lease
            .is_none()
    );
    f.edit(|s| {
        s["requests"][0]["state"] = json!("merged");
        s["issues"][0]["state"] = json!("closed");
    });
    assert_eq!(f.run(&watch("lifecycle"))["status"], "completed");
    assert_eq!(f.writes(), writes);
}
#[test]
fn retention_expiry_and_full_outbox_preserve_explicit_receipt_semantics() {
    let f = fixture("github");
    let initial = f.run(&watch("checks"));
    let identity: Identity =
        serde_json::from_value(initial["evidence"]["subscription"].clone()).unwrap();
    // A dedicated session keeps the synthetic retention ledger isolated from the
    // live watch run while still using the identity's real Git-dir state path.
    let identity = Identity {
        session: "retention-fixture".into(),
        ..identity.clone()
    };
    // Observer state lives only under this identity's Git dir; no override root exists.
    let store = Store::new(identity.clone()).unwrap();
    let revision = Revision {
        head: "a".repeat(40),
        local_head: "a".repeat(40),
        target: "main".into(),
        declaration: "b".repeat(64),
        evidence_digest: "c".repeat(64),
    };
    let first = store
        .publish(
            revision.clone(),
            EventState::ChecksPassed,
            "passed".into(),
            "review".into(),
            10,
        )
        .unwrap();
    let next = store
        .publish(
            revision.clone(),
            EventState::Unknown,
            "offline".into(),
            "resume".into(),
            10 + watch_store::RETENTION,
        )
        .unwrap();
    assert_eq!(next.expired_unacknowledged, 1);
    assert_ne!(first.events[0].id, next.events[0].id);
    for i in 1..64 {
        store
            .publish(
                revision.clone(),
                EventState::Pending,
                format!("transition-{i}"),
                "resume".into(),
                10 + watch_store::RETENTION + i,
            )
            .unwrap();
    }
    assert!(
        store
            .publish(
                revision,
                EventState::Pending,
                "overflow".into(),
                "resume".into(),
                100 + watch_store::RETENTION
            )
            .is_err()
    );
    let state_path = identity
        .git_dir
        .join("specgit-v2/subscriptions")
        .join(identity.key())
        .join("state.json");
    assert!(state_path.exists());
    assert_eq!(
        watch_store::read(&identity).unwrap().unwrap().events.len(),
        64
    );
}
#[cfg(unix)]
#[test]
fn process_death_releases_lease_and_resume_rereads_before_delivery() {
    use std::{
        process::Stdio,
        time::{Duration, Instant},
    };
    let f = fixture("github");
    let initial = f.run(&watch("lifecycle"));
    let identity: Identity =
        serde_json::from_value(initial["evidence"]["subscription"].clone()).unwrap();
    let mut child = f
        .native_command(&[
            "watch",
            "--request",
            "41",
            "--session",
            "session-a",
            "--goal",
            "lifecycle",
            "--poll-seconds",
            "15",
        ])
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let start = Instant::now();
    loop {
        if watch_store::read(&identity)
            .unwrap()
            .unwrap()
            .lease
            .is_some_and(|lease| lease.pid == child.id() && lease.polls_completed > 0)
        {
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(10));
    }
    let duplicate = f.run(&watch("lifecycle"));
    assert_eq!(duplicate["diagnostics"][0]["code"], "lock_busy");
    child.kill().unwrap();
    child.wait().unwrap();
    f.edit(|s| s["requests"][0]["head"]["sha"] = json!("f".repeat(40)));
    let resumed = f.run(&watch("lifecycle"));
    assert_eq!(resumed["status"], "identity_changed", "{resumed}");
}
#[cfg(unix)]
#[test]
fn cancellation_records_intent_and_reaps_the_owned_native_child() {
    use std::{
        process::Stdio,
        time::{Duration, Instant},
    };
    let f = fixture("github");
    f.edit(|s| s["read_failure"] = json!("hang"));
    let child = f
        .command(&[
            "watch",
            "--request",
            "41",
            "--session",
            "cancel-session",
            "--goal",
            "checks",
        ])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let start = Instant::now();
    let reader = loop {
        if let Some(pid) = f.state()["hanging_reader_pid"].as_u64() {
            break pid;
        }
        assert!(start.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(10));
    };
    // SAFETY: the PID belongs to the child spawned by this test.
    unsafe {
        libc::kill(child.id() as i32, libc::SIGINT);
    }
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(130));
    // SAFETY: signal zero probes this exact recorded owned child without mutation.
    assert_ne!(unsafe { libc::kill(reader as i32, 0) }, 0);
    let recovered = f.run(&[
        "inbox",
        "--request",
        "41",
        "--session",
        "cancel-session",
        "--goal",
        "checks",
        "--no-refresh",
    ]);
    assert!(
        !recovered["evidence"]["pending_event_ids"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn unicode_failure_reasons_remain_readable_and_invalid_writes_preserve_the_checkpoint() {
    let f = fixture("github");
    f.edit(|s| {
        for (route, value) in s["read_routes"].as_object_mut().unwrap() {
            if route.contains("/check-runs?") || route.contains("/actions/runs/71/jobs?") {
                let key = if route.contains("check-runs?") {
                    "check_runs"
                } else {
                    "jobs"
                };
                value[key][0]["name"] = json!("检查".repeat(40));
                value[key][0]["conclusion"] = json!("failure");
            }
        }
    });
    let first = f.run(&watch("checks"));
    assert_eq!(first["status"], "failed", "{first}");
    let event = &first["evidence"]["events"][0];
    assert!(event["reason"].as_str().unwrap().len() <= 4096);
    assert!(event["reason"].as_str().unwrap().contains("检查"));
    let identity: Identity =
        serde_json::from_value(first["evidence"]["subscription"].clone()).unwrap();
    let before = watch_store::read(&identity).unwrap().unwrap();
    assert!(before.lease.is_none());
    let store = Store::new(identity.clone()).unwrap();
    assert!(
        store
            .publish(
                before.events[0].revision.clone(),
                EventState::Failed,
                "中".repeat(4096),
                "repair".into(),
                watch_store::now()
            )
            .is_err()
    );
    assert_eq!(
        watch_store::read(&identity).unwrap().unwrap().sequence,
        before.sequence
    );
    assert_eq!(f.run(&inbox())["evidence"]["events"][0]["id"], event["id"]);
    let mut args = inbox().to_vec();
    args.extend(["--ack", event["id"].as_str().unwrap()]);
    assert_eq!(f.run(&args)["status"], "acknowledged");
}
#[test]
fn native_neutral_failure_and_running_results_remain_distinct() {
    for (provider, conclusion) in [
        ("github", "skipped"),
        ("github", "neutral"),
        ("github", "pending"),
        ("gitlab", "failed"),
        ("gitlab", "running"),
    ] {
        let f = fixture(provider);
        f.edit(|s| {
            for (route, value) in s["read_routes"].as_object_mut().unwrap() {
                if route.contains("/check-runs?") || route.contains("/actions/runs/71/jobs?") {
                    let key = if route.contains("check-runs?") {
                        "check_runs"
                    } else {
                        "jobs"
                    };
                    value[key][0]["status"] = json!(if conclusion == "pending" {
                        "in_progress"
                    } else {
                        "completed"
                    });
                    value[key][0]["conclusion"] = if conclusion == "pending" {
                        Value::Null
                    } else {
                        json!(conclusion)
                    };
                } else if route == "projects/7/pipelines/71" {
                    value["status"] = json!(conclusion);
                }
            }
        });
        let result = f.run(&watch("checks"));
        assert_eq!(
            result["status"],
            if ["pending", "running"].contains(&conclusion) {
                "pending"
            } else if ["skipped", "neutral"].contains(&conclusion) {
                "checks_completed"
            } else {
                "failed"
            },
            "{provider}/{conclusion}: {result}"
        );
        assert_eq!(
            result["next_actions"][0]["kind"],
            if ["skipped", "neutral"].contains(&conclusion) {
                "interpret_checks"
            } else if ["pending", "running"].contains(&conclusion) {
                "wait_for_checks"
            } else {
                "repair_checks"
            },
            "{provider}/{conclusion}: {result}"
        );
    }
}

#[test]
fn final_local_revalidation_is_bounded_and_leaves_a_resumable_receipt() {
    use std::{
        fs,
        time::{Duration, Instant},
    };
    let f = fixture("github");
    f.edit(|s| {
        s["calls"] = json!([]);
        s["git_proxy_delay_ms"] = json!(100);
    });
    let proxy = tempfile::tempdir().unwrap();
    let name = if cfg!(windows) { "git.exe" } else { "git" };
    let real_git = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|p| p.join(name))
        .find(|p| p.is_file())
        .unwrap();
    fs::copy(
        env!("CARGO_BIN_EXE_specgit-process-fixture"),
        proxy.path().join(name),
    )
    .unwrap();
    let mut command = f.command(&[
        "watch",
        "--request",
        "41",
        "--session",
        "session-a",
        "--goal",
        "checks",
        "--once",
        "--timeout-seconds",
        "1",
    ]);
    let path = command
        .get_envs()
        .find(|(k, _)| *k == "PATH")
        .unwrap()
        .1
        .unwrap()
        .to_owned();
    let paths = std::iter::once(proxy.path().to_owned()).chain(std::env::split_paths(&path));
    command
        .env("PATH", std::env::join_paths(paths).unwrap())
        .env("SPECGIT_FIXTURE_REAL_GIT", real_git);
    let start = Instant::now();
    let out = command.output().unwrap();
    let result: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(result["status"], "timed_out", "{result}");
    assert!(
        start.elapsed() < Duration::from_secs(10),
        "Final local Git escaped observer deadline: {:?}",
        start.elapsed()
    );
    assert!(
        f.state()["hanging_git_pid"].is_number(),
        "Regression must reach the hanging final Git check: result={result}, state={}, elapsed={:?}",
        f.state(),
        start.elapsed()
    );
    // Batched discovery reaches the injected failure without replaying separate
    // rev-parse queries. Require the warm snapshot, not redundant cache hits.
    assert_eq!(f.state()["initial_git_complete"], true);
    assert!(!f.state()["git_proxy_cache"].as_object().unwrap().is_empty());
    assert_eq!(f.state()["observation_discovery_failed"], true);
    assert!(f.state()["calls"].as_array().unwrap().is_empty());
    let identity: Identity =
        serde_json::from_value(result["evidence"]["subscription"].clone()).unwrap();
    assert!(
        watch_store::read(&identity)
            .unwrap()
            .unwrap()
            .lease
            .is_none()
    );
    f.edit(|s| s["read_failure"] = Value::Null);
    assert_eq!(f.run(&watch("checks"))["status"], "checks_passed");
}

fn hook_output(f: &delivery::Fixture, event: &str, observe: bool) -> Value {
    use std::{io::Write, process::Stdio};
    let mut args = vec!["hook", "--event", event];
    if observe {
        args.push("--observe");
    }
    let mut child = f
        .command(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let payload = json!({"session_id":"session-a","hook_event_name":event,"cwd":f.root,"tool_name":"Bash","tool_input":{"command":"git add --dry-run .specgit.yaml"}});
    // Retired callbacks return before reading input, so the child may close
    // its stdin first; only that broken pipe is an accepted write outcome.
    if let Err(error) = child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&payload).unwrap())
    {
        assert_eq!(
            error.kind(),
            std::io::ErrorKind::BrokenPipe,
            "{event}: {error}"
        );
    }
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    if out.stdout.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&out.stdout).unwrap()
    }
}
#[test]
fn explicit_watch_offers_fresh_events_and_allowed_hooks_only_recover_unverified_ids() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider);
        f.edit(|s| {
            s["requests"][0]["state"] = json!(if provider == "github" {
                "closed"
            } else {
                "merged"
            });
            s["requests"][0]["merged"] = json!(true);
            s["issues"][0]["state"] = json!("closed");
        });
        let writes = f.writes();
        let first = f.run(&watch("lifecycle"));
        assert_eq!(first["status"], "completed", "{first}");
        let id = first["evidence"]["events"][0]["id"].as_str().unwrap();
        let calls = f.state()["calls"].as_array().unwrap().len();
        for event in ["PostToolUse", "Stop"] {
            assert!(hook_output(&f, event, true).is_null());
        }
        let recovered = hook_output(&f, "SessionStart", false);
        let text = recovered["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap();
        assert!(text.contains(id) && text.contains("unverified event receipts"));
        assert!(!text.contains("\"state\":\"completed\""));
        assert_eq!(f.state()["calls"].as_array().unwrap().len(), calls);
        assert!(hook_output(&f, "SessionStart", false).is_null());
        assert_eq!(f.writes(), writes);
    }
}

#[test]
fn ordinary_local_edits_supersede_the_assessment_without_losing_the_live_subscription() {
    use std::{
        fs,
        time::{Duration, Instant},
    };
    let f = fixture("github");
    let first = f.run(&watch("lifecycle"));
    let identity: Identity =
        serde_json::from_value(first["evidence"]["subscription"].clone()).unwrap();
    let mut child = WatchProcess::spawn(
        f.native_command(&[
            "watch",
            "--request",
            "41",
            "--session",
            "session-a",
            "--goal",
            "lifecycle",
            "--poll-seconds",
            "1",
            "--timeout-seconds",
            "30",
        ]),
        &identity,
        "ordinary-local-edits",
    );
    let started = Instant::now();
    loop {
        let state = watch_store::read(&identity).unwrap().unwrap();
        if state
            .lease
            .is_some_and(|l| l.pid == child.id() && l.polls_completed > 0)
        {
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "{}",
            child.diagnostic()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    fs::write(f.root.join("new-file"), "ordinary local edit").unwrap();
    let started = Instant::now();
    loop {
        let state = watch_store::read(&identity).unwrap().unwrap();
        if state.events.iter().any(|e| {
            e.state == EventState::Pending && e.reason.contains("Local changes superseded")
        }) {
            break;
        }
        assert!(
            child.try_wait().unwrap().is_none(),
            "Observer exited after an ordinary edit: {}",
            child.diagnostic()
        );
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "{}",
            child.diagnostic()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(child.try_wait().unwrap().is_none());
    child.kill().unwrap();
    child.wait().unwrap();
    assert_eq!(f.run(&watch("checks"))["status"], "checks_passed");
}

fn repeated_pending_poll(
    lease: Option<&watch_store::Lease>,
    event: Option<&watch_store::Event>,
    pid: u32,
    head: &str,
    minimum: u64,
) -> bool {
    lease.is_some_and(|l| l.pid == pid && l.polls_completed >= minimum.max(4))
        && event.is_some_and(|e| {
            e.state == EventState::Pending
                && !e.superseded
                && e.reason.contains("Local commits are ahead")
                && e.revision.local_head == head
                && e.validated_at > e.observed_at
        })
}

#[test]
fn repeated_pending_requires_live_revalidation_not_early_completion() {
    let mut lease = watch_store::Lease {
        owner: "test".into(),
        pid: 42,
        started_at: 1,
        deadline: 100,
        polls_completed: 5,
    };
    let mut event = watch_store::Event {
        id: "event".into(),
        fingerprint: "fingerprint".into(),
        revision: Revision {
            head: "old".into(),
            local_head: "new".into(),
            target: "main".into(),
            declaration: "declaration".into(),
            evidence_digest: "evidence".into(),
        },
        state: EventState::Pending,
        reason: "Local commits are ahead".into(),
        next_action: "push".into(),
        next_step: None,
        observed_at: 2,
        validated_at: 4,
        acknowledged_at: None,
        superseded: false,
    };
    let ready = |lease: &watch_store::Lease, event: &watch_store::Event| {
        repeated_pending_poll(Some(lease), Some(event), 42, "new", 5)
    };
    assert!(ready(&lease, &event));
    lease.polls_completed = 4;
    assert!(!ready(&lease, &event), "missing a repeated pending poll");
    lease.polls_completed = 5;
    event.state = EventState::Completed;
    assert!(!ready(&lease, &event), "premature completion must fail");
    event.state = EventState::Pending;
    event.validated_at = event.observed_at;
    assert!(!ready(&lease, &event), "one event is not revalidation");
    event.validated_at = 4;
    event.revision.local_head = "old".into();
    assert!(!ready(&lease, &event), "stale local head must fail");
    assert!(!repeated_pending_poll(None, Some(&event), 42, "new", 5));
}

#[test]
fn unpushed_commits_remain_pending_for_multiple_polls_then_native_push_resumes() {
    use std::{
        process::Command,
        time::{Duration, Instant},
    };
    let f = fixture("github");
    let calibration = Instant::now();
    let first = f.run(&watch("lifecycle"));
    // A poll includes native reads and Git revalidation, not only its sleep.
    // Calibrate before spawning; lack of progress still has a capped watchdog.
    let poll_budget = Duration::from_secs(calibration.elapsed().as_secs().max(1) * 2 + 2);
    assert!(
        poll_budget <= Duration::from_secs(30),
        "slow fixture calibration"
    );
    let subscription_seconds = (poll_budget * 6).as_secs().to_string();
    let identity: Identity =
        serde_json::from_value(first["evidence"]["subscription"].clone()).unwrap();
    let old_head = first["evidence"]["events"][0]["revision"]["local_head"]
        .as_str()
        .unwrap();
    let mut child = WatchProcess::spawn(
        f.native_command(&[
            "watch",
            "--request",
            "41",
            "--session",
            "session-a",
            "--goal",
            "lifecycle",
            "--poll-seconds",
            "1",
            "--timeout-seconds",
            &subscription_seconds,
        ]),
        &identity,
        "unpushed-commits",
    );
    let started = Instant::now();
    let mut observer_deadline = None;
    loop {
        let state = watch_store::read(&identity).unwrap().unwrap();
        if let Some(lease) = state.lease.as_ref().filter(|l| l.pid == child.id()) {
            observer_deadline = Some(lease.deadline);
            if lease.polls_completed > 0 {
                assert!(
                    child.try_wait().unwrap().is_none(),
                    "Observer exited before local commits were added: {}",
                    child.diagnostic()
                );
                break;
            }
        }
        assert!(
            child.try_wait().unwrap().is_none()
                && observer_deadline.is_none_or(|deadline| watch_store::now() < deadline)
                && (observer_deadline.is_some() || started.elapsed() < poll_budget * 2),
            "{}",
            child.diagnostic()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        Command::new("git")
            .current_dir(&f.root)
            .args(["commit", "--allow-empty", "-m", "unpushed work"])
            .output()
            .unwrap()
            .status
            .success()
    );
    let new_head = String::from_utf8(
        Command::new("git")
            .current_dir(&f.root)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_owned();
    let mut polls = 0;
    let mut first_pending = None;
    loop {
        let state = watch_store::read(&identity).unwrap().unwrap();
        if let Some(lease) = &state.lease
            && lease.pid == child.id()
            && lease.polls_completed > polls
        {
            polls = lease.polls_completed;
            observer_deadline = Some(lease.deadline);
            if state.events.last().is_some_and(|e| {
                e.state == EventState::Pending
                    && e.reason.contains("Local commits are ahead")
                    && e.revision.local_head == new_head
            }) {
                let pending = state.events.last().unwrap();
                let next_step = pending.next_step.as_ref().unwrap();
                assert!(next_step.requires_user_authorization, "{pending:?}");
                assert!(next_step.message.contains("Push reviewed commits"));
                assert!(next_step.message.contains("existing task authorization"));
                let first_poll = *first_pending.get_or_insert(polls);
                if repeated_pending_poll(
                    Some(lease),
                    Some(pending),
                    child.id(),
                    &new_head,
                    first_poll + 2,
                ) {
                    assert!(
                        state
                            .events
                            .iter()
                            .any(|e| { e.state == EventState::ChecksPassed && e.superseded })
                    );
                    break;
                }
            }
        }
        assert!(
            child.try_wait().unwrap().is_none(),
            "Observer exited while local commits awaited push: {}",
            child.diagnostic()
        );
        assert!(
            observer_deadline.is_some_and(|deadline| watch_store::now() < deadline),
            "Observer deadline expired before multiple pending revalidations: {}",
            child.diagnostic()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    // Native fixture now reports the pushed head and later completed lifecycle.
    f.edit(|s| {
        *s = serde_json::from_str(&s.to_string().replace(old_head, &new_head)).unwrap();
        s["requests"][0]["state"] = json!("closed");
        s["requests"][0]["merged"] = json!(true);
        s["issues"][0]["state"] = json!("closed");
    });
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(
            observer_deadline.is_some_and(|deadline| watch_store::now() < deadline),
            "Native push did not resume completion: {}",
            child.diagnostic()
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    let (stdout, _) = child.output();
    let result: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(result["status"], "completed", "{result}");
    assert!(status.success());
    assert_eq!(
        result["evidence"]["events"][0]["revision"]["head"],
        new_head
    );
}

#[test]
fn native_auto_merge_removal_is_a_fresh_read_only_event() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider);
        f.edit(|s| {
            if provider == "github" {
                s["requests"][0]["auto_merge"] = json!({"merge_method":"squash"});
            } else {
                s["requests"][0]["merge_when_pipeline_succeeds"] = json!(true);
            }
        });
        let before = f.run(&watch("checks"));
        let writes = f.writes();
        f.edit(|s| {
            if provider == "github" {
                s["requests"][0]["auto_merge"] = Value::Null;
            } else {
                s["requests"][0]["merge_when_pipeline_succeeds"] = json!(false);
            }
        });
        let after = f.run(&inbox());
        let event = &after["evidence"]["events"][0];
        assert_ne!(event["id"], before["evidence"]["events"][0]["id"]);
        assert!(
            event["reason"]
                .as_str()
                .unwrap()
                .contains("native_auto_merge_not_registered"),
            "{after}"
        );
        assert_eq!(f.writes(), writes);
    }
}

#[test]
fn association_source_change_with_same_issue_ids_refreshes_the_event() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider);
        f.edit(|s| s["native_closing"] = json!([1]));
        let before = f.run(&watch("checks"));
        let writes = f.writes();
        f.edit(|s| s["native_closing"] = json!([]));
        let after = f.run(&inbox());
        assert_ne!(
            after["evidence"]["events"][0]["id"], before["evidence"]["events"][0]["id"],
            "{after}"
        );
        assert_eq!(f.writes(), writes);
    }
}

#[test]
fn unavailable_native_closing_never_emits_a_completed_watch_event() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider);
        f.edit(|s| {
            s["requests"][0]["state"] = json!(if provider == "github" {
                "closed"
            } else {
                "merged"
            });
            s["requests"][0]["merged"] = json!(true);
            s["issues"][0]["state"] = json!("closed");
            s["native_closing_failure"] = json!("forbidden");
        });
        let r = f.run(&watch("lifecycle"));
        assert_eq!(r["status"], "unknown", "{provider}: {r}");
        assert!(
            r["evidence"]["events"]
                .as_array()
                .unwrap()
                .iter()
                .all(|e| e["state"] != "completed")
        );
    }
}

#[test]
fn native_association_without_body_syntax_emits_completed_after_actual_closure() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider);
        f.edit(|s| {
            s["native_closing"] = json!([1]);
            s["requests"][0]["state"] = json!(if provider == "github" {
                "closed"
            } else {
                "merged"
            });
            s["requests"][0]["merged"] = json!(true);
            s["requests"][0]["body"] = json!("Native commit association without body syntax");
            s["requests"][0]["description"] = s["requests"][0]["body"].clone();
            s["issues"][0]["state"] = json!("closed");
        });
        let writes = f.writes();
        let r = f.run(&watch("lifecycle"));
        assert_eq!(r["status"], "completed", "{provider}: {r}");
        assert_eq!(r["exit"], 0);
        assert_eq!(r["evidence"]["events"][0]["state"], "completed");
        assert_eq!(r["next_actions"][0]["kind"], "completed", "{r}");
        assert_eq!(f.writes(), writes);
    }
}

#[test]
fn incomplete_native_association_evidence_never_becomes_cli_or_watch_completion() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider);
        f.edit(|s| {
            s["native_closing"] = json!([0]);
            s["requests"][0]["state"] = json!(if provider == "github" {
                "closed"
            } else {
                "merged"
            });
            s["requests"][0]["merged"] = json!(true);
            s["issues"][0]["state"] = json!("closed");
        });
        let writes = f.writes();
        let r = f.run(&["pr", "--status"]);
        assert_eq!(r["exit"], 3, "{provider}: {r}");
        assert_eq!(r["evidence"]["native_closing_available"], false);
        assert_ne!(r["status"], "completed");
        let r = f.run(&watch("lifecycle"));
        assert_eq!(r["status"], "unknown", "{provider}: {r}");
        assert_eq!(f.writes(), writes);
    }
}

#[test]
fn state_root_is_not_a_supported_watch_or_inbox_argument() {
    let f = fixture("github");
    for args in [
        vec![
            "watch",
            "--request",
            "41",
            "--session",
            "session-a",
            "--goal",
            "checks",
            "--state-root",
            "x",
        ],
        vec![
            "inbox",
            "--request",
            "41",
            "--session",
            "session-a",
            "--goal",
            "checks",
            "--state-root",
            "x",
        ],
    ] {
        let writes = f.writes();
        let calls = f.state()["calls"].as_array().unwrap().len();
        assert_eq!(f.run(&args)["exit"], 2, "{args:?}");
        assert_eq!(f.state()["calls"].as_array().unwrap().len(), calls);
        assert_eq!(f.writes(), writes, "{args:?}");
    }
}

#[test]
fn scheduling_windows_remain_pending_and_unknown_statuses_remain_retryable() {
    let f = fixture("github");
    f.edit(|s| {
        for (route, response) in s["read_routes"].as_object_mut().unwrap() {
            if route.contains("/check-runs?") {
                *response = json!({"total_count":0,"check_runs":[]});
            }
            if route.contains("/actions/runs?") {
                response["workflow_runs"][0]["status"] = json!("queued");
                response["workflow_runs"][0]["conclusion"] = Value::Null;
            }
        }
    });
    let observed = f.run(&["pr", "--status"]);
    assert_eq!(observed["exit"], 0, "{observed}");
    let pending = f.run(&watch("checks"));
    assert_eq!(pending["status"], "pending", "{pending}");
    assert_eq!(
        pending["next_actions"][0]["kind"], "wait_for_checks",
        "{pending}"
    );
    f.edit(|s| {
        for (route, response) in s["read_routes"].as_object_mut().unwrap() {
            if route.contains("/actions/runs?") {
                response["workflow_runs"][0]["status"] = json!("completed");
                response["workflow_runs"][0]["conclusion"] = json!("success");
            }
        }
    });
    // A completed native workflow also proves success before check-run visibility.
    let passed = f.run(&watch("checks"));
    assert_eq!(passed["status"], "checks_passed", "{passed}");
    for status in ["canceling", "waiting_for_callback", "future_status"] {
        let f = fixture("gitlab");
        f.edit(|s| {
            s["read_routes"]["projects/7/pipelines/71"]["status"] = json!(status);
        });
        let result = f.run(&watch("checks"));
        if status == "future_status" {
            assert_eq!(result["status"], "unknown", "{result}");
            let mut child = polling(&f, "unknown-check-status-retries");
            wait_for_poll(&f, &mut child, 2);
            assert!(
                child.try_wait().unwrap().is_none(),
                "unknown checks stopped the watch"
            );
            child.kill().unwrap();
            child.wait().unwrap();
        } else {
            assert_eq!(result["status"], "pending", "{result}");
        }
    }
}
