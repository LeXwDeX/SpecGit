use super::delivery::Fixture;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{fs, process::Command};
const STAMP: &str = "2026-09-09T00:00:00Z";
fn blob(bytes: &[u8], id: &str) -> Value {
    json!({"sha":id,"content":STANDARD.encode(bytes),"encoding":"base64","size":bytes.len()})
}
pub fn fixture(provider: &str) -> Fixture {
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
        s["project"]["merge_trains_enabled"]=json!(false);
        s["project"]["squash_option"]=json!("default_off");
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
            s["requests"][0]["pipeline"]=s["requests"][0]["head_pipeline"].clone();
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
