#![cfg(feature = "test-fixtures")]
#[path = "support/acceptance.rs"]
mod acceptance;
#[path = "support/delivery.rs"]
mod delivery;
use acceptance::fixture;
use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
const STAMP: &str = "2026-09-09T00:00:00Z";
fn git(f: &delivery::Fixture, args: &[&str]) {
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
fn complete_request(f: &delivery::Fixture, provider: &str) {
    f.edit(|s| {
        s["native_closing"] = json!([1]);
        s["requests"][0]["state"] = json!(if provider == "github" {
            "closed"
        } else {
            "merged"
        });
        s["requests"][0]["merged"] = json!(true);
        s["issues"][0]["state"] = json!("closed");
    });
}
/// The mock uses the GitLab API field shape documented for list merge requests,
/// including the valid transitional `state: "locked"` value:
/// https://docs.gitlab.com/api/merge_requests/#list-merge-requests
/// No live GitLab transition was captured; this is fixture evidence only.
#[test]
fn gitlab_locked_state_is_transient_unknown_and_preserves_verified_identity() {
    let f = fixture("gitlab");
    f.edit(|s| {
        s["requests"][0]["state"] = json!("locked");
        s["requests"][0]["merged"] = json!(true);
        s["requests"][0]["merged_at"] = json!(STAMP);
        s["requests"][0]["discussion_locked"] = json!(true);
        s["issues"][0]["state"] = json!("closed");
    });
    let writes = f.writes();
    let result = f.run(&["pr", "--status"]);
    assert_eq!(result["exit"], 3, "{result}");
    assert_eq!(result["status"], "unknown", "{result}");
    assert_eq!(result["evidence"]["request"]["id"], 41, "{result}");
    assert_eq!(result["evidence"]["request"]["state"], "locked", "{result}");
    assert_eq!(
        result["evidence"]["request"]["source"], "feature",
        "{result}"
    );
    assert_eq!(result["evidence"]["request"]["target"], "main", "{result}");
    assert!(
        result["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "unsupported_operation"
                && diagnostic["operation"] == "request_lifecycle"),
        "{result}"
    );
    assert_eq!(f.writes(), writes);
    let checkpoint: Value =
        serde_json::from_slice(&fs::read(f.root.join(".git/specgit-v2/selection.json")).unwrap())
            .unwrap();
    assert!(
        checkpoint["delivered_request"].is_null(),
        "a locked request never retires the checkpoint: {checkpoint}"
    );
}

#[test]
fn gitlab_discussion_locking_does_not_change_an_open_lifecycle() {
    let f = fixture("gitlab");
    f.edit(|s| {
        s["requests"][0]["state"] = json!("opened");
        s["requests"][0]["discussion_locked"] = json!(true);
    });
    let result = f.run(&["pr", "--status"]);
    assert_eq!(result["exit"], 0, "{result}");
    assert_eq!(result["status"], "open", "{result}");
    assert_eq!(result["evidence"]["request"]["state"], "opened", "{result}");
}

#[test]
fn gitlab_locked_identity_contradiction_stays_unknown_without_transient_claim() {
    let f = fixture("gitlab");
    f.edit(|s| {
        s["requests"][0]["state"] = json!("locked");
        s["requests"][0]["source_project_id"] = json!(8);
        s["requests"][0]["target_project_id"] = json!(8);
    });
    let result = f.run(&["pr", "--status", "--request", "41"]);
    assert_eq!(result["exit"], 3, "{result}");
    assert_eq!(result["status"], "unknown", "{result}");
    assert!(result["evidence"].is_null(), "{result}");
    assert_eq!(
        result["diagnostics"][0]["code"], "identity_mismatch",
        "{result}"
    );
}

#[test]
fn gitlab_locked_incomplete_identity_stays_unknown_without_transient_claim() {
    let f = fixture("gitlab");
    f.edit(|s| {
        s["requests"][0]["state"] = json!("locked");
        s["requests"][0]["sha"] = json!("not-a-sha");
    });
    let result = f.run(&["pr", "--status", "--request", "41"]);
    assert_eq!(result["exit"], 3, "{result}");
    assert_eq!(result["status"], "unknown", "{result}");
    assert!(result["evidence"].is_null(), "{result}");
    assert_eq!(
        result["diagnostics"][0]["code"], "malformed_response",
        "{result}"
    );
}

#[test]
fn both_native_forges_observe_current_head_evidence_without_remote_writes() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider);
        let writes = f.writes();
        let r = f.run(&["pr", "--status"]);
        assert_eq!(r["exit"], 0, "{provider}: {r}");
        assert_eq!(r["status"], "open");
        assert_eq!(r["evidence"]["local_applicability"]["status"], "applicable");
        assert_eq!(r["evidence"]["local_branch"], "feature");
        assert!(!r["evidence"]["checks"].as_array().unwrap().is_empty());
        assert_eq!(f.writes(), writes);
    }
}

#[test]
fn explicit_same_repository_status_survives_local_source_head_and_target_mismatch() {
    let checkouts = [
        ("main", "source_branch_mismatch"),
        ("other", "source_branch_mismatch"),
        ("detached", "detached_head"),
        ("deleted_source", "source_branch_mismatch"),
        ("head_mismatch", "head_mismatch"),
    ];
    for provider in ["github", "gitlab"] {
        for (checkout, expected_reason) in checkouts {
            let f = fixture(provider);
            complete_request(&f, provider);
            match checkout {
                "main" => git(&f, &["switch", "-c", "main"]),
                "other" => git(&f, &["switch", "-c", "experiment"]),
                "detached" => git(&f, &["checkout", "--detach", "HEAD"]),
                "deleted_source" => {
                    git(&f, &["switch", "-c", "main"]);
                    git(&f, &["branch", "-D", "feature"]);
                }
                "head_mismatch" => {
                    fs::write(f.root.join("local-change.txt"), "new local commit").unwrap();
                    git(&f, &["add", "local-change.txt"]);
                    git(&f, &["commit", "-m", "local-only commit"]);
                }
                _ => unreachable!(),
            }
            let writes = f.writes();
            let result = f.run(&["pr", "--status", "--request", "41"]);
            assert_eq!(result["exit"], 0, "{provider}/{checkout}: {result}");
            assert_eq!(
                result["status"], "completed",
                "{provider}/{checkout}: {result}"
            );
            assert_eq!(result["evidence"]["request"]["target"], "main");
            assert_eq!(result["evidence"]["target"], "main");
            assert_eq!(
                result["evidence"]["local_applicability"]["status"], "not_applicable",
                "{provider}/{checkout}: {result}"
            );
            assert!(
                result["evidence"]["local_applicability"]["reasons"]
                    .as_array()
                    .unwrap()
                    .contains(&json!(expected_reason)),
                "{provider}/{checkout}: {result}"
            );
            if checkout != "head_mismatch" {
                assert!(
                    !result["evidence"]["associations"][0]["sources"]
                        .as_array()
                        .unwrap()
                        .contains(&json!("local_selection")),
                    "foreign-branch selection leaked: {provider}/{checkout}: {result}"
                );
            }
            assert_eq!(f.writes(), writes);
        }
    }
}

#[test]
fn explicit_status_reports_native_target_when_local_target_differs() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider);
        complete_request(&f, provider);
        let declaration_path = f.root.join(".specgit.yaml");
        let mut declaration = fs::read_to_string(&declaration_path).unwrap();
        declaration.push_str("target: release\n");
        fs::write(declaration_path, declaration).unwrap();

        let result = f.run(&["pr", "--status", "--request", "41"]);
        assert_eq!(result["exit"], 0, "{provider}: {result}");
        assert_eq!(result["status"], "completed", "{provider}: {result}");
        assert_eq!(result["evidence"]["request"]["target"], "main");
        assert_eq!(result["evidence"]["target"], "release");
        assert_eq!(
            result["evidence"]["local_applicability"]["status"], "not_applicable",
            "{provider}: {result}"
        );
        assert!(
            result["evidence"]["local_applicability"]["reasons"]
                .as_array()
                .unwrap()
                .contains(&json!("target_mismatch"))
        );
        assert!(
            !result["evidence"]["associations"][0]["sources"]
                .as_array()
                .unwrap()
                .contains(&json!("local_selection"))
        );
    }
}

