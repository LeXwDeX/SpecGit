#![cfg(feature = "test-fixtures")]
#[path = "support/acceptance.rs"]
mod acceptance;
#[path = "support/delivery.rs"]
mod delivery;
use acceptance::fixture;
use delivery::executable;
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
            "state": watch_store::read(&self.identity, None).unwrap(),
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
fn request_reads(f: &delivery::Fixture) -> usize {
    f.state()["calls"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|call| {
            call["method"] == "GET"
                && call["endpoint"]
                    .as_str()
                    .is_some_and(|endpoint| endpoint.ends_with("/pulls/41"))
        })
        .count()
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
        watch_store::read(&identity, None)
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
    assert!(
        request_reads(&f) >= before + 2,
        "explicit poll_seconds was not applied"
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
    let f = acceptance::fixture_with_observation(
        "github",
        "observation:\n  poll_seconds: 1\n  max_wait_seconds: 5\n  notify: []\n",
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
    assert_eq!(direct["status"], "completed");
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
    assert_eq!(direct_inbox["status"], "completed");
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
                    assert!(next_step["message"].as_str().unwrap().contains("checks"));
                    assert!(next_step["message"].as_str().unwrap().contains("draft"));
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
fn merged_open_issues_include_ids_and_hook_text_matches_the_structured_action() {
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
        let offered = hook_output(&f, "PostToolUse", true);
        let hook_text = offered["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap();
        assert!(
            hook_text.contains(next_step["message"].as_str().unwrap()),
            "{offered}"
        );
        assert!(
            hook_text.contains(&serde_json::to_string(next_step).unwrap()),
            "{offered}"
        );
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

    let offered = hook_output(&f, "PostToolUse", true);
    let text = offered.to_string();
    assert!(text.contains("unknown"), "{offered}");
}

#[test]
fn completed_only_notifications_suppress_attention_events() {
    let f = acceptance::fixture_with_observation(
        "github",
        "observation:\n  poll_seconds: 1\n  max_wait_seconds: 5\n  notify: [completed]\n",
    );
    f.edit(|s| s["read_failure"] = json!("auth"));

    let offered = hook_output(&f, "PostToolUse", true);
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
        watch_store::read(&identity, None)
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
    let t = tempfile::tempdir().unwrap();
    let root = t.path().canonicalize().unwrap();
    let store = Store::new(identity.clone(), Some(&root)).unwrap();
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
    assert_eq!(
        watch_store::read(&identity, Some(&root))
            .unwrap()
            .unwrap()
            .events
            .len(),
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
        if watch_store::read(&identity, None)
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
    let before = watch_store::read(&identity, None).unwrap().unwrap();
    assert!(before.lease.is_none());
    let store = Store::new(identity.clone(), None).unwrap();
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
        watch_store::read(&identity, None)
            .unwrap()
            .unwrap()
            .sequence,
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
    assert!(f.state()["git_proxy_hits"].as_u64().unwrap() > 0);
    assert_eq!(f.state()["observation_discovery_failed"], true);
    assert!(f.state()["calls"].as_array().unwrap().is_empty());
    let identity: Identity =
        serde_json::from_value(result["evidence"]["subscription"].clone()).unwrap();
    assert!(
        watch_store::read(&identity, None)
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
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&payload).unwrap())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    if out.stdout.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&out.stdout).unwrap()
    }
}
#[test]
fn async_hook_offers_fresh_lifecycle_events_and_sync_hook_only_recovers_unverified_ids() {
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
        let offered = hook_output(&f, "PostToolUse", true);
        let text = offered["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap();
        assert!(
            text.contains("not acknowledged") && text.contains("completed"),
            "{offered}"
        );
        let first = f.run(&watch("lifecycle"));
        let id = first["evidence"]["events"][0]["id"].as_str().unwrap();
        assert!(text.contains(id));
        let calls = f.state()["calls"].as_array().unwrap().len();
        let recovered = hook_output(&f, "SessionStart", false);
        let text = recovered["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap();
        assert!(text.contains(id) && text.contains("unverified event receipts"));
        assert!(!text.contains("\"state\":\"completed\""));
        assert_eq!(f.state()["calls"].as_array().unwrap().len(), calls);
        assert_eq!(f.writes(), writes);
    }
}
#[test]
#[ignore = "Explicit local host qualification; requires real Claude Code and Python, isolated loopback model only"]
fn real_claude_host_consumes_async_observer_event_on_the_next_model_turn() {
    let f = fixture("github");
    f.edit(|s| {
        s["requests"][0]["state"] = json!("closed");
        s["requests"][0]["merged"] = json!(true);
        s["issues"][0]["state"] = json!("closed");
    });
    let environment = f.command(&[]);
    let mut command = std::process::Command::new("python3");
    for (key, value) in environment.get_envs() {
        if let Some(value) = value {
            command.env(key, value);
        }
    }
    let out = command
        .args([
            "scripts/claude-local-host-probe.py",
            "--binary",
            executable::binary().to_str().unwrap(),
            "--project",
            f.root.to_str().unwrap(),
            "--observe",
        ])
        .output()
        .unwrap();
    println!("{}", String::from_utf8_lossy(&out.stdout));
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
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
        let state = watch_store::read(&identity, None).unwrap().unwrap();
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
        let state = watch_store::read(&identity, None).unwrap().unwrap();
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

#[test]
fn unpushed_commits_remain_pending_for_multiple_polls_then_native_push_resumes() {
    use std::{
        process::Command,
        time::{Duration, Instant},
    };
    let f = fixture("github");
    let first = f.run(&watch("lifecycle"));
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
            "30",
        ]),
        &identity,
        "unpushed-commits",
    );
    let started = Instant::now();
    loop {
        let state = watch_store::read(&identity, None).unwrap().unwrap();
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
    let started = Instant::now();
    loop {
        let state = watch_store::read(&identity, None).unwrap().unwrap();
        if state
            .lease
            .is_some_and(|l| l.pid == child.id() && l.polls_completed >= 4)
            && state.events.last().is_some_and(|e| {
                e.state == EventState::Pending && e.reason.contains("Local commits are ahead")
            })
        {
            break;
        }
        assert!(
            child.try_wait().unwrap().is_none(),
            "Observer exited while local commits awaited push: {}",
            child.diagnostic()
        );
        assert!(
            started.elapsed() < Duration::from_secs(15),
            "No multi-poll pending state: {}",
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
    let status = child.wait().unwrap();
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
