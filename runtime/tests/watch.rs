#![cfg(feature = "test-fixtures")]
#[path = "support/acceptance.rs"]
mod acceptance;
#[path = "support/delivery.rs"]
mod delivery;
use acceptance::fixture;
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
            if route.contains("/actions/runs?") {
                value["workflow_runs"][0]["run_attempt"] = json!(2);
                value["workflow_runs"][0]["status"] = json!("in_progress");
                value["workflow_runs"][0]["conclusion"] = Value::Null;
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
        .command(&[
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