#[test]
fn implicit_status_and_watch_remain_worktree_scoped_after_cross_branch_query_is_added() {
    let f = fixture("github");
    complete_request(&f, "github");
    git(&f, &["switch", "-c", "main"]);
    let writes = f.writes();

    let implicit = f.run(&["pr", "--status"]);
    assert_eq!(implicit["exit"], 3, "{implicit}");
    assert!(implicit["evidence"].is_null());

    let watched = f.run(&[
        "watch",
        "--request",
        "41",
        "--session",
        "session-a",
        "--goal",
        "lifecycle",
        "--once",
    ]);
    assert_eq!(watched["status"], "unknown", "{watched}");
    assert_eq!(watched["evidence"]["events"][0]["state"], "unknown");

    let ready = f.run(&["pr", "--ready"]);
    assert_ne!(ready["exit"], 0, "{ready}");
    assert_eq!(f.writes(), writes);
}

#[test]
fn explicit_status_still_rejects_foreign_native_identity_and_read_denial() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider);
        f.edit(|s| {
            s["requests"][0]["source_project_id"] = json!(8);
            s["requests"][0]["target_project_id"] = json!(8);
            s["requests"][0]["head"]["repo"]["id"] = json!(8);
            s["requests"][0]["base"]["repo"]["id"] = json!(8);
        });
        let foreign = f.run(&["pr", "--status", "--request", "41"]);
        assert_eq!(foreign["exit"], 3, "{provider}: {foreign}");
        assert!(foreign["evidence"].is_null());

        f.edit(|s| s["read_failure"] = json!("auth"));
        let denied = f.run(&["pr", "--status", "--request", "41"]);
        assert_eq!(denied["exit"], 3, "{provider}: {denied}");
        assert!(denied["evidence"].is_null());
    }
}
#[test]
fn unavailable_native_check_queries_preserve_request_but_report_missing_evidence() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider);
        f.edit(|s| {
            s["read_routes"]
                .as_object_mut()
                .unwrap()
                .retain(|route, _| {
                    !route.contains("/check-runs?") && route != "projects/7/pipelines/71"
                });
        });
        let writes = f.writes();
        let r = f.run(&["pr", "--status"]);
        assert_eq!(r["exit"], 3, "{provider}: {r}");
        assert_eq!(r["evidence"]["request"]["id"], 41);
        assert!(r["evidence"]["checks"].is_null());
        assert!(!r["diagnostics"].as_array().unwrap().is_empty());
        assert_eq!(f.writes(), writes);
    }
}
#[test]
fn native_latest_pending_check_is_not_replaced_by_old_actions_green() {
    let f = fixture("github");
    f.edit(|s| {
        for (route, value) in s["read_routes"].as_object_mut().unwrap() {
            if route.contains("/check-runs?filter=latest") {
                value["check_runs"][0]["id"] = json!(82);
                value["check_runs"][0]["status"] = json!("in_progress");
                value["check_runs"][0]["conclusion"] = Value::Null;
                value["check_runs"][0]["completed_at"] = Value::Null;
            }
        }
        s["read_routes"]["repos/fixture/repo/branches/main"]["protected"] = json!(true);
    });
    let writes = f.writes();
    let r = f.run(&["pr", "--status"]);
    assert_eq!(r["exit"], 0, "{r}");
    let checks = r["evidence"]["checks"].as_array().unwrap();
    assert_eq!(checks.len(), 1);
    assert_eq!(checks[0]["id"], 82);
    assert_eq!(checks[0]["status"], "in_progress");
    assert!(checks[0]["workflow_attempt"].is_null());
    assert!(
        f.state()["calls"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|c| c["endpoint"].as_str())
            .all(|route| !route.contains("/actions/") || route.contains("/actions/runs?head_sha="))
    );
    assert_eq!(f.writes(), writes);
}
#[test]
fn github_same_head_uses_latest_run_per_app_and_name_for_status_and_watch() {
    for (old_result, current_result, expected_watch) in [
        ("cancelled", "success", "checks_passed"),
        ("success", "pending", "pending"),
        ("success", "failure", "failed"),
    ] {
        let f = fixture("github");
        f.edit(|s| {
            for (route, value) in s["read_routes"].as_object_mut().unwrap() {
                if !route.contains("/check-runs?filter=latest") {
                    continue;
                }
                let mut old = value["check_runs"][0].clone();
                old["id"] = json!(81);
                old["status"] = json!("completed");
                old["conclusion"] = json!(old_result);
                let mut current = old.clone();
                current["id"] = json!(82);
                current["status"] = json!(if current_result == "pending" {
                    "in_progress"
                } else {
                    "completed"
                });
                current["conclusion"] = if current_result == "pending" {
                    Value::Null
                } else {
                    json!(current_result)
                };
                current["completed_at"] = if current_result == "pending" {
                    Value::Null
                } else {
                    json!(STAMP)
                };
                value["check_runs"] = json!([old, current]);
                value["total_count"] = json!(2);
            }
        });
        let writes = f.writes();
        let status = f.run(&["pr", "--status"]);
        assert_eq!(status["exit"], 0, "{status}");
        let checks = status["evidence"]["checks"].as_array().unwrap();
        assert_eq!(checks.len(), 1, "{status}");
        assert_eq!(checks[0]["id"], 82, "{status}");
        let watched = f.run(&[
            "watch",
            "--request",
            "41",
            "--session",
            "latest-runs",
            "--goal",
            "checks",
            "--once",
        ]);
        assert_eq!(watched["status"], expected_watch, "{watched}");
        let inbox = f.run(&[
            "inbox",
            "--request",
            "41",
            "--session",
            "latest-runs",
            "--goal",
            "checks",
        ]);
        assert_eq!(inbox["status"], expected_watch, "{inbox}");
        assert_eq!(f.writes(), writes);
    }
}
#[test]
fn github_same_named_checks_from_different_apps_remain_distinct() {
    let f = fixture("github");
    f.edit(|s| {
        for (route, value) in s["read_routes"].as_object_mut().unwrap() {
            if !route.contains("/check-runs?filter=latest") {
                continue;
            }
            let mut other = value["check_runs"][0].clone();
            other["id"] = json!(82);
            other["app"]["id"] = json!(99);
            value["check_runs"].as_array_mut().unwrap().push(other);
            value["total_count"] = json!(2);
        }
    });
    let result = f.run(&["pr", "--status"]);
    let checks = result["evidence"]["checks"].as_array().unwrap();
    assert_eq!(checks.len(), 2, "{result}");
    assert_ne!(checks[0]["app"], checks[1]["app"], "{result}");
}
#[test]
fn github_same_named_checks_from_different_suites_remain_distinct() {
    let f = fixture("github");
    f.edit(|s| {
        for (route, value) in s["read_routes"].as_object_mut().unwrap() {
            if !route.contains("/check-runs?filter=latest") {
                continue;
            }
            let mut other = value["check_runs"][0].clone();
            other["id"] = json!(82);
            other["check_suite"]["id"] = json!(102);
            other["status"] = json!("completed");
            other["conclusion"] = json!("failure");
            value["check_runs"].as_array_mut().unwrap().push(other);
            value["total_count"] = json!(2);
        }
    });
    let result = f.run(&["pr", "--status"]);
    let checks = result["evidence"]["checks"].as_array().unwrap();
    assert_eq!(checks.len(), 2, "{result}");
    assert!(checks.iter().any(|check| check["conclusion"] == "failure"));
}
#[test]
fn complete_requires_native_merge_and_every_referenced_issue_closed() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider);
        f.edit(|s| {
            s["requests"][0]["state"] = json!(if provider == "github" {
                "closed"
            } else {
                "merged"
            });
            s["requests"][0]["merged"] = json!(true);
        });
        let r = f.run(&["pr", "--status"]);
        assert_eq!(r["status"], "merged_issues_open", "{r}");
        f.edit(|s| s["issues"][0]["state"] = json!("closed"));
        let writes = f.writes();
        let r = f.run(&["pr", "--status"]);
        assert_eq!(r["status"], "completed", "{r}");
        assert_eq!(r["exit"], 0, "{r}");
        assert_eq!(f.writes(), writes);
    }
}
#[test]
fn native_edits_and_stale_head_pipeline_remain_unavailable() {
    let f = fixture("github");
    f.edit(|s| {
        s["request_reads"] = json!(0);
        s["edit_request_on_read"] = json!(2);
    });
    let writes = f.writes();
    let r = f.run(&["pr", "--status"]);
    assert_eq!(r["exit"], 3, "{r}");
    assert_eq!(f.writes(), writes);
    let f = fixture("gitlab");
    f.edit(|s| s["requests"][0]["head_pipeline"]["sha"] = json!("f".repeat(40)));
    let r = f.run(&["pr", "--status"]);
    assert_eq!(r["exit"], 3, "{r}");
}
#[test]
fn incomplete_pages_duplicate_ids_and_malformed_current_checks_remain_unavailable() {
    for fault in [
        "truncated_checks",
        "duplicate_id",
        "stale_head",
        "zero_app",
        "unknown_status",
    ] {
        let f = fixture("github");
        f.edit(|s| {
            for (route, value) in s["read_routes"].as_object_mut().unwrap() {
                if !route.contains("/check-runs?") {
                    continue;
                }
                match fault {
                    "truncated_checks" => value["total_count"] = json!(2),
                    "duplicate_id" => {
                        let row = value["check_runs"][0].clone();
                        value["check_runs"].as_array_mut().unwrap().push(row);
                        value["total_count"] = json!(2);
                    }
                    "stale_head" => value["check_runs"][0]["head_sha"] = json!("f".repeat(40)),
                    "zero_app" => value["check_runs"][0]["app"]["id"] = json!(0),
                    "unknown_status" => value["check_runs"][0]["status"] = json!("mystery"),
                    _ => unreachable!(),
                }
            }
        });
        let writes = f.writes();
        let r = f.run(&["pr", "--status"]);
        assert_eq!(r["exit"], 3, "{fault}: {r}");
        assert_eq!(f.writes(), writes);
    }
}
#[test]
fn current_checks_require_complete_consistent_pages() {
    for second_page in ["complete", "missing", "changed_count", "duplicate_id"] {
        let f = fixture("github");
        f.edit(|s| {
            let routes = s["read_routes"].as_object_mut().unwrap();
            let first = routes
                .keys()
                .find(|r| r.contains("/check-runs?filter=latest"))
                .unwrap()
                .clone();
            let template = routes[&first]["check_runs"][0].clone();
            let rows: Vec<_> = (1..=100)
                .map(|id| {
                    let mut row = template.clone();
                    row["id"] = json!(id);
                    row["name"] = json!(format!("Test {id}"));
                    row
                })
                .collect();
            routes.insert(first.clone(), json!({"total_count":101,"check_runs":rows}));
            if second_page != "missing" {
                let mut final_row = template;
                final_row["id"] = json!(if second_page == "duplicate_id" {
                    1
                } else {
                    101
                });
                final_row["name"] = json!("Test 101");
                routes.insert(
                    first.replace("&page=1", "&page=2"),
                    json!({
                        "total_count":if second_page == "changed_count" { 102 } else { 101 },
                        "check_runs":[final_row]
                    }),
                );
            }
        });
        let r = f.run(&["pr", "--status"]);
        assert_eq!(
            r["exit"],
            if second_page == "complete" { 0 } else { 3 },
            "{second_page}: {r}"
        );
        if second_page == "complete" {
            assert_eq!(r["evidence"]["checks"].as_array().unwrap().len(), 101);
        }
    }
}
#[test]
fn native_settings_are_not_exposed_and_dirty_worktree_does_not_impose_acceptance() {
    let f = fixture("gitlab");
    f.edit(|s| {
        s["project"]["runners_token"] = json!("PRIVATE_FIXTURE_TOKEN");
        s["read_routes"]["projects/fixture%2Frepo/merge_requests/41/approvals"] =
            json!({"approvals_required":1,"approvals_left":1});
    });
    let r = f.run(&["pr", "--status"]);
    assert_eq!(r["exit"], 0, "{r}");
    assert!(!r.to_string().contains("PRIVATE_FIXTURE_TOKEN"));
    let f = fixture("github");
    fs::write(f.root.join("uncommitted.txt"), "work in progress").unwrap();
    let r = f.run(&["pr", "--status"]);
    assert_eq!(r["exit"], 0, "{r}");
    assert_eq!(r["status"], "open");
}
#[test]
fn native_head_pipeline_failure_is_reported_without_job_or_downstream_reads() {
    let f = fixture("gitlab");
    f.edit(|s| {
        s["read_routes"]["projects/7/pipelines/71"]["status"] = json!("failed");
        s["read_routes"]
            .as_object_mut()
            .unwrap()
            .retain(|route, _| !route.contains("/jobs?") && !route.contains("/trigger_jobs?"));
    });
    let r = f.run(&["pr", "--status"]);
    assert_eq!(r["exit"], 0, "{r}");
    let checks = r["evidence"]["checks"].as_array().unwrap();
    assert_eq!(checks.len(), 1);
    assert_eq!(checks[0]["pipeline"], 71);
    assert_eq!(checks[0]["conclusion"], "failure");
    assert!(
        f.state()["calls"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|c| c["endpoint"].as_str())
            .all(|route| !route.contains("/jobs?") && !route.contains("/trigger_jobs?"))
    );
}

