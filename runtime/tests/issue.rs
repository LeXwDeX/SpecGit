#![cfg(feature = "test-fixtures")]
#[path = "support/delivery.rs"]
mod delivery;
use delivery::Fixture;
use serde_json::json;
use std::{fs, process::Command};
#[test]
fn both_forges_create_many_specs_then_resume_preserving_native_edits_without_new_writes() {
    for provider in ["github", "gitlab"] {
        let f = Fixture::new(provider);
        let r = f.run(&["issue", "feat: first delivery", "fix: second delivery"]);
        assert_eq!(r["exit"], 0, "{r}");
        assert_eq!(r["evidence"]["selection"]["issues"], json!([1, 2]));
        assert_eq!(f.writes(), 4);
        f.edit(|s| {
            s["issues"][0]["title"] = json!("feat: revised user title");
            s["issues"][0][if provider == "github" {
                "body"
            } else {
                "description"
            }] = json!("User changes remain");
        });
        let r = f.run(&["issue", "1", "2"]);
        assert_eq!(r["exit"], 0, "{r}");
        assert_eq!(r["evidence"]["issues"][0]["body"], "User changes remain");
        assert_eq!(f.writes(), 4);
        let status = Command::new("git")
            .current_dir(&f.root)
            .args(["status", "--porcelain"])
            .output()
            .unwrap();
        assert!(status.stdout.is_empty());
    }
}
#[test]
fn preflight_invalid_later_spec_or_incomplete_search_writes_nothing() {
    let f = Fixture::new("github");
    let r = f.run(&["issue", "feat: valid first", "unknown: bad second"]);
    assert_eq!(r["exit"], 2, "{r}");
    assert_eq!(f.writes(), 0);
    f.edit(|s| s["search_incomplete"] = json!(true));
    let r = f.run(&["issue", "feat: valid first"]);
    assert_eq!(r["exit"], 3, "{r}");
    assert_eq!(f.writes(), 0);
}
#[test]
fn response_loss_requires_exact_native_adoption_and_never_duplicates() {
    for provider in ["github", "gitlab"] {
        let f = Fixture::new(provider);
        f.edit(|s| s["lose_issue_response"] = json!(true));
        let r = f.run(&["issue", "fix: lost response"]);
        assert_eq!(r["exit"], 3, "{r}");
        assert_eq!(f.state()["issues"].as_array().unwrap().len(), 1);
        let writes = f.writes();
        let r = f.run(&["issue", "fix: lost response"]);
        assert_eq!(r["exit"], 3, "{r}");
        assert_eq!(f.writes(), writes);
        f.edit(|s| {
            s["issues"][0]["title"] = json!("fix: clarified by user");
            s["issues"][0][if provider == "github" {
                "body"
            } else {
                "description"
            }] = json!("User edited after creation");
        });
        let r = f.run(&["issue", "1"]);
        assert_eq!(r["exit"], 0, "{r}");
        assert_eq!(f.writes(), writes);
        assert_eq!(r["evidence"]["selection"]["intents"][0]["issue"], 1);
        assert_eq!(
            r["evidence"]["issues"][0]["body"],
            "User edited after creation"
        );
    }
}
#[test]
fn resumed_unwritten_intents_recheck_new_duplicates_and_current_policy_before_any_write() {
    let f = Fixture::new("github");
    f.edit(|s| s["deny_label"] = json!(true));
    assert_eq!(f.run(&["issue", "fix: resumed work"])["exit"], 3);
    f.edit(|s| {
        s["deny_label"] = json!(false);
        s["issues"] = json!([{"number":1,"title":"fix: resumed work","body":"Created by another author","labels":[{"name":"kind::fix"}],"state":"open","updated_at":"2026-09-09T00:00:00Z"}]);
    });
    let writes = f.writes();
    let r = f.run(&["issue", "fix: resumed work"]);
    assert_eq!(r["status"], "candidate_review_required", "{r}");
    assert_eq!(f.writes(), writes);

    let f = Fixture::new("github");
    f.edit(|s| s["lose_issue_response"] = json!(true));
    assert_eq!(f.run(&["issue", "fix: first", "feat: pending"])["exit"], 3);
    fs::write(f.root.join(".specgit.yaml"), "version: 2\nremote: origin\nprovider: github\nvalidation:\n  labels: project\ntags:\n  - name: kind::fix\n    color: D93F0B\n").unwrap();
    let writes = f.writes();
    let r = f.run(&["issue", "1"]);
    assert_eq!(r["exit"], 2, "{r}");
    assert_eq!(f.writes(), writes);
    assert_eq!(f.state()["issues"].as_array().unwrap().len(), 1);
}
#[test]
fn inspect_does_not_create_checkpoint_and_branch_selection_preserves_git_state() {
    let f = Fixture::new("github");
    let r = f.run(&[
        "issue",
        "feat: inspect",
        "--inspect",
        "--branch",
        "new-delivery",
    ]);
    assert_eq!(r["exit"], 0, "{r}");
    assert_eq!(f.writes(), 0);
    assert!(!f.root.join(".git/specgit-v2").exists());
    let r = f.run(&["issue", "feat: inspect", "--branch", "new-delivery"]);
    assert_eq!(r["exit"], 0, "{r}");
    assert_eq!(r["evidence"]["selection"]["branch"], "new-delivery");
    fs::write(f.root.join("user.txt"), "uncommitted").unwrap();
    let r = f.run(&["issue", "feat: another", "--branch", "another"]);
    assert_eq!(r["exit"], 2, "{r}");
    assert_eq!(
        fs::read_to_string(f.root.join("user.txt")).unwrap(),
        "uncommitted"
    );
}
