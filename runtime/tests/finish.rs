#![cfg(feature = "test-fixtures")]
#[path = "support/delivery.rs"]
mod delivery;
use base64::{Engine, engine::general_purpose::STANDARD};
use delivery::Fixture;
use serde_json::{Value, json};
use std::{fs, process::Command};
const STAMP: &str = "2026-09-09T00:00:00Z";
fn blob(bytes: &[u8], id: &str) -> Value {
    json!({"sha":id,"content":STANDARD.encode(bytes),"encoding":"base64","size":bytes.len()})
}
fn fixture(provider: &str) -> Fixture {
    let f = Fixture::new(provider);
    assert_eq!(f.run(&["issue", "feat: first spec"])["exit"], 0);
    let head = String::from_utf8(
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
    f.edit(|s| {
        s["request_fixture"] = json!(true);
        s["requests"] = json!([]);
        s["has_diff"] = json!(true);
        s["branch_heads"] = json!({"feature":head,"main":"a".repeat(40)});
    });
    assert_eq!(f.run(&["pr"])["exit"], 0);
    assert_eq!(f.run(&["pr", "--ready"])["exit"], 0);
    let bytes = fs::read(f.root.join(".specgit.yaml")).unwrap();
    f.edit(|s| {
        let mut routes=json!({});
        s["project"]["only_allow_merge_if_pipeline_succeeds"]=json!(true);
        if provider=="github" {
            s["requests"][0]["mergeable"]=json!(true);
            s["requests"][0]["mergeable_state"]=json!("clean");
            let base="repos/fixture/repo";
            for (commit,tree,blob_id) in [(&head,"b".repeat(40),"c".repeat(40)),(&"a".repeat(40),"d".repeat(40),"e".repeat(40))] {
                routes[format!("{base}/git/commits/{commit}")]=json!({"sha":commit,"tree":{"sha":tree}});
                routes[format!("{base}/git/trees/{tree}")]=json!({"sha":tree,"truncated":false,"tree":[{"path":".specgit.yaml","type":"blob","mode":"100644","sha":blob_id}]});
                routes[format!("{base}/git/blobs/{blob_id}")]=blob(&bytes,&blob_id);
            }
            routes[format!("{base}/branches/main")]=json!({"name":"main","protected":false,"commit":{"sha":"a".repeat(40)}});
            routes[format!("{base}/rules/branches/main?per_page=100&page=1")]=json!([]);
            routes[format!("{base}/pulls/41/reviews?per_page=100&page=1")]=json!([]);
            routes[format!("{base}/actions/runs?head_sha={head}&per_page=100&page=1")]=json!({"total_count":1,"workflow_runs":[{"id":71,"workflow_id":1,"event":"pull_request","head_sha":head,"run_attempt":1,"check_suite_id":101,"name":"CI","status":"completed","conclusion":"success","run_started_at":STAMP}]});
            routes[format!("{base}/commits/{head}/check-runs?filter=all&per_page=100&page=1")]=json!({"total_count":1,"check_runs":[{"id":81,"head_sha":head,"app":{"id":15368,"slug":"github-actions"},"check_suite":{"id":101},"name":"Test","status":"completed","conclusion":"success","started_at":STAMP,"completed_at":STAMP}]});
            routes[format!("{base}/actions/runs/71/jobs?filter=all&per_page=100&page=1")]=json!({"total_count":1,"jobs":[{"id":81,"run_id":71,"head_sha":head,"check_run_url":"https://forge.example/api/v3/repos/fixture/repo/check-runs/81","name":"Test","status":"completed","conclusion":"success","started_at":STAMP,"completed_at":STAMP}]});
            routes[format!("{base}/commits/{head}/statuses?per_page=100&page=1")]=json!([]);
            routes[format!("{base}/branches?per_page=100&page=1")]=json!([{"name":"main"}]);
        } else {
            let base="projects/fixture%2Frepo";
            s["requests"][0]["detailed_merge_status"]=json!("mergeable");
            s["requests"][0]["head_pipeline"]=json!({"id":71,"project_id":7,"sha":head,"status":"success"});
            for (commit,blob_id) in [(&head,"c".repeat(40)),(&"a".repeat(40),"e".repeat(40))] {
                routes[format!("{base}/repository/commits/{commit}")]=json!({"id":commit});
                routes[format!("{base}/repository/tree?ref={commit}&recursive=false&per_page=100&page=1")]=json!([{"path":".specgit.yaml","type":"blob","mode":"100644","id":blob_id}]);
                routes[format!("{base}/repository/blobs/{blob_id}")]=blob(&bytes,&blob_id);
            }
            routes[format!("{base}/repository/branches/main")]=json!({"name":"main","protected":false,"commit":{"id":"a".repeat(40)}});
            routes[format!("{base}/protected_branches?per_page=100&page=1")]=json!([]);
            routes[format!("{base}/merge_requests/41/approvals")]=json!({"approvals_required":0,"approvals_left":0});
            routes["projects/7/pipelines/71"]=json!({"id":71,"project_id":7,"sha":head,"status":"success","created_at":STAMP,"finished_at":STAMP});
            routes["projects/7/pipelines/71/jobs?per_page=100&page=1"]=json!([{"id":81,"name":"Test","status":"success","pipeline":{"id":71,"project_id":7},"commit":{"id":head},"started_at":STAMP,"finished_at":STAMP,"allow_failure":false}]);
            routes["projects/7/pipelines/71/trigger_jobs?per_page=100&page=1"]=json!([]);
            routes[format!("{base}/repository/branches?per_page=100&page=1")]=json!([{"name":"main"}]);
        }
        s["read_routes"]=routes;
    });
    f
}
#[test]
fn both_native_forges_accept_complete_current_head_evidence_without_remote_writes() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider);
        let writes = f.writes();
        let r = f.run(&["finish"]);
        assert_eq!(r["exit"], 0, "{provider}: {r}");
        assert_eq!(r["status"], "accepted");
        assert_eq!(r["evidence"]["declaration"]["source"], "target_revision");
        assert_eq!(f.writes(), writes);
    }
}
#[test]
fn candidate_cannot_remove_approved_required_check_and_initial_adoption_is_explicit() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider);
        let route = if provider == "github" {
            format!("repos/fixture/repo/git/blobs/{}", "e".repeat(40))
        } else {
            format!(
                "projects/fixture%2Frepo/repository/blobs/{}",
                "e".repeat(40)
            )
        };
        f.edit(|s| {
            s["read_routes"][&route] = blob(
                b"version: 2\nverification:\n  required_checks: [Missing]\n",
                &"e".repeat(40),
            )
        });
        let r = f.run(&["finish"]);
        assert_eq!(r["exit"], 1, "{r}");
        assert!(
            r["evidence"]["blockers"]
                .as_array()
                .unwrap()
                .contains(&json!("check_missing:Missing"))
        );
        f.edit(|s| {
            if provider=="github" {s["read_routes"][format!("repos/fixture/repo/git/trees/{}","d".repeat(40))]["tree"]=json!([]);}
            else {s["read_routes"][format!("projects/fixture%2Frepo/repository/tree?ref={}&recursive=false&per_page=100&page=1","a".repeat(40))]=json!([]);}
        });
        let r = f.run(&["finish"]);
        assert_eq!(r["status"], "accepted_initial_adoption", "{r}");
    }
}
#[test]
fn current_rerun_masks_old_green_and_missing_native_protection_remains_unknown() {
    let f = fixture("github");
    f.edit(|s| {
        for (route, value) in s["read_routes"].as_object_mut().unwrap() {
            if route.contains("/actions/runs?") {
                value["workflow_runs"][0]["run_attempt"] = json!(2);
                value["workflow_runs"][0]["status"] = json!("in_progress");
                value["workflow_runs"][0]["conclusion"] = Value::Null;
            }
        }
    });
    let r = f.run(&["finish"]);
    assert_eq!(r["exit"], 1, "{r}");
    assert!(
        r["evidence"]["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v.as_str().unwrap().starts_with("check_pending:"))
    );
    f.edit(|s| s["read_routes"]["repos/fixture/repo/branches/main"]["protected"] = json!(true));
    let r = f.run(&["finish"]);
    assert_eq!(r["exit"], 3, "{r}");
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
        let r = f.run(&["finish"]);
        assert_eq!(r["status"], "merged_issues_open", "{r}");
        f.edit(|s| s["issues"][0]["state"] = json!("closed"));
        let writes = f.writes();
        let r = f.run(&["finish"]);
        assert_eq!(r["status"], "completed", "{r}");
        assert_eq!(r["evidence"]["source_cleanup"], "deleted");
        assert_eq!(f.writes(), writes);
    }
}
#[test]
fn native_edits_and_stale_head_pipeline_never_accept() {
    let f = fixture("github");
    f.edit(|s| {
        s["request_reads"] = json!(0);
        s["edit_request_on_read"] = json!(2);
    });
    let writes = f.writes();
    let r = f.run(&["finish"]);
    assert_eq!(r["exit"], 3, "{r}");
    assert_eq!(f.writes(), writes);
    let f = fixture("gitlab");
    f.edit(|s| s["requests"][0]["head_pipeline"]["sha"] = json!("f".repeat(40)));
    let r = f.run(&["finish"]);
    assert_eq!(r["exit"], 3, "{r}");
}
#[test]
fn incomplete_jobs_counts_unknown_suites_and_wrong_apps_cannot_accept() {
    for fault in [
        "missing_job",
        "truncated_checks",
        "unknown_suite",
        "wrong_job_run",
        "wrong_app",
    ] {
        let f = fixture("github");
        f.edit(|s| {
            if fault=="wrong_app" {
                s["read_routes"]["repos/fixture/repo/rules/branches/main?per_page=100&page=1"]=json!([{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"Test","integration_id":999}]}}]);
            }
            for (route,value) in s["read_routes"].as_object_mut().unwrap() {
                if route.contains("/check-runs?") {
                    if fault=="truncated_checks" {value["total_count"]=json!(2);}
                    if fault=="unknown_suite" {value["check_runs"][0]["check_suite"]["id"]=json!(999);}
                }
                if route.contains("/jobs?filter=all") {
                    if fault=="missing_job" {value["jobs"]=json!([]);value["total_count"]=json!(0);}
                    if fault=="wrong_job_run" {value["jobs"][0]["run_id"]=json!(999);}
                }
            }
        });
        let writes = f.writes();
        let r = f.run(&["finish"]);
        assert_eq!(
            r["exit"],
            if fault == "wrong_app" { 1 } else { 3 },
            "{fault}: {r}"
        );
        assert_eq!(f.writes(), writes);
    }
}
#[test]
fn approvals_and_clean_local_head_are_required_and_native_settings_are_not_exposed() {
    let f = fixture("gitlab");
    f.edit(|s| {
        s["project"]["runners_token"] = json!("PRIVATE_FIXTURE_TOKEN");
        s["read_routes"]["projects/fixture%2Frepo/merge_requests/41/approvals"] =
            json!({"approvals_required":1,"approvals_left":1});
    });
    let r = f.run(&["finish"]);
    assert_eq!(r["exit"], 1, "{r}");
    assert!(!r.to_string().contains("PRIVATE_FIXTURE_TOKEN"));
    let f = fixture("github");
    fs::write(f.root.join("uncommitted.txt"), "work in progress").unwrap();
    let r = f.run(&["finish"]);
    assert_eq!(r["exit"], 1, "{r}");
    assert!(
        r["evidence"]["blockers"]
            .as_array()
            .unwrap()
            .contains(&json!("local_worktree_dirty"))
    );
}
#[test]
fn native_downstream_pipeline_failure_blocks_an_otherwise_successful_parent() {
    let f = fixture("gitlab");
    f.edit(|s| {
        s["read_routes"]["projects/7/pipelines/71/trigger_jobs?per_page=100&page=1"]=json!([{"id":91,"name":"Child","status":"success","allow_failure":false,"started_at":STAMP,"finished_at":STAMP,"downstream_pipeline":{"id":72,"project_id":7,"sha":"f".repeat(40)}}]);
        s["read_routes"]["projects/7/pipelines/72"]=json!({"id":72,"project_id":7,"sha":"f".repeat(40),"status":"failed","created_at":STAMP,"finished_at":STAMP});
        s["read_routes"]["projects/7/pipelines/72/jobs?per_page=100&page=1"]=json!([]);
        s["read_routes"]["projects/7/pipelines/72/trigger_jobs?per_page=100&page=1"]=json!([]);
    });
    let r = f.run(&["finish"]);
    assert_eq!(r["exit"], 1, "{r}");
    assert!(
        r["evidence"]["blockers"]
            .as_array()
            .unwrap()
            .contains(&json!("check_failed:downstream:7/72:pipeline"))
    );
}

#[test]
fn removed_selected_associations_block_acceptance_and_completion() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider);
        let path = f.root.join(".git/specgit-v2/selection.json");
        let mut selected: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        selected["issues"] = json!([1, 2]);
        fs::write(path, selected.to_string()).unwrap();
        let r = f.run(&["finish"]);
        assert_eq!(r["exit"], 1, "{r}");
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
        let r = f.run(&["finish"]);
        assert_eq!(r["exit"], 1, "{r}");
        assert_ne!(r["status"], "completed");
        assert_eq!(f.writes(), writes);
    }
}
#[test]
fn a_successful_trigger_with_hidden_downstream_evidence_is_unknown() {
    let f = fixture("gitlab");
    f.edit(|s|s["read_routes"]["projects/7/pipelines/71/trigger_jobs?per_page=100&page=1"]=json!([{"id":91,"name":"Hidden child","status":"success","allow_failure":false,"started_at":STAMP,"finished_at":STAMP,"downstream_pipeline":null}]));
    let r = f.run(&["finish"]);
    assert_eq!(r["exit"], 3, "{r}");
}