#[test]
fn removed_selected_associations_are_reported_and_prevent_completion() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider);
        f.edit(|s| {
            let mut issue = s["issues"][0].clone();
            issue["number"] = json!(2);
            issue["iid"] = json!(2);
            issue["id"] = json!(102);
            issue["state"] = json!("closed");
            s["issues"].as_array_mut().unwrap().push(issue);
        });
        let path = f.root.join(".git/specgit-v2/selection.json");
        let mut selected: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        selected["issues"] = json!([1, 2]);
        fs::write(path, selected.to_string()).unwrap();
        let r = f.run(&["pr", "--status"]);
        assert_eq!(r["exit"], 0, "{r}");
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
        let r = f.run(&["pr", "--status"]);
        assert_eq!(r["exit"], 0, "{r}");
        assert_ne!(r["status"], "completed");
        assert_eq!(r["evidence"]["association_discrepancies"], json!([2]));
        assert_eq!(f.writes(), writes);
    }
}
#[test]
fn missing_pipeline_identity_is_unknown_but_explicit_null_is_unobserved() {
    for fault in ["null", "missing", "wrong_id", "wrong_project", "stale_head"] {
        let f = fixture("gitlab");
        f.edit(|s| match fault {
            "null" => s["requests"][0]["head_pipeline"] = Value::Null,
            "missing" => {
                s["requests"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("head_pipeline");
            }
            "wrong_id" => s["read_routes"]["projects/7/pipelines/71"]["id"] = json!(72),
            "wrong_project" => s["read_routes"]["projects/7/pipelines/71"]["project_id"] = json!(8),
            "stale_head" => {
                s["read_routes"]["projects/7/pipelines/71"]["sha"] = json!("f".repeat(40))
            }
            _ => unreachable!(),
        });
        let r = f.run(&["pr", "--status"]);
        assert_eq!(
            r["exit"],
            if fault == "null" { 0 } else { 3 },
            "{fault}: {r}"
        );
        if fault == "null" {
            assert_eq!(r["evidence"]["checks"], json!([]));
        }
    }
}

#[test]
fn native_commit_status_context_uses_latest_id_and_rejects_duplicate_objects() {
    for duplicate in [false, true] {
        let f = fixture("github");
        f.edit(|s| {
            for (route, value) in s["read_routes"].as_object_mut().unwrap() {
                if route.contains("/statuses?") {
                    *value = json!([
                        {"id":201,"context":"deploy","state":"success","created_at":STAMP,"updated_at":STAMP},
                        {"id":if duplicate { 201 } else { 202 },"context":"deploy","state":"pending","created_at":STAMP,"updated_at":STAMP}
                    ]);
                }
            }
        });
        let r = f.run(&["pr", "--status"]);
        assert_eq!(r["exit"], if duplicate { 3 } else { 0 }, "{r}");
        if !duplicate {
            let statuses: Vec<_> = r["evidence"]["checks"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|c| c["source"] == "status")
                .collect();
            assert_eq!(statuses.len(), 1);
            assert_eq!(statuses[0]["id"], 202);
            assert_eq!(statuses[0]["status"], "in_progress");
        }
    }
}

#[test]
fn explicit_request_change_does_not_inherit_previous_request_selected_issues() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider);
        f.edit(|s| {
            let mut newer = s["requests"][0].clone();
            newer["number"] = json!(42);
            newer["iid"] = json!(42);
            newer["id"] = json!(42);
            newer["body"] = json!("New independent request without closing references");
            newer["description"] = newer["body"].clone();
            s["requests"].as_array_mut().unwrap().push(newer);
        });
        let writes = f.writes();
        let r = f.run(&["pr", "--status", "--request", "42"]);
        assert_eq!(r["exit"], 0, "{provider}: {r}");
        assert_eq!(r["evidence"]["request"]["id"], 42);
        assert_eq!(r["evidence"]["issues"], json!([]), "{provider}: {r}");
        assert_eq!(r["evidence"]["association_discrepancies"], json!([]));
        assert_eq!(f.writes(), writes);
    }
}

