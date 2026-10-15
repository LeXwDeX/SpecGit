#![cfg(feature = "test-fixtures")]
#[path = "support/acceptance.rs"]
mod acceptance;
#[path = "support/delivery.rs"]
mod delivery;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
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
fn retired_lifecycle_callbacks_are_silent_without_observation_side_effects() {
    let f = acceptance::fixture_with_observation(
        "github",
        "observation:\n  poll_seconds: 1\n  max_wait_seconds: 20\n",
    );
    f.edit(|s| s["requests"][0]["draft"] = json!(true));
    let calls = f.state()["calls"].clone();
    let private = f.root.join(".git/specgit-v2");
    fn files(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        let mut result = BTreeMap::new();
        if !root.exists() {
            return result;
        }
        for entry in fs::read_dir(root).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                result.extend(files(&path));
            } else {
                result.insert(path.clone(), fs::read(path).unwrap());
            }
        }
        result
    }
    let state_before = files(&private);
    for event in ["PostToolUse", "Stop"] {
        let mut child = f
            .command(&["hook", "--event", event, "--observe"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        if let Err(error) = stdin.write_all(
            json!({"hook_event_name":event,"cwd":f.root,"session_id":"draft","tool_name":"Bash","tool_input":{"command":"specgit pr --ready"}})
                .to_string()
                .as_bytes(),
        ) {
            assert_eq!(error.kind(), std::io::ErrorKind::BrokenPipe, "{event}: {error}");
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        if child.try_wait().unwrap().is_none() {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("retired {event} callback waited for stdin or lifecycle state");
        }
        drop(stdin);
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "{event}: {:?}", output.stderr);
        assert!(output.stdout.is_empty(), "{event}: {:?}", output.stdout);
        assert!(output.stderr.is_empty(), "{event}: {:?}", output.stderr);
    }
    assert_eq!(
        f.state()["calls"],
        calls,
        "retired callbacks queried the forge"
    );
    assert_eq!(
        files(&private),
        state_before,
        "retired callbacks changed project state"
    );
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

/// Product deadlines bound every writer; this guard only reports a hang.
const HANG_GUARD: Duration = Duration::from_secs(180);
/// Owns concurrently running writers. Dropping it releases the fixture gate and
/// reaps every child; after a failure it prints their output and forge calls.
struct Writers<'a> {
    fixture: &'a delivery::Fixture,
    releases: Vec<PathBuf>,
    children: Vec<(&'static str, Child)>,
}
impl Writers<'_> {
    fn output(&self, name: &str, stream: &str) -> PathBuf {
        self.fixture
            .root
            .parent()
            .unwrap()
            .join(format!("{name}.{stream}"))
    }
    fn spawn(&mut self, name: &'static str, mut command: Command) {
        // Files cannot fill up and stall a writer the way an unread pipe can.
        let child = command
            .stdout(fs::File::create(self.output(name, "stdout")).unwrap())
            .stderr(fs::File::create(self.output(name, "stderr")).unwrap())
            .spawn()
            .unwrap();
        self.children.push((name, child));
    }
    fn exited(&mut self, name: &str) -> bool {
        let (_, child) = self.children.iter_mut().find(|(n, _)| *n == name).unwrap();
        child.try_wait().unwrap().is_some()
    }
    fn report(&mut self, name: &str) -> Value {
        let exited = wait_for(HANG_GUARD, || self.exited(name));
        assert!(exited, "{name} writer did not exit");
        serde_json::from_slice(&fs::read(self.output(name, "stdout")).unwrap())
            .unwrap_or_else(|_| panic!("{name} writer did not print one JSON report"))
    }
}
impl Drop for Writers<'_> {
    fn drop(&mut self) {
        // Release first so a parked writer can finish and print its report.
        for release in &self.releases {
            let _ = fs::write(release, b"");
        }
        for (_, child) in &mut self.children {
            wait_for(Duration::from_secs(5), || {
                !matches!(child.try_wait(), Ok(None))
            });
            let _ = child.kill();
            let _ = child.wait();
        }
        if std::thread::panicking() {
            // Never panic again here: a second panic would abort without evidence.
            let read = |path: PathBuf| {
                String::from_utf8_lossy(&fs::read(path).unwrap_or_default()).into_owned()
            };
            for (name, _) in &self.children {
                for stream in ["stdout", "stderr"] {
                    eprintln!(
                        "{name} writer {stream}: {}",
                        read(self.output(name, stream))
                    );
                }
            }
            let api = self.fixture.root.parent().unwrap().join("api.json");
            eprintln!("fixture state with calls: {}", read(api));
        }
    }
}
fn wait_for(limit: Duration, mut done: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + limit;
    while !done() {
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    true
}

#[test]
fn linked_worktrees_share_issue_creation_lock() {
    let a = delivery::Fixture::new("github");
    let base = a.root.parent().unwrap().to_owned();
    let linked = base.join("linked");
    git(&a.root, &["worktree", "add", "-b", "linked", "../linked"]);
    fs::copy(a.root.join(".specgit.yaml"), linked.join(".specgit.yaml")).unwrap();
    let parked = base.join("issue-create.parked");
    let release = base.join("issue-create.release");
    let main_ready = base.join("main-preflight.ready");
    let main_release = base.join("main-preflight.release");
    let linked_ready = base.join("linked-preflight.ready");
    let linked_release = base.join("linked-preflight.release");
    a.edit(|s| {
        s["issue_create_gate"] = json!({"parked":parked,"release":release});
        s["issue_preflight_gates"] = json!({
            "project":{"parked":main_ready,"release":main_release},
            "linked":{"parked":linked_ready,"release":linked_release},
        });
    });
    let args = ["issue", "--create-labels", "feat: identical concurrent WHY"];
    let mut writers = Writers {
        fixture: &a,
        releases: vec![
            main_release.clone(),
            linked_release.clone(),
            release.clone(),
        ],
        children: vec![],
    };
    // Both writers finish external preflight before either can acquire the lock.
    writers.spawn("main", a.command(&args));
    let mut command = a.command(&args);
    command.current_dir(&linked);
    writers.spawn("linked", command);
    wait_for(HANG_GUARD, || {
        (main_ready.exists() && linked_ready.exists())
            || writers.exited("main")
            || writers.exited("linked")
    });
    assert!(
        main_ready.exists() && linked_ready.exists(),
        "both writers must reach the last external preflight read"
    );
    fs::write(&main_release, b"").unwrap();
    wait_for(HANG_GUARD, || {
        parked.exists() || writers.exited("main") || writers.exited("linked")
    });
    assert!(
        parked.exists(),
        "main writer did not park at issue creation"
    );
    let parked_in = PathBuf::from(a.state()["issue_create_gate"]["worktree"].as_str().unwrap());
    assert!(
        parked_in.ends_with(a.root.file_name().unwrap()),
        "{parked_in:?}"
    );
    fs::write(&linked_release, b"").unwrap();
    let refused = writers.report("linked");
    assert_eq!(refused["diagnostics"][0]["code"], "lock_busy", "{refused}");
    fs::write(&release, b"").unwrap();
    let created = writers.report("main");
    assert_eq!(created["exit"], 0, "{created}");
    let state = a.state();
    let gate = &state["issue_create_gate"];
    let calls = state["calls"].as_array().unwrap();
    let creates =
        |c: &Value| c["method"] == "POST" && c["endpoint"].as_str().unwrap().ends_with("/issues");
    let searches = |c: &Value| {
        let endpoint = c["endpoint"].as_str().unwrap();
        c["method"] == "GET" && (endpoint.starts_with("search/") || endpoint.contains("/issues?"))
    };
    // Only the other writer ran while the creator was parked. The shared lock
    // must keep it from candidate search and creation in that whole window.
    let parked_window = &calls[gate["parked_calls"].as_u64().unwrap() as usize
        ..gate["resumed_calls"].as_u64().unwrap() as usize];
    assert!(
        !parked_window.iter().any(|c| creates(c) || searches(c)),
        "{parked_window:?}"
    );
    assert_eq!(calls.iter().filter(|c| creates(c)).count(), 1);
    assert_eq!(state["issues"].as_array().unwrap().len(), 1);
    // After the release, the other worktree reviews the one created Issue.
    let out = a.command(&args).current_dir(&linked).output().unwrap();
    let report: Value = serde_json::from_slice(&out.stdout).unwrap();
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
