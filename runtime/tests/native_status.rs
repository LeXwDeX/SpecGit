#![cfg(feature = "test-fixtures")]
#[path = "support/acceptance.rs"]
mod acceptance;
#[path = "support/delivery.rs"]
mod delivery;
use acceptance::fixture;
use serde_json::{Value, json};
use std::fs;
const STAMP: &str = "2026-09-09T00:00:00Z";
#[test]
fn both_native_forges_observe_current_head_evidence_without_remote_writes() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider);
        let writes = f.writes();
        let r = f.run(&["pr", "--status"]);
        assert_eq!(r["exit"], 0, "{provider}: {r}");
        assert_eq!(r["status"], "open");
        assert!(!r["evidence"]["checks"].as_array().unwrap().is_empty());
        assert_eq!(f.writes(), writes);
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
            .all(|route| !route.contains("/actions/"))
    );
    assert_eq!(f.writes(), writes);
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