#[test]
fn associations_preserve_each_source_and_native_unavailability() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider);
        f.edit(|s| {
            for id in [2, 3] {
                let mut issue = s["issues"][0].clone();
                issue["number"] = json!(id);
                issue["iid"] = json!(id);
                issue["id"] = json!(100 + id);
                s["issues"].as_array_mut().unwrap().push(issue);
            }
            s["native_closing"] = json!([1, 2]);
        });
        let path = f.root.join(".git/specgit-v2/selection.json");
        let mut selected: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        selected["issues"] = json!([1, 3]);
        fs::write(&path, selected.to_string()).unwrap();
        let writes = f.writes();
        let r = f.run(&["pr", "--status"]);
        assert_eq!(r["exit"], 0, "{provider}: {r}");
        assert_eq!(r["evidence"]["native_closing_available"], true);
        assert_eq!(
            r["evidence"]["associations"],
            json!([
                {"issue":1,"sources":["native_closing","body_reference","local_selection"]},
                {"issue":2,"sources":["native_closing"]},
                {"issue":3,"sources":["local_selection"]}
            ])
        );
        assert!(r["evidence"].get("association_source").is_none());
        f.edit(|s| s["native_closing_failure"] = json!("forbidden"));
        let r = f.run(&["pr", "--status"]);
        assert_eq!(r["exit"], 3, "{provider}: {r}");
        assert_eq!(r["evidence"]["native_closing_available"], false);
        assert_eq!(
            r["evidence"]["associations"],
            json!([
                {"issue":1,"sources":["body_reference","local_selection"]},
                {"issue":3,"sources":["local_selection"]}
            ])
        );
        assert_eq!(f.writes(), writes);
    }
}
#[test]
fn native_association_changes_during_observation_are_not_a_stable_snapshot() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider);
        f.edit(|s| {
            s["native_closing"] = json!([1]);
            s["native_closing_on_read"] = json!(2);
            s["native_closing_changed"] = json!([]);
        });
        let writes = f.writes();
        let r = f.run(&["pr", "--status"]);
        assert_eq!(r["exit"], 3, "{provider}: {r}");
        assert_eq!(r["diagnostics"][0]["code"], "concurrent_edit", "{r}");
        assert_eq!(f.writes(), writes);
    }
}

#[test]
fn explicit_request_ignores_unrelated_old_selection_target() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider);
        let path = f.root.join(".git/specgit-v2/selection.json");
        let mut selected: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        selected["request"] = json!(40);
        selected["target"] = json!("release");
        fs::write(&path, selected.to_string()).unwrap();
        let r = f.run(&["pr", "--status", "--request", "41"]);
        assert_eq!(r["exit"], 0, "{provider}: {r}");
        assert_eq!(
            r["evidence"]["associations"],
            json!([{"issue":1,"sources":["body_reference"]}])
        );
    }
}
#[test]
fn unavailable_native_associations_cannot_report_complete_from_body_issues() {
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
        let r = f.run(&["pr", "--status"]);
        assert_eq!(r["exit"], 3, "{provider}: {r}");
        assert_ne!(r["status"], "completed", "{r}");
    }
}

#[test]
fn native_association_confirms_selected_issue_without_body_closing_syntax() {
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
        let r = f.run(&["pr", "--status"]);
        assert_eq!(r["exit"], 0, "{provider}: {r}");
        assert_eq!(
            r["evidence"]["associations"],
            json!([{"issue":1,"sources":["native_closing","local_selection"]}])
        );
        assert_eq!(r["evidence"]["association_discrepancies"], json!([]));
        assert_eq!(r["status"], "completed", "{r}");
        assert_eq!(f.writes(), writes);
    }
}

#[test]
fn malformed_body_references_keep_native_observation_evidence_and_diagnostics() {
    let unsupported_bodies = [
        "- Closes #1",
        "The change closes #1 inline",
        "Closes #1, #2",
        "Resolves https://github.com/fixture/repo/issues/1",
        "Closes fixture/repo#1",
    ];
    for provider in ["github", "gitlab"] {
        for body in unsupported_bodies {
            let f = fixture(provider);
            f.edit(|s| {
                s["native_closing"] = json!([1]);
                s["requests"][0]["state"] = json!(if provider == "github" {
                    "closed"
                } else {
                    "merged"
                });
                s["requests"][0]["merged"] = json!(true);
                s["requests"][0][if provider == "github" {
                    "body"
                } else {
                    "description"
                }] = json!(body);
                s["issues"][0]["state"] = json!("closed");
            });
            let writes = f.writes();
            let result = f.run(&["pr", "--status", "--request", "41"]);
            assert_eq!(
                result["evidence"]["request"]["id"], 41,
                "{provider}: {body}: {result}"
            );
            assert_eq!(
                result["evidence"]["native_closing_available"], true,
                "{provider}: {body}: {result}"
            );
            assert_eq!(
                result["evidence"]["associations"],
                json!([{"issue":1,"sources":["native_closing","local_selection"]}]),
                "{provider}: {body}: {result}"
            );
            assert_eq!(result["evidence"]["issues"][0]["state"], "closed");
            assert_eq!(
                result["status"], "completed",
                "{provider}: {body}: {result}"
            );
            assert_eq!(result["exit"], 2, "{provider}: {body}: {result}");
            assert!(
                result["diagnostics"].as_array().is_some_and(|diagnostics| {
                    diagnostics
                        .iter()
                        .any(|diagnostic| diagnostic["code"] == "invalid_input")
                }),
                "{provider}: {body}: {result}"
            );
            assert_eq!(f.writes(), writes);
        }
    }
}

fn replacement_workflow(
    f: &delivery::Fixture,
    context: Option<(&str, Value)>,
    with_checks: bool,
    running: bool,
) {
    f.edit(|s| {
        for (route, value) in s["read_routes"].as_object_mut().unwrap() {
            if route.contains("/actions/runs?head_sha=") {
                let mut next = value["workflow_runs"][0].clone();
                next["id"] = json!(72);
                next["check_suite_id"] = json!(102);
                if let Some((field, replacement)) = &context {
                    next[*field] = replacement.clone();
                }
                if running {
                    next["status"] = json!("in_progress");
                    next["conclusion"] = Value::Null;
                }
                value["workflow_runs"][0]["conclusion"] = json!("cancelled");
                value["workflow_runs"].as_array_mut().unwrap().push(next);
                value["total_count"] = json!(2);
            } else if route.contains("/check-runs?filter=latest") {
                let mut next = value["check_runs"][0].clone();
                next["id"] = json!(82);
                next["check_suite"]["id"] = json!(102);
                value["check_runs"][0]["conclusion"] = json!("failure");
                if with_checks {
                    value["check_runs"].as_array_mut().unwrap().push(next);
                    value["total_count"] = json!(2);
                }
            }
        }
    });
}

