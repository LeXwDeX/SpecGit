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
        let r = f.run(&[
            "issue",
            "--create-labels",
            "feat: first delivery",
            "fix: second delivery",
        ]);
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
        let r = f.run(&["issue", "--create-labels", "1", "2"]);
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
    let r = f.run(&[
        "issue",
        "--create-labels",
        "feat: valid first",
        "unknown: bad second",
    ]);
    assert_eq!(r["exit"], 2, "{r}");
    assert_eq!(f.writes(), 0);
    f.edit(|s| s["search_incomplete"] = json!(true));
    let r = f.run(&["issue", "--create-labels", "feat: valid first"]);
    assert_eq!(r["exit"], 3, "{r}");
    assert_eq!(f.writes(), 0);
}
#[test]
fn response_loss_requires_exact_native_adoption_and_never_duplicates() {
    for provider in ["github", "gitlab"] {
        let f = Fixture::new(provider);
        f.edit(|s| s["lose_issue_response"] = json!(true));
        let r = f.run(&["issue", "--create-labels", "fix: lost response"]);
        assert_eq!(r["exit"], 3, "{r}");
        assert_eq!(r["effects"]["outcome"], "unknown", "{r}");
        let effect = r["effects"]["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["action"] == "create_issue")
            .unwrap();
        assert_eq!(effect["outcome"], "unknown");
        assert_eq!(
            effect["recovery"]["next_action"],
            "inspect_candidates_then_adopt_exact_id"
        );
        assert_eq!(f.state()["issues"].as_array().unwrap().len(), 1);
        let writes = f.writes();
        let r = f.run(&["issue", "--create-labels", "fix: lost response"]);
        assert_eq!(r["exit"], 3, "{r}");
        assert_eq!(f.writes(), writes);
        let preview = f.run(&["issue", "fix: lost response", "--inspect"]);
        let review = preview["evidence"]["candidates"][0]["review_digest"]
            .as_str()
            .unwrap();
        let retried = f.run(&[
            "issue",
            "fix: lost response",
            "--create-labels",
            "--reviewed-candidates",
            review,
        ]);
        assert_eq!(retried["exit"], 3, "{retried}");
        assert_eq!(f.writes(), writes);
        f.edit(|s| {
            s["issues"][0]["title"] = json!("fix: clarified by user");
            s["issues"][0][if provider == "github" {
                "body"
            } else {
                "description"
            }] = json!("User edited after creation");
        });
        let r = f.run(&["issue", "--create-labels", "1"]);
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
fn reviewed_distinct_specs_can_be_created_without_adopting_similar_issues() {
    for provider in ["github", "gitlab"] {
        let f = Fixture::new(provider);
        assert_eq!(
            f.run(&["issue", "feat: original", "--create-labels"])["exit"],
            0
        );
        let before = f.state()["issues"][0].clone();
        let writes = f.writes();
        let blocked = f.run(&[
            "issue",
            "fix: distinct work",
            "docs: separate work",
            "--create-labels",
        ]);
        assert_eq!(blocked["status"], "candidate_review_required", "{blocked}");
        assert_eq!(f.writes(), writes);
        let preview = f.run(&[
            "issue",
            "fix: distinct work",
            "docs: separate work",
            "--inspect",
        ]);
        let reviews = preview["evidence"]["candidates"].as_array().unwrap();
        assert_eq!(reviews.len(), 2);
        let first = reviews[0]["review_digest"].as_str().unwrap();
        let second = reviews[1]["review_digest"].as_str().unwrap();
        assert_ne!(first, second);
        let incomplete = f.run(&[
            "issue",
            "fix: distinct work",
            "docs: separate work",
            "--create-labels",
            "--reviewed-candidates",
            first,
        ]);
        assert_eq!(
            incomplete["status"], "candidate_review_required",
            "{incomplete}"
        );
        assert_eq!(f.writes(), writes);
        let created = f.run(&[
            "issue",
            "fix: distinct work",
            "docs: separate work",
            "--create-labels",
            "--reviewed-candidates",
            first,
            "--reviewed-candidates",
            second,
        ]);
        assert_eq!(created["exit"], 0, "{created}");
        assert_eq!(created["evidence"]["selection"]["issues"], json!([1, 2, 3]));
        assert_eq!(f.state()["issues"][0], before);
        assert_eq!(f.state()["issues"][1]["title"], "fix: distinct work");
        assert_eq!(f.state()["issues"][2]["title"], "docs: separate work");
    }
}

#[test]
fn candidate_review_is_invalidated_by_native_or_proposed_content_changes() {
    for provider in ["github", "gitlab"] {
        let f = Fixture::new(provider);
        assert_eq!(
            f.run(&["issue", "feat: original", "--create-labels"])["exit"],
            0
        );
        // A new local selection sees the pre-existing native issue as a candidate.
        fs::remove_file(f.root.join(".git/specgit-v2/selection.json")).unwrap();
        let preview = f.run(&["issue", "fix: distinct work", "--inspect"]);
        let review = preview["evidence"]["candidates"][0]["review_digest"]
            .as_str()
            .unwrap();
        let writes = f.writes();
        let body = f.root.join("distinct.md");
        fs::write(&body, "A different specification body").unwrap();
        let changed_spec = f.run(&[
            "issue",
            "fix: distinct work",
            "--body-file",
            body.to_str().unwrap(),
            "--create-labels",
            "--reviewed-candidates",
            review,
        ]);
        assert_eq!(
            changed_spec["status"], "candidate_review_required",
            "{changed_spec}"
        );
        assert_eq!(f.writes(), writes);
        f.edit(|s| {
            s["issues"][0][if provider == "github" {
                "body"
            } else {
                "description"
            }] = json!("Changed WHY");
        });
        let changed_native = f.run(&[
            "issue",
            "fix: distinct work",
            "--create-labels",
            "--reviewed-candidates",
            review,
        ]);
        assert_eq!(
            changed_native["status"], "candidate_review_required",
            "{changed_native}"
        );
        assert_ne!(changed_native["evidence"]["review_digest"], review);
        assert_eq!(f.writes(), writes);
        let current_review = changed_native["evidence"]["review_digest"]
            .as_str()
            .unwrap();
        f.edit(|s| {
            let mut new_candidate = s["issues"][0].clone();
            new_candidate[if provider == "github" {
                "number"
            } else {
                "iid"
            }] = json!(2);
            new_candidate["title"] = json!("fix: another author's recent issue");
            s["issues"].as_array_mut().unwrap().push(new_candidate);
        });
        let added = f.run(&[
            "issue",
            "fix: distinct work",
            "--create-labels",
            "--reviewed-candidates",
            current_review,
        ]);
        assert_eq!(added["status"], "candidate_review_required", "{added}");
        assert_eq!(f.writes(), writes);
        f.edit(|s| s["issues"] = json!([]));
        // Even an empty search cannot silently consume a stale supplied review.
        let removed = f.run(&[
            "issue",
            "fix: distinct work",
            "--create-labels",
            "--reviewed-candidates",
            review,
        ]);
        assert_ne!(removed["exit"], 0, "{removed}");
        assert_eq!(removed["diagnostics"][0]["operation"], "issue_candidates");
        assert_eq!(f.writes(), writes);
    }
}
#[test]
fn resumed_unwritten_intents_recheck_new_duplicates_and_current_policy_before_any_write() {
    let f = Fixture::new("github");
    f.edit(|s| s["deny_label"] = json!(true));
    assert_eq!(
        f.run(&["issue", "--create-labels", "fix: resumed work"])["exit"],
        3
    );
    f.edit(|s| {
        s["deny_label"] = json!(false);
        s["issues"] = json!([{"number":1,"title":"fix: resumed work","body":"Created by another author","labels":[{"name":"kind::fix"}],"state":"open","updated_at":"2026-09-09T00:00:00Z"}]);
    });
    let writes = f.writes();
    let r = f.run(&["issue", "--create-labels", "fix: resumed work"]);
    assert_eq!(r["status"], "candidate_review_required", "{r}");
    assert_eq!(f.writes(), writes);

    let f = Fixture::new("github");
    f.edit(|s| s["lose_issue_response"] = json!(true));
    assert_eq!(
        f.run(&["issue", "--create-labels", "fix: first", "feat: pending"])["exit"],
        3
    );
    fs::write(f.root.join(".specgit.yaml"), "version: 2\nremote: origin\nprovider: github\nvalidation:\n  labels: project\ntags:\n  - name: kind::fix\n    color: D93F0B\n").unwrap();
    let writes = f.writes();
    let r = f.run(&["issue", "--create-labels", "1"]);
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
    let r = f.run(&[
        "issue",
        "--create-labels",
        "feat: inspect",
        "--branch",
        "new-delivery",
    ]);
    assert_eq!(r["exit"], 0, "{r}");
    assert_eq!(r["evidence"]["selection"]["branch"], "new-delivery");
    fs::write(f.root.join("user.txt"), "uncommitted").unwrap();
    let r = f.run(&[
        "issue",
        "--create-labels",
        "feat: another",
        "--branch",
        "another",
    ]);
    assert_eq!(r["exit"], 2, "{r}");
    assert_eq!(
        fs::read_to_string(f.root.join("user.txt")).unwrap(),
        "uncommitted"
    );
}

#[test]
fn missing_labels_need_explicit_choice_and_dry_run_leaves_no_local_state() {
    for provider in ["github", "gitlab"] {
        let f = Fixture::new(provider);
        let r = f.run(&["issue", "feat: preview"]);
        assert_eq!(r["exit"], 2, "{r}");
        assert_eq!(r["effects"]["outcome"], "not_applied");
        assert_eq!(f.writes(), 0);
        assert!(!f.root.join(".git/specgit-v2").exists());
        let r = f.run(&["issue", "feat: preview", "--dry-run", "--create-labels"]);
        assert_eq!(r["exit"], 0, "{r}");
        assert_eq!(r["effects"]["outcome"], "not_applied");
        assert_eq!(f.writes(), 0);
        assert!(!f.root.join(".git/specgit-v2").exists());
    }
}

#[test]
fn resuming_an_already_selected_issue_does_not_consume_another_pending_spec() {
    for provider in ["github", "gitlab"] {
        let f = Fixture::new(provider);
        f.edit(|s| {
            s["labels"] = json!([{"name":"kind::feat","color":"a2eeef"}]);
            s["deny_label"] = json!(true);
        });
        let partial = f.run(&["issue", "--create-labels", "feat: first", "fix: second"]);
        assert_eq!(partial["exit"], 3, "{partial}");
        assert_eq!(f.state()["issues"].as_array().unwrap().len(), 1);
        f.edit(|s| s["deny_label"] = json!(false));
        let selection_path = f.root.join(".git/specgit-v2/selection.json");
        let before = fs::read(&selection_path).unwrap();
        let preview = f.run(&["issue", "1", "--dry-run", "--create-labels"]);
        assert_eq!(preview["exit"], 0, "{preview}");
        let intents = &preview["evidence"]["selection"]["intents"];
        assert_eq!(intents[0]["issue"], 1);
        assert!(intents[1]["issue"].is_null(), "{preview}");
        assert_eq!(preview["evidence"]["missing_labels"], json!(["kind::fix"]));
        let writes = f.writes();
        // The deliberately broad fixture search returns the first spec as a
        // candidate. Review must remain required; adopting its already-bound
        // ID must not silently resolve the second independent spec.
        let resumed = f.run(&["issue", "1", "--create-labels"]);
        assert_eq!(resumed["exit"], 3, "{resumed}");
        assert_eq!(resumed["status"], "candidate_review_required");
        assert_eq!(resumed["effects"]["outcome"], "not_applied");
        assert_eq!(fs::read(&selection_path).unwrap(), before);
        assert_eq!(f.writes(), writes);
        assert_eq!(f.state()["issues"].as_array().unwrap().len(), 1);
    }
}

#[test]
fn resumed_dry_run_previews_all_pending_specs_and_labels_without_saving() {
    for provider in ["github", "gitlab"] {
        let f = Fixture::new(provider);
        f.edit(|s| {
            s["labels"] = json!([{"name":"kind::feat","color":"a2eeef"}]);
            s["deny_label"] = json!(true);
        });
        let partial = f.run(&[
            "issue",
            "--create-labels",
            "feat: first",
            "fix: pending fix",
            "docs: pending docs",
        ]);
        assert_eq!(partial["exit"], 3, "{partial}");
        let selection_path = f.root.join(".git/specgit-v2/selection.json");
        let before = fs::read(&selection_path).unwrap();
        let writes = f.writes();
        let preview = f.run(&["issue", "1", "--dry-run", "--create-labels"]);
        assert_eq!(preview["exit"], 0, "{preview}");
        assert_eq!(preview["effects"]["outcome"], "not_applied");
        let pending: Vec<_> = preview["evidence"]["prepared"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|i| i["issue"].is_null())
            .map(|i| i["title"].as_str().unwrap())
            .collect();
        assert_eq!(pending, ["fix: pending fix", "docs: pending docs"]);
        assert_eq!(
            preview["evidence"]["missing_labels"],
            json!(["kind::docs", "kind::fix"])
        );
        assert_eq!(fs::read(&selection_path).unwrap(), before);
        assert_eq!(f.writes(), writes);
    }
}
