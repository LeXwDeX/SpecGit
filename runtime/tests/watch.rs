#![cfg(feature = "test-fixtures")]
#[path = "support/acceptance.rs"]
mod acceptance;
#[path = "support/delivery.rs"]
mod delivery;
use acceptance::fixture;
use delivery::executable;
use serde_json::{Value, json};
use specgit::watch_store::{self, EventState, Identity, Revision, Store};
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
    [
        "inbox",
        "--request",
        "41",
        "--session",
        "session-a",
        "--goal",
        "checks",
    ]
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
        s["read_failure"] = json!("auth");
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
        "Regression must reach the hanging final Git check"
    );
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
    serde_json::from_slice(&out.stdout).unwrap()
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
        process::Stdio,
        time::{Duration, Instant},
    };
    let f = fixture("github");
    let first = f.run(&watch("lifecycle"));
    let identity: Identity =
        serde_json::from_value(first["evidence"]["subscription"].clone()).unwrap();
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
            "1",
            "--timeout-seconds",
            "30",
        ])
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let started = Instant::now();
    loop {
        let state = watch_store::read(&identity, None).unwrap().unwrap();
        if state
            .lease
            .is_some_and(|l| l.pid == child.id() && l.polls_completed > 0)
        {
            break;
        }
        assert!(started.elapsed() < Duration::from_secs(10));
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
            "Observer exited after an ordinary edit"
        );
        assert!(started.elapsed() < Duration::from_secs(10));
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
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    let f = fixture("github");
    let first = f.run(&watch("lifecycle"));
    let identity: Identity =
        serde_json::from_value(first["evidence"]["subscription"].clone()).unwrap();
    let old_head = first["evidence"]["events"][0]["revision"]["local_head"]
        .as_str()
        .unwrap();
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
            "1",
            "--timeout-seconds",
            "30",
        ])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let started = Instant::now();
    loop {
        let state = watch_store::read(&identity, None).unwrap().unwrap();
        if state
            .lease
            .is_some_and(|l| l.pid == child.id() && l.polls_completed > 0)
        {
            break;
        }
        assert!(started.elapsed() < Duration::from_secs(10));
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
            "Observer exited while local commits awaited push"
        );
        assert!(
            started.elapsed() < Duration::from_secs(15),
            "No multi-poll pending state"
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
    let out = child.wait_with_output().unwrap();
    let result: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(result["status"], "completed", "{result}");
    assert!(out.status.success());
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