#[test]
fn github_superseded_workflow_suite_cannot_poison_current_results() {
    let f = fixture("github");
    replacement_workflow(&f, None, true, false);
    let r = f.run(&["pr", "--status"]);
    assert_eq!(r["exit"], 0, "{r}");
    let checks = r["evidence"]["checks"].as_array().unwrap();
    assert_eq!(checks.len(), 1, "{r}");
    assert_eq!(checks[0]["id"], 82);
    assert_eq!(checks[0]["conclusion"], "success");
}

#[test]
fn github_workflow_supersession_preserves_independent_contexts() {
    for context in [
        ("workflow_id", json!(2)),
        ("event", json!("push")),
        ("head_branch", json!("another-feature")),
        ("pull_requests", json!([{ "number": 42 }])),
    ] {
        let f = fixture("github");
        replacement_workflow(&f, Some(context), true, false);
        let r = f.run(&["pr", "--status"]);
        assert_eq!(r["exit"], 0, "{r}");
        let checks = r["evidence"]["checks"].as_array().unwrap();
        assert!(
            checks
                .iter()
                .any(|c| c["id"] == 81 && c["conclusion"] == "failure"),
            "{r}"
        );
        assert!(checks.iter().any(|c| c["id"] == 82), "{r}");
    }
}

fn workflow_runs_mut(f: &delivery::Fixture, edit: impl Fn(&mut Value)) {
    f.edit(|s| {
        for (route, value) in s["read_routes"].as_object_mut().unwrap() {
            if route.contains("/actions/runs?head_sha=") {
                for run in value["workflow_runs"].as_array_mut().unwrap() {
                    edit(run);
                }
            }
        }
    });
}

#[test]
fn github_nullable_workflow_branch_preserves_successful_current_checks() {
    let f = fixture("github");
    // GitHub's workflow-run schema declares head_branch as string|null. This
    // protocol case is derived from the schema, not from a captured response.
    workflow_runs_mut(&f, |run| run["head_branch"] = Value::Null);
    let writes = f.writes();
    let status = f.run(&["pr", "--status"]);
    assert_eq!(status["exit"], 0, "{status}");
    let checks = status["evidence"]["checks"].as_array().unwrap();
    assert_eq!(checks.len(), 1, "{status}");
    assert_eq!(checks[0]["id"], 81, "{status}");
    assert_eq!(checks[0]["conclusion"], "success", "{status}");
    let watched = f.run(&[
        "watch",
        "--request",
        "41",
        "--session",
        "null-branch",
        "--goal",
        "checks",
        "--once",
    ]);
    assert_eq!(watched["status"], "checks_passed", "{watched}");
    let inbox = f.run(&[
        "inbox",
        "--request",
        "41",
        "--session",
        "null-branch",
        "--goal",
        "checks",
    ]);
    assert_eq!(inbox["status"], "checks_passed", "{inbox}");
    assert_eq!(f.writes(), writes);
}

#[test]
fn github_nullable_workflow_branch_pending_run_is_not_green() {
    let f = fixture("github");
    workflow_runs_mut(&f, |run| {
        run["head_branch"] = Value::Null;
        run["status"] = json!("in_progress");
        run["conclusion"] = Value::Null;
    });
    f.edit(|s| {
        for (route, value) in s["read_routes"].as_object_mut().unwrap() {
            if route.contains("/check-runs?filter=latest") {
                value["check_runs"][0]["status"] = json!("in_progress");
                value["check_runs"][0]["conclusion"] = Value::Null;
                value["check_runs"][0]["completed_at"] = Value::Null;
            }
        }
    });
    let status = f.run(&["pr", "--status"]);
    assert_eq!(status["exit"], 0, "{status}");
    assert!(
        status["evidence"]["checks"]
            .as_array()
            .unwrap()
            .iter()
            .all(|check| check["conclusion"] != "success"),
        "{status}"
    );
    let watched = f.run(&[
        "watch",
        "--request",
        "41",
        "--session",
        "null-pending",
        "--goal",
        "checks",
        "--once",
    ]);
    assert_eq!(watched["status"], "pending", "{watched}");
    let inbox = f.run(&[
        "inbox",
        "--request",
        "41",
        "--session",
        "null-pending",
        "--goal",
        "checks",
    ]);
    assert_eq!(inbox["status"], "pending", "{inbox}");
}

#[test]
fn github_nullable_workflow_branch_does_not_swallow_parallel_failure() {
    let f = fixture("github");
    replacement_workflow(&f, Some(("head_branch", Value::Null)), true, false);
    workflow_runs_mut(&f, |run| {
        if run["id"] == 71 {
            run["conclusion"] = json!("failure");
        }
    });
    let status = f.run(&["pr", "--status"]);
    assert_eq!(status["exit"], 0, "{status}");
    let checks = status["evidence"]["checks"].as_array().unwrap();
    assert!(
        checks
            .iter()
            .any(|check| check["id"] == 81 && check["conclusion"] == "failure"),
        "{status}"
    );
    assert!(
        checks
            .iter()
            .any(|check| check["id"] == 82 && check["conclusion"] == "success"),
        "{status}"
    );
    let watched = f.run(&[
        "watch",
        "--request",
        "41",
        "--session",
        "null-parallel",
        "--goal",
        "checks",
        "--once",
    ]);
    assert_eq!(watched["status"], "failed", "{watched}");
    let inbox = f.run(&[
        "inbox",
        "--request",
        "41",
        "--session",
        "null-parallel",
        "--goal",
        "checks",
    ]);
    assert_eq!(inbox["status"], "failed", "{inbox}");
}

#[test]
fn github_workflow_branch_requires_a_nonempty_string_or_null() {
    for branch in [
        None,
        Some(json!(7)),
        Some(json!(false)),
        Some(json!("")),
        Some(json!({})),
        Some(json!([])),
    ] {
        let f = fixture("github");
        workflow_runs_mut(&f, |run| match &branch {
            Some(value) => run["head_branch"] = value.clone(),
            None => {
                run.as_object_mut().unwrap().remove("head_branch");
            }
        });
        let result = f.run(&["pr", "--status"]);
        assert_eq!(result["exit"], 3, "{branch:?}: {result}");
        assert!(
            result["evidence"]["checks"].is_null(),
            "{branch:?}: {result}"
        );
    }
}

#[test]
fn github_running_replacement_cannot_reuse_old_success() {
    for with_checks in [false, true] {
        let f = fixture("github");
        replacement_workflow(&f, None, with_checks, true);
        let r = f.run(&["pr", "--status"]);
        // #751 observes the running workflow before its first check becomes
        // visible. This is pending evidence, never a successful empty result.
        assert_eq!(r["exit"], 0, "{r}");
        let checks = r["evidence"]["checks"].as_array().unwrap();
        assert!(
            checks.iter().any(|c| c["id"] == 72
                && c["source"] == "workflow"
                && c["status"] == "in_progress"
                && c["conclusion"].is_null()),
            "{r}"
        );
        assert!(
            !checks.iter().any(|c| c["id"] == 81 || c["id"] == 71),
            "{r}"
        );
        let pending = f.run(&[
            "watch",
            "--request",
            "41",
            "--session",
            "replacement",
            "--goal",
            "checks",
            "--once",
        ]);
        assert_eq!(pending["status"], "pending", "{pending}");
        assert_eq!(
            pending["next_actions"][0]["kind"], "wait_for_checks",
            "{pending}"
        );
        f.edit(|s| {
            for (route, response) in s["read_routes"].as_object_mut().unwrap() {
                if route.contains("/actions/runs?head_sha=") {
                    response["workflow_runs"][1]["status"] = json!("completed");
                    response["workflow_runs"][1]["conclusion"] = json!("success");
                }
            }
        });
        let passed = f.run(&[
            "watch",
            "--request",
            "41",
            "--session",
            "replacement",
            "--goal",
            "checks",
            "--once",
        ]);
        assert_eq!(passed["status"], "checks_passed", "{passed}");
    }
}

