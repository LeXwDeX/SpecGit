#![cfg(feature = "test-fixtures")]
#[path = "support/delivery.rs"]
mod delivery;
use delivery::Fixture;
use serde_json::json;
use std::{fs, process::Command};
fn fixture(provider: &str, count: usize) -> Fixture {
    let f = Fixture::new(provider);
    let mut args = vec!["issue", "feat: first spec"];
    if count == 2 {
        args.push("fix: second spec");
    }
    let r = f.run(&args);
    assert_eq!(r["exit"], 0, "{r}");
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
    f
}
#[test]
fn both_forges_create_draft_with_all_references_then_ready_without_push_or_dummy_commit() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider, 2);
        let before = Command::new("git")
            .current_dir(&f.root)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap()
            .stdout;
        let r = f.run(&["pr"]);
        assert_eq!(r["exit"], 0, "{r}");
        assert_eq!(r["status"], "draft");
        let body = r["evidence"]["request"]["body"].as_str().unwrap();
        assert!(body.contains("Closes #1") && body.contains("Closes #2"));
        assert_eq!(r["evidence"]["request"]["labels"], json!(["kind::feat"]));
        let writes = f.writes();
        let r = f.run(&["pr"]);
        assert_eq!(r["exit"], 0, "{r}");
        assert_eq!(f.writes(), writes);
        let r = f.run(&["pr", "--ready"]);
        assert_eq!(r["exit"], 0, "{r}");
        assert_eq!(r["evidence"]["request"]["draft"], false);
        assert_eq!(
            Command::new("git")
                .current_dir(&f.root)
                .args(["rev-parse", "HEAD"])
                .output()
                .unwrap()
                .stdout,
            before
        );
        assert!(
            Command::new("git")
                .current_dir(&f.root)
                .args(["status", "--porcelain"])
                .output()
                .unwrap()
                .stdout
                .is_empty()
        );
    }
}
#[test]
fn no_diff_or_unpushed_head_leaves_request_pending_without_remote_writes() {
    let f = fixture("github", 1);
    let writes = f.writes();
    f.edit(|s| s["has_diff"] = json!(false));
    let r = f.run(&["pr"]);
    assert_eq!(r["status"], "pending_request", "{r}");
    assert_eq!(f.writes(), writes);
    f.edit(|s| {
        s["has_diff"] = json!(true);
        s["branch_heads"]["feature"] = json!("b".repeat(40));
    });
    let r = f.run(&["pr"]);
    assert_eq!(r["evidence"]["reason"], "source_head_not_pushed", "{r}");
    assert_eq!(f.writes(), writes);
}
#[test]
fn newly_supplied_association_is_resolved_before_creation_or_body_update() {
    let f = fixture("github", 1);
    fs::write(f.root.join("body.md"), "Complete user body\n\nCloses #999").unwrap();
    let writes = f.writes();
    let r = f.run(&["pr", "--body-file", "body.md"]);
    assert_eq!(r["exit"], 3, "{r}");
    assert_eq!(f.writes(), writes);
    assert_eq!(f.run(&["pr"])["exit"], 0);
    let writes = f.writes();
    let r = f.run(&["pr", "--update-body", "--body-file", "body.md"]);
    assert_eq!(r["exit"], 3, "{r}");
    assert_eq!(f.writes(), writes);
}
#[test]
fn uncertain_creation_recovers_exact_native_request_without_duplicate_and_preserves_edits() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider, 1);
        f.edit(|s| s["lose_request_response"] = json!(true));
        let r = f.run(&["pr"]);
        assert_eq!(r["exit"], 3, "{r}");
        assert_eq!(f.state()["requests"].as_array().unwrap().len(), 1);
        f.edit(|s| {
            s["requests"][0][if provider == "github" {
                "body"
            } else {
                "description"
            }] = json!("Native user edits\n\nCloses #1")
        });
        let r = f.run(&["pr", "--request", "41"]);
        assert_eq!(r["exit"], 0, "{r}");
        assert_eq!(
            r["evidence"]["request"]["body"],
            "Native user edits\n\nCloses #1"
        );
        assert_eq!(f.state()["requests"].as_array().unwrap().len(), 1);
    }
}
#[test]
fn explicit_body_update_preserves_all_refs_and_conflicting_native_edit_stops_before_write() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider, 2);
        assert_eq!(f.run(&["pr"])["exit"], 0);
        let body = f.root.join("prepared.md");
        fs::write(&body, "Prepared replacement\r\n").unwrap();
        let r = f.run(&["pr", "--update-body", "--body-file", body.to_str().unwrap()]);
        assert_eq!(r["exit"], 0, "{r}");
        let b = r["evidence"]["request"]["body"].as_str().unwrap();
        assert!(b.starts_with("Prepared replacement\r\n"));
        assert!(b.contains("Closes #1") && b.contains("Closes #2"));
        f.edit(|s| {
            s["request_reads"] = json!(0);
            s["edit_request_on_read"] = json!(2);
        });
        let writes = f.writes();
        let r = f.run(&["pr", "--update-body", "--body-file", body.to_str().unwrap()]);
        assert_eq!(r["exit"], 3, "{r}");
        assert_eq!(f.writes(), writes);
        assert_eq!(
            f.state()["requests"][0][if provider == "github" {
                "body"
            } else {
                "description"
            }],
            "Concurrent user edit\n\nCloses #1"
        );
    }
}
#[test]
fn fork_identity_and_removed_associations_require_reconciliation() {
    let f = fixture("github", 1);
    assert_eq!(f.run(&["pr"])["exit"], 0);
    f.edit(|s| s["requests"][0]["head"]["repo"]["id"] = json!(9));
    let writes = f.writes();
    let r = f.run(&["pr"]);
    assert_eq!(r["exit"], 3, "{r}");
    assert_eq!(f.writes(), writes);
    f.edit(|s| {
        s["requests"][0]["head"]["repo"]["id"] = json!(7);
        s["requests"][0]["body"] = json!("User removed reference");
    });
    let r = f.run(&["pr"]);
    assert_eq!(r["exit"], 2, "{r}");
    assert_eq!(f.writes(), writes);
    let r = f.run(&["pr", "--update-references"]);
    assert_eq!(r["exit"], 0, "{r}");
    assert_eq!(
        r["evidence"]["request"]["body"],
        "User removed reference\n\nCloses #1"
    );
}
