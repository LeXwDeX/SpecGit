#![cfg(feature = "test-fixtures")]
#[path = "support/delivery.rs"]
mod delivery;
use delivery::Fixture;
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

fn git(root: &Path, args: &[&str]) {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn files_below(root: &Path) -> Vec<PathBuf> {
    fn visit(base: &Path, current: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(current) else {
            return;
        };
        for entry in entries {
            let path = entry.unwrap().path();
            if path.is_dir() {
                visit(base, &path, out);
            } else {
                out.push(path.strip_prefix(base).unwrap().to_path_buf());
            }
        }
    }
    let mut out = vec![];
    visit(root, root, &mut out);
    out.sort();
    out
}

fn checkpoint_path(f: &Fixture) -> PathBuf {
    f.root.join(".git/specgit-v2/selection.json")
}

fn assert_foreign_checkpoint(report: &serde_json::Value, recorded: &str, current: &str) {
    let checkpoint = &report["evidence"]["checkpoint"];
    assert_eq!(checkpoint["status"], "branch_mismatch", "{report}");
    assert_eq!(checkpoint["recorded_branch"], recorded, "{report}");
    assert_eq!(checkpoint["current_branch"], current, "{report}");
    assert_eq!(checkpoint["recorded_target"], "main", "{report}");
    assert_eq!(checkpoint["recorded_project_id"], 7, "{report}");
    assert_eq!(checkpoint["pending_write"], false, "{report}");
    assert_eq!(report["evidence"]["write_eligible"], false, "{report}");
}

#[test]
fn foreign_branch_reads_are_diagnostic_and_do_not_touch_the_original_checkpoint() {
    for provider in ["github", "gitlab"] {
        let f = Fixture::new(provider);
        let selected = f.run(&["issue", "--create-labels", "feat: branch A work"]);
        assert_eq!(selected["exit"], 0, "{selected}");
        let checkpoint = checkpoint_path(&f);
        let before_checkpoint = fs::read(&checkpoint).unwrap();
        let before_files = files_below(&f.root.join(".git/specgit-v2"));

        git(&f.root, &["switch", "-c", "branch-b"]);
        let writes = f.writes();
        let calls = f.state()["calls"].as_array().unwrap().len();

        let status = f.run(&["status"]);
        assert_eq!(status["exit"], 0, "{status}");
        assert_eq!(status["status"], "checkpoint_branch_mismatch", "{status}");
        assert!(status["evidence"]["selection"].is_null(), "{status}");
        assert_foreign_checkpoint(&status, "feature", "branch-b");

        let inspect = f.run(&["issue", "fix: branch B inspection", "--inspect"]);
        assert_eq!(inspect["exit"], 0, "{inspect}");
        assert_eq!(inspect["status"], "prepared_blocked", "{inspect}");
        assert_foreign_checkpoint(&inspect, "feature", "branch-b");
        assert_eq!(inspect["effects"]["outcome"], "not_applied", "{inspect}");
        assert!(
            inspect["evidence"]["prepared"]
                .as_array()
                .unwrap()
                .iter()
                .any(|candidate| candidate["title"] == "fix: branch B inspection"),
            "{inspect}"
        );
        assert!(
            inspect["evidence"]["prepared"]
                .as_array()
                .unwrap()
                .iter()
                .all(|candidate| candidate["title"] != "feat: branch A work"),
            "foreign intents leaked into inspection: {inspect}"
        );
        assert!(
            f.state()["calls"].as_array().unwrap()[calls..]
                .iter()
                .any(|call| {
                    let endpoint = call["endpoint"].as_str().unwrap_or_default();
                    endpoint.starts_with("search/issues?")
                        || (endpoint.contains("/issues?") && endpoint.contains("search="))
                }),
            "inspection must perform a fresh native candidate search"
        );

        let dry_run = f.run(&[
            "issue",
            "docs: branch B preview",
            "--dry-run",
            "--create-labels",
        ]);
        assert_eq!(dry_run["exit"], 0, "{dry_run}");
        assert_eq!(dry_run["status"], "prepared_blocked", "{dry_run}");
        assert_foreign_checkpoint(&dry_run, "feature", "branch-b");
        assert_eq!(dry_run["effects"]["outcome"], "not_applied", "{dry_run}");

        for mutation in [
            vec!["issue", "1"],
            vec!["issue", "--create-labels", "fix: forbidden branch B write"],
            vec!["pr"],
        ] {
            let rejected = f.run(&mutation);
            assert_eq!(rejected["exit"], 3, "{rejected}");
            assert_eq!(rejected["diagnostics"][0]["code"], "ownership_conflict");
            let diagnostic = rejected["diagnostics"][0].to_string();
            assert!(diagnostic.contains("feature"), "{rejected}");
            assert!(diagnostic.contains("branch-b"), "{rejected}");
            assert!(diagnostic.contains("selection.json"), "{rejected}");
        }
        assert_eq!(f.writes(), writes);
        assert_eq!(fs::read(&checkpoint).unwrap(), before_checkpoint);
        assert_eq!(files_below(&f.root.join(".git/specgit-v2")), before_files);

        git(&f.root, &["switch", "feature"]);
        let resumed = f.run(&["status"]);
        assert_eq!(resumed["exit"], 0, "{resumed}");
        assert_eq!(resumed["evidence"]["selection"]["issues"], json!([1]));
    }
}

#[test]
fn foreign_branch_diagnostics_preserve_unresolved_issue_and_request_writes() {
    for pending in ["issue", "request"] {
        let f = Fixture::new("github");
        assert_eq!(
            f.run(&["issue", "--create-labels", "feat: unresolved write"])["exit"],
            0
        );
        let checkpoint = checkpoint_path(&f);
        let mut selection: serde_json::Value =
            serde_json::from_slice(&fs::read(&checkpoint).unwrap()).unwrap();
        if pending == "issue" {
            selection["intents"][0]["issue"] = serde_json::Value::Null;
            selection["intents"][0]["write_started"] = json!(true);
            selection["issues"] = json!([]);
        } else {
            selection["request"] = serde_json::Value::Null;
            selection["request_write_started"] = json!(true);
        }
        fs::write(&checkpoint, serde_json::to_vec_pretty(&selection).unwrap()).unwrap();
        let before = fs::read(&checkpoint).unwrap();
        git(&f.root, &["switch", "-c", "foreign-pending"]);

        let status = f.run(&["status"]);
        assert_eq!(status["exit"], 0, "{status}");
        assert_eq!(
            status["evidence"]["checkpoint"]["pending_write"], true,
            "{status}"
        );
        let inspect = f.run(&["issue", "fix: independent foreign inspection", "--inspect"]);
        assert_eq!(inspect["status"], "prepared_blocked", "{inspect}");
        assert_eq!(inspect["evidence"]["checkpoint"]["pending_write"], true);
        assert!(
            inspect["evidence"]["prepared"]
                .as_array()
                .unwrap()
                .iter()
                .all(|candidate| candidate["title"] != "feat: unresolved write"),
            "{inspect}"
        );
        assert_eq!(fs::read(&checkpoint).unwrap(), before);

        git(&f.root, &["switch", "feature"]);
        let owner = f.run(&["status"]);
        assert_eq!(owner["exit"], 0, "{owner}");
        if pending == "issue" {
            assert_eq!(
                owner["evidence"]["selection"]["intents"][0]["issue"],
                serde_json::Value::Null
            );
            assert_eq!(
                owner["evidence"]["selection"]["intents"][0]["write_started"],
                true
            );
        } else {
            assert_eq!(
                owner["evidence"]["selection"]["request"],
                serde_json::Value::Null
            );
            assert_eq!(
                owner["evidence"]["selection"]["request_write_started"],
                true
            );
        }
        assert_eq!(fs::read(&checkpoint).unwrap(), before);
    }
}

#[test]
fn malformed_or_foreign_repository_checkpoints_remain_rejected() {
    for replacement in [
        json!({"version":2}),
        json!({
            "version": 3,
            "repository": {"provider":"github","host":"forge.example","path":"fixture/repo"},
            "project_id": 7,
            "branch": "feature",
            "target": "main",
            "issues": [],
            "intents": [],
            "request": null,
            "request_write_started": false,
            "request_intent": null
        }),
        json!({
            "version": 2,
            "repository": {"provider":"github","host":"forge.example","path":"somebody-else/repo"},
            "project_id": 7,
            "branch": "feature",
            "target": "main",
            "issues": [],
            "intents": [],
            "request": null,
            "request_write_started": false,
            "request_intent": null
        }),
    ] {
        let f = Fixture::new("github");
        assert_eq!(
            f.run(&["issue", "--create-labels", "feat: establish checkpoint"])["exit"],
            0
        );
        let checkpoint = checkpoint_path(&f);
        fs::write(
            &checkpoint,
            serde_json::to_vec_pretty(&replacement).unwrap(),
        )
        .unwrap();
        let before = fs::read(&checkpoint).unwrap();
        let writes = f.writes();
        git(&f.root, &["switch", "-c", "other-branch"]);
        for command in [
            vec!["status"],
            vec!["issue", "fix: must not degrade", "--inspect"],
            vec![
                "issue",
                "fix: must not degrade",
                "--dry-run",
                "--create-labels",
            ],
        ] {
            let rejected = f.run(&command);
            assert_eq!(rejected["exit"], 3, "{rejected}");
            assert_eq!(rejected["diagnostics"][0]["code"], "ownership_conflict");
        }
        assert_eq!(fs::read(&checkpoint).unwrap(), before);
        assert_eq!(f.writes(), writes);
    }
}

#[test]
fn detached_head_can_diagnose_a_foreign_checkpoint_but_cannot_mutate_it() {
    let f = Fixture::new("github");
    assert_eq!(
        f.run(&["issue", "--create-labels", "feat: owner"])["exit"],
        0
    );
    let checkpoint = checkpoint_path(&f);
    let before = fs::read(&checkpoint).unwrap();
    git(&f.root, &["switch", "--detach"]);
    let status = f.run(&["status"]);
    assert_eq!(status["exit"], 0, "{status}");
    assert_eq!(status["status"], "checkpoint_branch_mismatch", "{status}");
    assert_eq!(
        status["evidence"]["checkpoint"]["recorded_branch"],
        "feature"
    );
    assert!(status["evidence"]["checkpoint"]["current_branch"].is_null());
    let rejected = f.run(&["issue", "1"]);
    assert_eq!(rejected["exit"], 2, "{rejected}");
    assert_eq!(rejected["diagnostics"][0]["code"], "invalid_input");
    assert_eq!(fs::read(&checkpoint).unwrap(), before);
}

#[test]
fn linked_worktree_has_an_independent_checkpoint_namespace() {
    let mut f = Fixture::new("github");
    assert_eq!(
        f.run(&["issue", "--create-labels", "feat: primary worktree"])["exit"],
        0
    );
    let primary_root = f.root.clone();
    let primary_checkpoint = checkpoint_path(&f);
    let primary_before = fs::read(&primary_checkpoint).unwrap();
    let linked = primary_root.parent().unwrap().join("linked");
    git(
        &primary_root,
        &["worktree", "add", "-b", "linked-branch", "../linked"],
    );
    f.root = linked;

    let status = f.run(&["status"]);
    assert_eq!(status["exit"], 0, "{status}");
    assert!(status["evidence"]["selection"].is_null(), "{status}");
    let inspect = f.run(&["issue", "fix: linked inspection", "--inspect"]);
    assert_eq!(inspect["exit"], 0, "{inspect}");
    assert_ne!(inspect["status"], "prepared_blocked", "{inspect}");
    assert!(
        inspect["evidence"]["prepared"]
            .as_array()
            .unwrap()
            .iter()
            .any(|candidate| candidate["title"] == "fix: linked inspection"),
        "{inspect}"
    );
    assert_eq!(fs::read(&primary_checkpoint).unwrap(), primary_before);
    assert!(!checkpoint_path(&f).exists());
}
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