#[test]
fn github_missing_workflow_identity_is_unknown_instead_of_old_green() {
    let f = fixture("github");
    f.edit(|s| {
        s["read_routes"]
            .as_object_mut()
            .unwrap()
            .retain(|route, _| !route.contains("/actions/runs?head_sha="));
    });
    let r = f.run(&["pr", "--status"]);
    assert_eq!(r["exit"], 3, "{r}");
    assert!(r["evidence"]["checks"].is_null(), "{r}");
}

fn checkpoint(f: &delivery::Fixture) -> Value {
    serde_json::from_slice(&fs::read(f.root.join(".git/specgit-v2/selection.json")).unwrap())
        .unwrap()
}

#[test]
fn a_merged_read_retires_the_checkpoint_until_new_issues_are_selected() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider);
        let open = f.run(&["pr", "--status"]);
        assert_eq!(open["status"], "open", "{provider}: {open}");
        assert!(open["effects"].is_null(), "{provider}: {open}");
        assert!(checkpoint(&f).get("delivered_request").is_none());

        complete_request(&f, provider);
        // A cross-branch read never retires another branch's checkpoint.
        git(&f, &["switch", "-q", "-c", "elsewhere"]);
        let foreign = f.run(&["pr", "--status", "--request", "41"]);
        assert_eq!(foreign["status"], "completed", "{provider}: {foreign}");
        assert!(foreign["effects"].is_null(), "{provider}: {foreign}");
        assert_eq!(foreign["diagnostics"], json!([]), "{provider}: {foreign}");
        git(&f, &["switch", "-q", "feature"]);
        assert!(checkpoint(&f).get("delivered_request").is_none());

        let writes = f.writes();
        let merged = f.run(&["pr", "--status"]);
        assert_eq!(merged["status"], "completed", "{provider}: {merged}");
        assert_eq!(
            merged["effects"]["operations"][0]["action"], "record_delivered_checkpoint",
            "{provider}: {merged}"
        );
        assert_eq!(merged["effects"]["outcome"], "applied");
        assert_eq!(f.writes(), writes, "the record is local only");
        assert_eq!(checkpoint(&f)["delivered_request"], 41);
        let again = f.run(&["pr", "--status"]);
        assert!(again["effects"].is_null(), "{provider}: {again}");

        // New commits cannot bind the delivered Issues.
        fs::write(f.root.join("after.txt"), "later work").unwrap();
        git(&f, &["add", "after.txt"]);
        let denied = f
            .command(&["guard", "--stage", "pre-commit"])
            .output()
            .unwrap();
        assert_eq!(denied.status.code(), Some(1));
        let stderr = String::from_utf8_lossy(&denied.stderr);
        assert!(stderr.contains("merged request #41"), "{stderr}");
        assert!(stderr.contains("--branch"), "{stderr}");
        git(&f, &["reset", "-q", "--hard"]);
        fs::remove_file(f.root.join("after.txt")).ok();

        let same_branch = f.run(&["issue", "--create-labels", "feat: next spec"]);
        assert_ne!(same_branch["exit"], 0, "{provider}: {same_branch}");
        assert!(
            same_branch["diagnostics"][0]["message"]
                .as_str()
                .unwrap()
                .contains("--branch"),
            "{provider}: {same_branch}"
        );
        let next = f.run(&[
            "issue",
            "--create-labels",
            "--branch",
            "next",
            "feat: next spec",
        ]);
        assert_eq!(next["exit"], 0, "{provider}: {next}");
        let current = checkpoint(&f);
        assert_eq!(current["branch"], "next", "{provider}: {current}");
        assert!(current.get("delivered_request").is_none());
        assert_ne!(current["issues"], json!([1]));
    }
}

#[test]
fn a_merged_request_with_open_issues_also_retires_and_keeps_the_open_fact() {
    let f = fixture("github");
    f.edit(|s| {
        s["native_closing"] = json!([1]);
        s["requests"][0]["state"] = json!("closed");
        s["requests"][0]["merged"] = json!(true);
        s["issues"][0]["state"] = json!("open");
    });
    let writes = f.writes();
    let merged = f.run(&["pr", "--status"]);
    assert_eq!(merged["status"], "merged_issues_open", "{merged}");
    assert_eq!(merged["exit"], 0, "{merged}");
    assert_eq!(merged["evidence"]["request"]["id"], 41, "{merged}");
    assert_eq!(merged["evidence"]["issues"][0]["state"], "open", "{merged}");
    assert_eq!(merged["effects"]["outcome"], "applied", "{merged}");
    assert_eq!(checkpoint(&f)["delivered_request"], 41);
    assert_eq!(f.writes(), writes);
}

#[test]
fn a_merged_lifecycle_watch_also_retires_the_checkpoint() {
    let f = fixture("github");
    complete_request(&f, "github");
    let writes = f.writes();
    let watched = f.run(&[
        "watch",
        "--request",
        "41",
        "--session",
        "session-a",
        "--goal",
        "lifecycle",
        "--once",
    ]);
    assert_eq!(watched["exit"], 0, "{watched}");
    assert_eq!(f.writes(), writes);
    assert_eq!(checkpoint(&f)["delivered_request"], 41, "{watched}");
}

#[tokio::test]
async fn delivered_merge_ignores_local_divergence_and_installed_guard_rejects_new_commits() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider);
        complete_request(&f, provider);
        let merged = f.run(&["pr", "--status"]);
        assert_eq!(merged["status"], "completed", "{provider}: {merged}");
        assert_eq!(
            checkpoint(&f)["delivered_request"],
            41,
            "{provider}: {merged}"
        );
        let writes = f.writes();

        // A dirty worktree after the merge does not change the lifecycle result.
        fs::write(f.root.join("dirty-after-merge.txt"), "uncommitted work").unwrap();
        let dirty = f.run(&[
            "watch",
            "--request",
            "41",
            "--session",
            "session-a",
            "--goal",
            "lifecycle",
            "--once",
        ]);
        assert_eq!(dirty["status"], "completed", "{provider}: {dirty}");
        assert_eq!(
            dirty["next_actions"][0]["kind"], "completed",
            "{provider}: {dirty}"
        );
        let message = dirty["next_actions"][0]["message"].as_str().unwrap();
        assert!(message.contains("new branch"), "{provider}: {dirty}");
        assert!(
            !message.contains("No further action"),
            "{provider}: {dirty}"
        );
        assert!(
            !dirty.to_string().contains("Push reviewed commits"),
            "{provider}: {dirty}"
        );
        assert_eq!(
            checkpoint(&f)["delivered_request"],
            41,
            "{provider}: {dirty}"
        );

        // Add the local commit before installing the guard; existing tests cover
        // the direct guard entry point, this covers the actual hook.
        fs::write(f.root.join("local-after-merge.txt"), "later work").unwrap();
        git(&f, &["add", "local-after-merge.txt"]);
        git(&f, &["commit", "-q", "-m", "local work after merge"]);
        let local = String::from_utf8(
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

        let watched = f.run(&[
            "watch",
            "--request",
            "41",
            "--session",
            "session-a",
            "--goal",
            "lifecycle",
            "--once",
        ]);
        assert_eq!(watched["status"], "completed", "{provider}: {watched}");
        assert_eq!(
            watched["next_actions"][0]["kind"], "completed",
            "{provider}: {watched}"
        );
        assert_eq!(
            watched["evidence"]["events"][0]["revision"]["local_head"], local,
            "{provider}: {watched}"
        );
        let refreshed = f.run(&[
            "inbox",
            "--request",
            "41",
            "--session",
            "session-a",
            "--goal",
            "lifecycle",
        ]);
        assert_eq!(refreshed["status"], "completed", "{provider}: {refreshed}");
        assert_eq!(
            refreshed["next_actions"][0], watched["next_actions"][0],
            "{provider}: {refreshed}"
        );
        assert_eq!(
            refreshed["evidence"]["events"][0]["id"], watched["evidence"]["events"][0]["id"],
            "{provider}: {refreshed}"
        );
        let status = f.run(&["pr", "--status"]);
        assert_eq!(status["status"], "completed", "{provider}: {status}");
        assert!(
            status["evidence"]["local_applicability"]["reasons"]
                .as_array()
                .unwrap()
                .contains(&json!("head_mismatch")),
            "{provider}: {status}"
        );
        assert_eq!(f.writes(), writes, "{provider}");

        specgit::guard::install_with_executable(
            &specgit::process::Process::default(),
            &f.root,
            false,
            &delivery::executable::binary(),
        )
        .await
        .unwrap();
        fs::write(f.root.join("blocked.txt"), "blocked").unwrap();
        git(&f, &["add", "blocked.txt"]);
        let blocked = Command::new("git")
            .current_dir(&f.root)
            .args(["commit", "-q", "-m", "blocked by guard"])
            .output()
            .unwrap();
        assert_eq!(blocked.status.code(), Some(1), "{provider}");
        let stderr = String::from_utf8_lossy(&blocked.stderr);
        assert!(
            stderr.contains("merged request #41"),
            "{provider}: {stderr}"
        );
        assert!(stderr.contains("--branch"), "{provider}: {stderr}");
        git(&f, &["reset", "-q", "--", "blocked.txt"]);
        fs::remove_file(f.root.join("blocked.txt")).ok();
        fs::remove_file(f.root.join("dirty-after-merge.txt")).ok();

        // The documented recovery still admits new work on a new selection.
        let selected = f.run(&[
            "issue",
            "--create-labels",
            "--branch",
            "next",
            "feat: next spec",
        ]);
        assert_eq!(selected["exit"], 0, "{provider}: {selected}");
        let next_issue = checkpoint(&f)["issues"][0].as_u64().unwrap();
        fs::write(f.root.join("next.txt"), "next work").unwrap();
        git(&f, &["add", "next.txt"]);
        let message = format!("next work\n\nIssue: #{next_issue}");
        git(&f, &["commit", "-q", "-m", message.as_str()]);
    }
}

