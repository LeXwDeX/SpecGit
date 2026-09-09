#![cfg(feature = "test-fixtures")]
#[path = "support/delivery.rs"]
mod delivery;
use delivery::Fixture;
use serde_json::{Value, json};
use std::{fs, process::Command};
fn git(f: &Fixture, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(&f.root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().into()
}
fn request(
    provider: &str,
    id: u64,
    source: &str,
    target: &str,
    head: &str,
    anchor: Option<&str>,
    body: &str,
) -> Value {
    let merged = anchor.is_some();
    json!({"id":id,"number":id,"iid":id,"title":"feat: source","body":body,"description":body,"labels":[],"state":if merged {if provider=="github" {"closed"} else {"merged"}} else {if provider=="github" {"open"}else{"opened"}},"draft":false,"merged":merged,"head":{"sha":head,"ref":source,"repo":{"id":7}},"base":{"ref":target,"repo":{"id":7}},"sha":head,"source_branch":source,"target_branch":target,"source_project_id":7,"target_project_id":7,"merge_commit_sha":anchor,"updated_at":"2026-09-09T00:00:00Z"})
}
fn routes(f: &Fixture, provider: &str, base: &str, associations: &[(String, u64)]) {
    let head = git(f, &["rev-parse", "HEAD"]);
    let commits = git(f, &["rev-list", &format!("{base}..{head}")]);
    f.edit(|s| {
        s["requests"][0]["head"]["sha"]=json!(head);s["requests"][0]["sha"]=json!(head);
        let branch=if provider=="github" {"repos/fixture/repo/branches/main"}else{"projects/fixture%2Frepo/repository/branches/main"};
        s["read_routes"][branch]=json!({"name":"main","commit":{"sha":base,"id":base}});
        for commit in commits.lines() {
            let route=if provider=="github" {format!("repos/fixture/repo/commits/{commit}/pulls?per_page=100&page=1")} else {format!("projects/fixture%2Frepo/repository/commits/{commit}/merge_requests?per_page=100&page=1")};
            let rows:Vec<_>=associations.iter().filter(|(sha,_)|sha==commit).map(|(_,id)|json!({"number":id,"iid":id})).collect();
            s["read_routes"][route]=json!(rows);
        }
    });
}
fn fixture(provider: &str, intermediate: &str) -> (Fixture, String, Vec<(String, u64)>) {
    let f = Fixture::new(provider);
    let base = git(&f, &["rev-parse", "HEAD"]);
    git(&f, &["branch", "-m", intermediate]);
    git(&f, &["branch", "main"]);
    let mut sources = vec![];
    let mut associations = vec![];
    for (id, file) in [(42, "one.txt"), (43, "two.txt")] {
        let branch = format!("work-{id}");
        git(&f, &["checkout", "-b", &branch]);
        fs::write(f.root.join(file), format!("complete feature {id}\n")).unwrap();
        git(&f, &["add", file]);
        git(&f, &["commit", "-m", "feature"]);
        let head = git(&f, &["rev-parse", "HEAD"]);
        git(&f, &["checkout", intermediate]);
        git(&f, &["merge", "--no-ff", "--no-edit", &branch]);
        let merge = git(&f, &["rev-parse", "HEAD"]);
        git(&f, &["branch", "-d", &branch]);
        sources.push(request(
            provider,
            id,
            &branch,
            intermediate,
            &head,
            Some(&merge),
            &format!("Closes #{}", id - 41),
        ));
        associations.push((head, id));
        associations.push((merge, id));
    }
    let head = git(&f, &["rev-parse", "HEAD"]);
    f.edit(|s| {
        s["request_fixture"]=json!(true);s["read_routes"]=json!({});
        let mut requests=vec![request(provider,41,intermediate,"main",&head, None,"")];requests.extend(sources);
        s["requests"]=json!(requests);
        s["issues"]=json!([{"id":1,"number":1,"iid":1,"project_id":7,"title":"feat: one","body":"spec","description":"spec","labels":[],"state":"open","updated_at":"stable"},{"id":2,"number":2,"iid":2,"project_id":7,"title":"feat: two","body":"spec","description":"spec","labels":[],"state":"closed","updated_at":"stable"}]);
    });
    routes(&f, provider, &base, &associations);
    (f, base, associations)
}
#[test]
fn both_forges_preserve_two_source_associations_and_closed_issues_after_branch_cleanup() {
    for (provider, branch) in [
        ("github", "dev"),
        ("gitlab", "preview"),
        ("github", "qa/rc"),
    ] {
        let (f, _, _) = fixture(provider, branch);
        let writes = f.writes();
        let r = f.run(&["promotion", "--request", "41", "--source-request", "42,42"]);
        assert_eq!(r["status"], "candidates", "{r}");
        assert_eq!(r["exit"], 0);
        assert_eq!(r["evidence"]["suggested_issue_ids"], json!([1, 2]));
        assert_eq!(
            r["evidence"]["candidates"][1]["issues"][0]["state"],
            "closed"
        );
        assert_eq!(r["evidence"]["exhaustive"], false);
        assert_eq!(r["evidence"]["association_written"], false);
        assert_eq!(f.writes(), writes);
        assert!(!git(&f, &["branch", "--list"]).contains("work-"));
    }
}
#[test]
fn full_revert_is_excluded_and_later_partial_change_is_unverified() {
    for provider in ["github", "gitlab"] {
        let (f, base, associations) = fixture(provider, "dev");
        git(&f, &["rm", "one.txt"]);
        git(&f, &["commit", "-m", "revert first feature"]);
        fs::write(f.root.join("two.txt"), "partially changed feature\n").unwrap();
        git(&f, &["add", "two.txt"]);
        git(&f, &["commit", "-m", "later edit"]);
        routes(&f, provider, &base, &associations);
        let r = f.run(&["promotion", "--request", "41"]);
        assert_eq!(r["status"], "partial", "{r}");
        assert_eq!(r["exit"], 3);
        assert_eq!(r["evidence"]["candidates"][0]["inclusion"], "excluded");
        assert_eq!(r["evidence"]["candidates"][1]["inclusion"], "unverified");
        assert_eq!(r["evidence"]["suggested_issue_ids"], json!([]));
    }
}
#[test]
fn unknown_cherry_pick_and_unpromoted_native_anchors_are_not_inferred_from_titles() {
    let (f, base, associations) = fixture("github", "dev");
    let head = git(&f, &["rev-parse", "HEAD"]);
    f.edit(|s| {
        s["requests"].as_array_mut().unwrap().push(request(
            "github",
            44,
            "work-unpromoted",
            "dev",
            &head,
            Some(&base),
            "Closes #1",
        ))
    });
    routes(&f, "github", &base, &associations);
    let r = f.run(&["promotion", "--request", "41", "--source-request", "44"]);
    assert_eq!(r["status"], "partial", "{r}");
    assert_eq!(r["evidence"]["candidates"][2]["inclusion"], "unverified");
    assert!(
        r["evidence"]["candidates"][2]["reason"]
            .as_str()
            .unwrap()
            .contains("cherry-picked")
    );
}
#[test]
fn dirty_or_wrong_source_promotion_cannot_offer_associations() {
    let (f, _, _) = fixture("github", "dev");
    fs::write(f.root.join("unrelated"), "dirty").unwrap();
    assert_eq!(f.run(&["promotion", "--request", "41"])["exit"], 3);
}

#[test]
fn complete_squash_is_supported_without_treating_a_partial_one_parent_commit_as_complete() {
    for provider in ["github", "gitlab"] {
        let f = Fixture::new(provider);
        let base = git(&f, &["rev-parse", "HEAD"]);
        git(&f, &["branch", "-m", "dev"]);
        git(&f, &["branch", "main"]);
        git(&f, &["checkout", "-b", "work-squash"]);
        for (file, content) in [("first", "one"), ("second", "two")] {
            fs::write(f.root.join(file), content).unwrap();
            git(&f, &["add", file]);
            git(&f, &["commit", "-m", "source feature"]);
        }
        let source_head = git(&f, &["rev-parse", "HEAD"]);
        git(&f, &["checkout", "dev"]);
        git(&f, &["merge", "--squash", "work-squash"]);
        git(&f, &["commit", "-m", "squash feature"]);
        let anchor = git(&f, &["rev-parse", "HEAD"]);
        f.edit(|s| {
            s["request_fixture"]=json!(true);s["read_routes"]=json!({});
            let mut source=request(provider,42,"work-squash","dev",&source_head, Some(&anchor),"Closes #1");
            if provider=="gitlab" {source["squash_commit_sha"]=json!(anchor);}
            s["requests"]=json!([request(provider,41,"dev","main",&anchor, None,""),source]);
            s["issues"]=json!([{"number":1,"iid":1,"project_id":7,"title":"feat: squash","body":"spec","description":"spec","labels":[],"state":"open","updated_at":"stable"}]);
        });
        routes(&f, provider, &base, &[(anchor.clone(), 42)]);
        let r = f.run(&["promotion", "--request", "41"]);
        assert_eq!(
            r["evidence"]["suggested_issue_ids"],
            json!([1]),
            "{provider}: {r}"
        );
        assert_eq!(r["evidence"]["candidates"][0]["inclusion"], "included");
        if provider == "github" {
            git(&f, &["checkout", "-b", "partial", "main"]);
            fs::write(f.root.join("second"), "two").unwrap();
            git(&f, &["add", "second"]);
            git(&f, &["commit", "-m", "only final rebased change"]);
            let partial = git(&f, &["rev-parse", "HEAD"]);
            f.edit(|s| {
                s["requests"][0]["head"]["ref"] = json!("partial");
                s["requests"][0]["source_branch"] = json!("partial");
                s["requests"][1]["base"]["ref"] = json!("partial");
                s["requests"][1]["target_branch"] = json!("partial");
                s["requests"][1]["merge_commit_sha"] = json!(partial);
            });
            routes(&f, provider, &base, &[(partial, 42)]);
            let r = f.run(&["promotion", "--request", "41"]);
            assert_eq!(
                r["evidence"]["candidates"][0]["inclusion"], "unverified",
                "{r}"
            );
            assert_eq!(r["evidence"]["suggested_issue_ids"], json!([]));
        }
    }
}
#[test]
fn native_association_read_failure_and_shallow_history_never_become_empty_success() {
    let (f, _, _) = fixture("github", "dev");
    f.edit(|s| s["read_failure"] = json!("auth"));
    let r = f.run(&["promotion", "--request", "41"]);
    assert_eq!(r["exit"], 3);
    assert!(r["evidence"].get("suggested_issue_ids").is_none());
    f.edit(|s| s["read_failure"] = Value::Null);
    let head = git(&f, &["rev-parse", "HEAD"]);
    fs::write(f.root.join(".git/shallow"), format!("{head}\n")).unwrap();
    let r = f.run(&["promotion", "--request", "41"]);
    assert_eq!(r["exit"], 3);
    assert!(
        r["diagnostics"][0]["message"]
            .as_str()
            .unwrap()
            .contains("unshallow"),
        "{r}"
    );
}

#[test]
fn fresh_clone_recovers_merge_associations_after_source_branches_are_deleted() {
    let (mut f, _, _) = fixture("github", "dev");
    let clone = f.root.parent().unwrap().join("fresh-clone");
    let result = Command::new("git")
        .args([
            "clone",
            "--no-local",
            f.root.to_str().unwrap(),
            clone.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(result.status.success());
    f.root = clone;
    git(
        &f,
        &[
            "remote",
            "set-url",
            "origin",
            "https://forge.example/fixture/repo.git",
        ],
    );
    let r = f.run(&["promotion", "--request", "41"]);
    assert_eq!(r["evidence"]["suggested_issue_ids"], json!([1, 2]), "{r}");
}
