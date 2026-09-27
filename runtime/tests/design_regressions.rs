#![cfg(feature = "test-fixtures")]
#[path = "support/acceptance.rs"]
mod acceptance;
#[path = "support/delivery.rs"]
mod delivery;
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn git(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().into()
}

#[test]
fn adopted_specs_enable_guard_and_edit_hook_without_creation_intents() {
    for provider in ["github", "gitlab"] {
        let f = delivery::Fixture::new(provider);
        assert_eq!(
            f.run(&["issue", "--create-labels", "feat: existing spec"])["exit"],
            0
        );
        let path = f.root.join(".git/specgit-v2/selection.json");
        fs::remove_file(&path).unwrap();
        assert_eq!(f.run(&["issue", "1"])["exit"], 0);
        let saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["intents"], json!([]));
        assert_eq!(saved["adopted"][0]["id"], 1);
        fs::write(f.root.join("tracked.rs"), "fn main() {}\n").unwrap();
        git(&f.root, &["add", "tracked.rs"]);
        let guard = f
            .command(&["guard", "--stage", "pre-commit"])
            .output()
            .unwrap();
        assert!(guard.status.success(), "{:?}", guard.stderr);
        let mut child = f
            .command(&["hook", "--event", "PreToolUse"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(json!({"hook_event_name":"PreToolUse","cwd":f.root,"session_id":"adopted","tool_name":"Edit","tool_input":{"file_path":f.root.join("tracked.rs")}}).to_string().as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success());
        assert!(!String::from_utf8_lossy(&out.stdout).contains("\"deny\""));
    }
}

#[test]
fn issue_rejects_branch_change_during_candidate_search_before_any_write() {
    for provider in ["github", "gitlab"] {
        let f = delivery::Fixture::new(provider);
        f.edit(|s| s["switch_branch_on_search"] = json!("concurrent"));
        let r = f.run(&["issue", "--create-labels", "feat: branch race"]);
        assert_eq!(r["diagnostics"][0]["code"], "concurrent_edit", "{r}");
        assert_eq!(f.writes(), 0);
        assert!(!f.root.join(".git/specgit-v2/selection.json").exists());
    }
}

#[test]
fn same_head_check_rerun_invalidates_the_observation() {
    let f = acceptance::fixture("github");
    f.edit(|s| {
        let route = s["read_routes"]
            .as_object()
            .unwrap()
            .keys()
            .find(|k| k.contains("/check-runs?"))
            .unwrap()
            .clone();
        let mut replacement = s["read_routes"][&route].clone();
        replacement["check_runs"][0]["id"] = json!(99);
        replacement["check_runs"][0]["status"] = json!("in_progress");
        replacement["check_runs"][0]["conclusion"] = Value::Null;
        replacement["check_runs"][0]["completed_at"] = Value::Null;
        s["after_read"] = json!({"endpoint":route,"replacement":replacement});
    });
    let r = f.run(&["pr", "--status"]);
    assert_eq!(r["exit"], 3, "{r}");
    assert!(
        r["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["code"] == "concurrent_edit"),
        "{r}"
    );
    let current = f.run(&[
        "watch",
        "--request",
        "41",
        "--session",
        "rerun",
        "--goal",
        "checks",
        "--once",
    ]);
    assert_eq!(current["status"], "pending", "{current}");
}

#[test]
fn async_hook_offers_prepare_review_before_lifecycle_timeout() {
    let f = acceptance::fixture_with_observation(
        "github",
        "observation:\n  poll_seconds: 1\n  max_wait_seconds: 20\n",
    );
    f.edit(|s| s["requests"][0]["draft"] = json!(true));
    let mut child = f
        .command(&["hook", "--event", "PostToolUse", "--observe"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let started = Instant::now();
    child.stdin.take().unwrap().write_all(json!({"hook_event_name":"PostToolUse","cwd":f.root,"session_id":"draft","tool_name":"Bash","tool_input":{"command":"specgit pr --ready"}}).to_string().as_bytes()).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "{:?}", output.stderr);
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains("prepare_review"), "{text}");
    assert!(!text.contains("timed_out"), "{text}");
    assert!(started.elapsed() < Duration::from_secs(15));
}

#[test]
fn gitlab_merged_result_requires_both_current_parents_and_retains_tested_sha() {
    let f = acceptance::fixture("gitlab");
    let source = f.state()["requests"][0]["sha"].as_str().unwrap().to_owned();
    let tested = "f".repeat(40);
    f.edit(|s| {
        s["requests"][0]["head_pipeline"]["sha"] = json!(tested);
        s["read_routes"]["projects/7/pipelines/71"]["sha"] = json!(tested);
        s["read_routes"]["projects/7/pipelines/71"]["source"] = json!("merge_request_event");
        s["read_routes"]["projects/7/pipelines/71"]["ref"] = json!("refs/merge-requests/41/merge");
        s["read_routes"][format!("projects/7/repository/commits/{tested}")] =
            json!({"id":tested,"parent_ids":["a".repeat(40),source]});
        s["read_routes"]["projects/7/repository/branches/main"] =
            json!({"commit":{"id":"a".repeat(40)}});
    });
    let r = f.run(&["pr", "--status"]);
    assert_eq!(r["exit"], 0, "{r}");
    assert_eq!(r["evidence"]["checks"][0]["head"], source);
    assert_eq!(r["evidence"]["checks"][0]["tested_head"], tested);
    for parents in [
        json!(["a".repeat(40), "b".repeat(40)]),
        json!(["b".repeat(40), source]),
    ] {
        f.edit(|s| {
            s["read_routes"][format!("projects/7/repository/commits/{tested}")]["parent_ids"] =
                parents
        });
        let stale = f.run(&["pr", "--status"]);
        assert_eq!(stale["exit"], 3, "{stale}");
        assert!(stale["evidence"]["checks"].is_null());
    }
}

#[test]
fn shared_exclusion_does_not_hide_another_worktrees_manual_guidance() {
    for reverse in [false, true] {
        let f = delivery::Fixture::new("github");
        fs::write(f.root.join("AGENTS.md"), "# Manual team policy\n").unwrap();
        let linked = f.root.parent().unwrap().join("linked");
        git(&f.root, &["worktree", "add", "-b", "linked", "../linked"]);
        let init_linked = || {
            let out = f
                .command(&["init", "--manual-observe"])
                .current_dir(&linked)
                .output()
                .unwrap();
            assert!(out.status.success(), "{:?} {:?}", out.stdout, out.stderr);
        };
        if reverse {
            init_linked();
        }
        assert_eq!(f.run(&["init", "--manual-observe"])["exit"], 0);
        if !reverse {
            init_linked();
        }
        let visible = git(&f.root, &["status", "--porcelain", "--untracked-files=all"]);
        assert!(visible.contains("AGENTS.md"), "{visible}");
        assert!(
            fs::read_to_string(f.root.join("AGENTS.md"))
                .unwrap()
                .contains("Manual team policy")
        );
    }
}

#[test]
fn concurrent_checkouts_share_issue_creation_lock() {
    let a = delivery::Fixture::new("github");
    let b = delivery::Fixture::new("github");
    a.edit(|s| s["create_issue_delay_ms"] = json!(800));
    let args = ["issue", "--create-labels", "feat: identical concurrent WHY"];
    let first = a.command(&args).stdout(Stdio::piped()).spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !a.state()["calls"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["method"] == "POST" && c["endpoint"].as_str().unwrap().ends_with("/issues"))
    {
        assert!(
            Instant::now() < deadline,
            "first writer did not reach creation"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let shared = a.root.parent().unwrap();
    let second = b
        .command(&args)
        .env("HOME", shared)
        .env("LOCALAPPDATA", shared)
        .env("XDG_DATA_HOME", shared)
        .env("SPECGIT_FIXTURE_API_FILE", shared.join("api.json"))
        .output()
        .unwrap();
    let first = first.wait_with_output().unwrap();
    assert!(first.status.success(), "{:?}", first.stdout);
    let report: Value = serde_json::from_slice(&second.stdout).unwrap();
    assert_eq!(report["status"], "candidate_review_required", "{report}");
    assert_eq!(a.state()["issues"].as_array().unwrap().len(), 1);
}

#[test]
fn issue_rejects_declaration_change_before_any_write() {
    let f = delivery::Fixture::new("github");
    f.edit(|s| s["edit_declaration_on_search"] = json!(true));
    let r = f.run(&["issue", "--create-labels", "feat: declaration race"]);
    assert_eq!(r["diagnostics"][0]["code"], "concurrent_edit", "{r}");
    assert_eq!(f.writes(), 0);
    assert!(!f.root.join(".git/specgit-v2/selection.json").exists());
}