#[test]
fn a_checkpoint_without_its_recorded_request_is_never_retired() {
    let f = fixture("github");
    complete_request(&f, "github");
    let path = f.root.join(".git/specgit-v2/selection.json");
    let mut saved = checkpoint(&f);
    saved["request"] = Value::Null;
    fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
    for args in [
        vec!["pr", "--status", "--request", "41"],
        vec![
            "watch",
            "--request",
            "41",
            "--session",
            "session-a",
            "--goal",
            "lifecycle",
            "--once",
        ],
    ] {
        let read = f.run(&args);
        assert!(read["effects"].is_null(), "{read}");
        assert!(checkpoint(&f).get("delivered_request").is_none(), "{read}");
    }
}

fn checkpoint_path(f: &delivery::Fixture) -> std::path::PathBuf {
    f.root.join(".git/specgit-v2/selection.json")
}

/// Park the fake provider on the second exact request read. The first read is
/// collection; the second is the final equality read before retirement. This
/// works with installed binaries because no fixture hook is compiled into them.
fn request_read_gate(f: &delivery::Fixture, pause: &Path) {
    let existing = f.state()["calls"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|call| {
            call["method"] == "GET"
                && call["endpoint"].as_str().is_some_and(|endpoint| {
                    (endpoint.ends_with("/pulls/41") || endpoint.ends_with("/merge_requests/41"))
                        && !endpoint.ends_with("/closes_issues")
                })
        })
        .count() as u64;
    f.edit(|s| {
        s["request_read_gate"] = json!({
            "request_id": 41,
            "after_calls": existing + 2,
            "parked": pause.join("request-read-parked"),
            "release": pause.join("request-read-release"),
        });
    });
}

fn await_request_read_gate(f: &delivery::Fixture, pause: &Path) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !pause.join("request-read-parked").exists() {
        assert!(
            Instant::now() < deadline,
            "CLI did not reach the final provider request read: {:?}",
            f.state()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn release_request_read_gate(pause: &Path) {
    fs::write(pause.join("request-read-release"), b"release").unwrap();
}

/// Source-only barrier used to prove the atomic concurrent-edit branch. The
/// installed equivalent is covered separately before the record attempt.
fn paused_checkpoint_feature_command(f: &delivery::Fixture, args: &[&str], pause: &Path) -> Child {
    f.feature_command(args)
        .env(
            "SPECGIT_FIXTURE_ASSET_PAUSE",
            "checkpoint-before-atomic-write",
        )
        .env("SPECGIT_FIXTURE_ASSET_PAUSE_DIR", pause)
        .env("SPECGIT_FIXTURE_ASSET_PAUSE_TARGET", checkpoint_path(f))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

fn await_checkpoint_pause(pause: &Path, child: &mut Child) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !pause.join("ready").exists() {
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("source CLI did not reach the delivered-checkpoint write barrier");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn child_report(output: std::process::Output) -> Value {
    let report: Value = serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|_| panic!("stdout={:?} stderr={:?}", output.stdout, output.stderr));
    assert_eq!(
        report["exit"].as_i64(),
        output.status.code().map(i64::from),
        "{report}"
    );
    report
}

#[cfg(unix)]
struct DeniedCheckpointDirectory {
    path: std::path::PathBuf,
    permissions: fs::Permissions,
}
#[cfg(unix)]
impl DeniedCheckpointDirectory {
    fn new(path: &Path) -> Self {
        use std::os::unix::fs::PermissionsExt;
        let permissions = fs::metadata(path).unwrap().permissions();
        fs::set_permissions(path, fs::Permissions::from_mode(0o500)).unwrap();
        Self {
            path: path.to_owned(),
            permissions,
        }
    }
}
#[cfg(unix)]
impl Drop for DeniedCheckpointDirectory {
    fn drop(&mut self) {
        fs::set_permissions(&self.path, self.permissions.clone()).unwrap();
    }
}

#[cfg(unix)]
#[test]
fn permission_denied_delivery_record_keeps_native_facts_and_retries_once() {
    let f = fixture("github");
    complete_request(&f, "github");
    let writes = f.writes();
    let pause = tempfile::tempdir().unwrap();
    request_read_gate(&f, pause.path());
    let child = f
        .command(&["pr", "--status"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    await_request_read_gate(&f, pause.path());
    let denied = DeniedCheckpointDirectory::new(&f.root.join(".git/specgit-v2"));
    release_request_read_gate(pause.path());
    let output = child.wait_with_output().unwrap();
    drop(denied);
    let failed = child_report(output);

    assert_eq!(failed["exit"], 3, "{failed}");
    assert_eq!(failed["ok"], false, "{failed}");
    assert_eq!(failed["status"], "completed", "{failed}");
    assert_eq!(failed["evidence"]["request"]["id"], 41, "{failed}");
    assert_eq!(
        failed["evidence"]["issues"][0]["state"], "closed",
        "{failed}"
    );
    assert_eq!(failed["effects"]["outcome"], "unknown", "{failed}");
    assert_eq!(
        failed["effects"]["operations"][0]["action"], "record_delivered_checkpoint",
        "{failed}"
    );
    assert_eq!(
        failed["effects"]["operations"][0]["outcome"], "unknown",
        "{failed}"
    );
    let diagnostic = failed["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .find(|diagnostic| diagnostic["operation"] == "delivered_checkpoint")
        .unwrap_or_else(|| panic!("no delivered-checkpoint diagnostic: {failed}"));
    assert_eq!(diagnostic["code"], "io_failed", "{failed}");
    assert!(
        diagnostic["message"]
            .as_str()
            .unwrap()
            .contains("PermissionDenied"),
        "{failed}"
    );
    assert!(
        diagnostic["remedy"]
            .as_str()
            .unwrap()
            .contains("specgit pr --status"),
        "{failed}"
    );
    assert!(
        checkpoint(&f).get("delivered_request").is_none(),
        "{failed}"
    );
    assert_eq!(f.writes(), writes);

    let retried = f.run(&["pr", "--status"]);
    assert_eq!(retried["exit"], 0, "{retried}");
    assert_eq!(retried["effects"]["outcome"], "applied", "{retried}");
    assert_eq!(
        retried["effects"]["operations"][0]["action"], "record_delivered_checkpoint",
        "{retried}"
    );
    assert_eq!(checkpoint(&f)["delivered_request"], 41);
    assert_eq!(f.writes(), writes);

    let again = f.run(&["pr", "--status"]);
    assert_eq!(again["exit"], 0, "{again}");
    assert!(again["effects"].is_null(), "{again}");
    assert_eq!(checkpoint(&f)["delivered_request"], 41);
}

fn hold_delivery_lock(f: &delivery::Fixture) -> specgit::assets::AssetStore {
    let root = f.root.join(".git/specgit-v2");
    specgit::assets::AssetStore::lock(
        &root.join("delivery-transactions"),
        std::slice::from_ref(&root),
        Duration::from_millis(100),
    )
    .unwrap()
}

fn delivered_diagnostic(report: &Value) -> &Value {
    report["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .find(|diagnostic| diagnostic["operation"] == "delivered_checkpoint")
        .unwrap_or_else(|| panic!("no delivered-checkpoint diagnostic: {report}"))
}

#[test]
fn lock_contention_reports_not_applied_and_retry_records_once() {
    let f = fixture("github");
    complete_request(&f, "github");
    let writes = f.writes();
    let held = hold_delivery_lock(&f);
    let blocked = f.run(&["pr", "--status"]);
    assert_eq!(blocked["exit"], 3, "{blocked}");
    assert_eq!(blocked["ok"], false, "{blocked}");
    assert_eq!(blocked["status"], "completed", "{blocked}");
    assert_eq!(blocked["evidence"]["request"]["id"], 41, "{blocked}");
    assert_eq!(blocked["effects"]["outcome"], "not_applied", "{blocked}");
    assert_eq!(blocked["effects"]["operations"], json!([]), "{blocked}");
    let diagnostic = delivered_diagnostic(&blocked);
    assert_eq!(diagnostic["code"], "lock_busy", "{blocked}");
    assert!(
        diagnostic["remedy"]
            .as_str()
            .unwrap()
            .contains("specgit pr --status"),
        "{blocked}"
    );
    assert!(
        checkpoint(&f).get("delivered_request").is_none(),
        "{blocked}"
    );
    assert_eq!(f.writes(), writes);

    drop(held);
    let retried = f.run(&["pr", "--status"]);
    assert_eq!(retried["exit"], 0, "{retried}");
    assert_eq!(retried["effects"]["outcome"], "applied", "{retried}");
    assert_eq!(checkpoint(&f)["delivered_request"], 41);
    assert_eq!(f.writes(), writes);
}

#[test]
fn watch_preserves_completed_event_when_delivery_record_is_blocked() {
    let f = fixture("github");
    complete_request(&f, "github");
    let writes = f.writes();
    let held = hold_delivery_lock(&f);
    let watched = f.run(&[
        "watch",
        "--request",
        "41",
        "--session",
        "session-a",
        "--goal",
        "lifecycle",
        "--once",
    ]);
    assert_eq!(watched["exit"], 3, "{watched}");
    assert_eq!(watched["ok"], false, "{watched}");
    assert_eq!(watched["status"], "completed", "{watched}");
    assert_eq!(
        watched["evidence"]["events"][0]["state"], "completed",
        "{watched}"
    );
    assert_eq!(
        watched["evidence"]["transport"], "offered_not_acknowledged",
        "{watched}"
    );
    assert_eq!(watched["next_actions"][0]["kind"], "completed", "{watched}");
    assert_eq!(watched["effects"]["outcome"], "not_applied", "{watched}");
    assert_eq!(watched["effects"]["operations"], json!([]), "{watched}");
    let diagnostic = delivered_diagnostic(&watched);
    assert_eq!(diagnostic["code"], "lock_busy", "{watched}");
    assert!(
        checkpoint(&f).get("delivered_request").is_none(),
        "{watched}"
    );
    assert_eq!(f.writes(), writes);

    drop(held);
    let retried = f.run(&["pr", "--status"]);
    assert_eq!(retried["exit"], 0, "{retried}");
    assert_eq!(retried["effects"]["outcome"], "applied", "{retried}");
    assert_eq!(checkpoint(&f)["delivered_request"], 41);
    assert_eq!(f.writes(), writes);
}

#[test]
fn concurrent_selection_change_before_delivery_record_is_never_retired() {
    let f = fixture("github");
    complete_request(&f, "github");
    let writes = f.writes();
    let pause = tempfile::tempdir().unwrap();
    request_read_gate(&f, pause.path());
    let child = f
        .command(&["pr", "--status"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    await_request_read_gate(&f, pause.path());
    let mut concurrent = checkpoint(&f);
    concurrent["request"] = json!(42);
    fs::write(
        checkpoint_path(&f),
        serde_json::to_vec(&concurrent).unwrap(),
    )
    .unwrap();
    release_request_read_gate(pause.path());
    let output = child.wait_with_output().unwrap();
    let report = child_report(output);

    assert_eq!(report["exit"], 0, "{report}");
    assert_eq!(report["status"], "completed", "{report}");
    assert!(report["effects"].is_null(), "{report}");
    let after = checkpoint(&f);
    assert_eq!(after["request"], 42, "{after}");
    assert!(after.get("delivered_request").is_none(), "{after}");
    assert_eq!(f.writes(), writes);
}

/// The installed profile runs the equivalent pre-record test above with the
/// real binary and fake-provider barrier. This source-only test keeps the
/// atomic conflict assertion at the checkpoint replacement barrier.
#[test]
fn concurrent_selection_change_during_delivery_write_is_rejected_in_source_mode() {
    let f = fixture("github");
    complete_request(&f, "github");
    let writes = f.writes();
    let pause = tempfile::tempdir().unwrap();
    let mut child = paused_checkpoint_feature_command(&f, &["pr", "--status"], pause.path());
    await_checkpoint_pause(pause.path(), &mut child);
    let mut concurrent = checkpoint(&f);
    concurrent["request"] = json!(42);
    fs::write(
        checkpoint_path(&f),
        serde_json::to_vec(&concurrent).unwrap(),
    )
    .unwrap();
    fs::write(pause.path().join("go"), b"go").unwrap();
    let output = child.wait_with_output().unwrap();
    let report = child_report(output);

    assert_eq!(report["exit"], 3, "{report}");
    assert_eq!(report["ok"], false, "{report}");
    assert_eq!(report["status"], "completed", "{report}");
    assert_eq!(report["effects"]["outcome"], "not_applied", "{report}");
    assert_eq!(report["effects"]["operations"], json!([]), "{report}");
    let diagnostic = delivered_diagnostic(&report);
    assert_eq!(diagnostic["code"], "concurrent_edit", "{report}");
    let after = checkpoint(&f);
    assert_eq!(after["request"], 42, "{after}");
    assert!(after.get("delivered_request").is_none(), "{after}");
    assert_eq!(f.writes(), writes);
}

#[test]
fn a_writable_checkpoint_for_another_request_is_not_retired() {
    let f = fixture("github");
    complete_request(&f, "github");
    let mut saved = checkpoint(&f);
    saved["request"] = json!(42);
    fs::write(checkpoint_path(&f), serde_json::to_vec(&saved).unwrap()).unwrap();
    let read = f.run(&["pr", "--status", "--request", "41"]);
    assert_eq!(read["exit"], 0, "{read}");
    assert_eq!(read["status"], "completed", "{read}");
    assert!(read["effects"].is_null(), "{read}");
    assert!(checkpoint(&f).get("delivered_request").is_none(), "{read}");
}
