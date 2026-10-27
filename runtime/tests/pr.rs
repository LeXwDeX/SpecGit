#![cfg(feature = "test-fixtures")]
#[path = "support/delivery.rs"]
mod delivery;
use delivery::Fixture;
use serde_json::{Value, json};
use std::{fs, path::Path, process::Command};
fn git(root: &Path, args: &[&str]) -> std::process::Output {
    Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap()
}
fn native_issue(provider: &str, number: u64) -> Value {
    json!({
        "number":number,
        "iid":number,
        "project_id":7,
        "title":format!("fix: adopted spec {number}"),
        "body":format!("Specification {number} WHY"),
        "description":format!("Specification {number} WHY"),
        "labels":if provider == "github" {
            json!([{"name":"kind::fix"}])
        } else {
            json!(["kind::fix"])
        },
        "state":if provider == "github" { "open" } else { "opened" },
        "updated_at":"2026-10-01T00:00:00Z",
        "html_url":format!("https://forge.example/fixture/repo/issues/{number}"),
        "web_url":format!("https://forge.example/fixture/repo/-/issues/{number}")
    })
}
fn install_guard(f: &Fixture) {
    let binary = delivery::executable::binary().canonicalize().unwrap();
    let mut paths = vec![binary.parent().unwrap().to_owned()];
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    let output = f
        .command(&["guard", "--install"])
        .env("PATH", std::env::join_paths(paths).unwrap())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let binary = binary.to_string_lossy().replace('\\', "/");
    // Windows canonical UNC paths keep the host: \\?\UNC\server\share -> //server/share.
    let binary = match binary.strip_prefix("//?/UNC/") {
        Some(unc) => format!("//{unc}"),
        None => binary.strip_prefix("//?/").unwrap_or(&binary).to_owned(),
    };
    for stage in ["pre-commit", "pre-push"] {
        let hook = fs::read_to_string(f.root.join(".git/hooks").join(stage)).unwrap();
        assert!(
            hook.contains(binary.as_str()),
            "{stage} does not bind {binary}: {hook}"
        );
        assert!(
            hook.contains(&format!("guard --stage {stage}")),
            "{stage}: {hook}"
        );
    }
}
fn installed_guard_accepts_commit_and_push(f: &Fixture, provider: &str) {
    let remote = tempfile::tempdir().unwrap();
    assert!(
        Command::new("git")
            .current_dir(remote.path())
            .args(["init", "--bare", "-q"])
            .output()
            .unwrap()
            .status
            .success()
    );
    let local = remote.path().to_str().unwrap();
    assert!(
        git(&f.root, &["remote", "add", "local", local])
            .status
            .success()
    );
    // Fixture setup finishes before the guard; every later commit and push
    // must pass the installed hooks without a bypass.
    assert!(
        git(&f.root, &["push", "-q", "local", "feature:main"])
            .status
            .success()
    );
    assert!(git(&f.root, &["fetch", "-q", "local"]).status.success());
    install_guard(f);
    fs::write(f.root.join("guarded.txt"), "guarded change").unwrap();
    assert!(git(&f.root, &["add", "guarded.txt"]).status.success());
    let unbound = git(&f.root, &["commit", "-q", "-m", "guarded change"]);
    assert!(
        unbound.status.success(),
        "{provider} pre-commit rejected the adopted checkpoint: {}",
        String::from_utf8_lossy(&unbound.stderr)
    );
    // A real push without the trailer fails in the installed hook, not in Git.
    let rejected = git(&f.root, &["push", "-q", "local", "feature"]);
    assert!(
        !rejected.status.success(),
        "{provider} pre-push accepted a commit without an Issue trailer"
    );
    assert!(
        String::from_utf8_lossy(&rejected.stderr).contains("Issue: #N"),
        "{provider} pre-push did not report the missing trailer: {}",
        String::from_utf8_lossy(&rejected.stderr)
    );
    let commit = git(
        &f.root,
        &[
            "commit",
            "-q",
            "--amend",
            "--no-edit",
            "--trailer",
            "Issue: #1",
        ],
    );
    assert!(
        commit.status.success(),
        "{provider} pre-commit rejected the adopted checkpoint: {}",
        String::from_utf8_lossy(&commit.stderr)
    );
    let push = git(&f.root, &["push", "-q", "local", "feature"]);
    assert!(
        push.status.success(),
        "{provider} pre-push rejected the adopted checkpoint: {}",
        String::from_utf8_lossy(&push.stderr)
    );
}
fn fixture(provider: &str, count: usize) -> Fixture {
    let f = Fixture::new(provider);
    let mut args = vec!["issue", "--create-labels", "feat: first spec"];
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
fn clear_request_binding(f: &Fixture) {
    let path = f.root.join(".git/specgit-v2/selection.json");
    let mut saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    saved["request"] = json!(null);
    saved["request_write_started"] = json!(false);
    saved["request_intent"] = json!(null);
    fs::write(&path, serde_json::to_vec(&saved).unwrap()).unwrap();
}

#[test]
fn gitlab_locked_candidate_blocks_mutations_but_previews_unknown_identity() {
    let f = fixture("gitlab", 1);
    assert_eq!(f.run(&["pr"])["exit"], 0);
    clear_request_binding(&f);
    f.edit(|s| {
        s["requests"][0]["state"] = json!("locked");
        s["requests"][0]["head"]["sha"] = json!("b".repeat(40));
        s["requests"][0]["sha"] = json!("b".repeat(40));
    });
    let checkpoint_path = f.root.join(".git/specgit-v2/selection.json");
    let checkpoint = fs::read(&checkpoint_path).unwrap();
    let requests = f.state()["requests"].clone();
    let writes = f.writes();

    for args in [
        vec!["pr", "--dry-run"],
        vec!["pr", "--inspect"],
        vec!["pr", "--ready", "--dry-run"],
    ] {
        let preview = f.run(&args);
        assert_eq!(preview["exit"], 0, "{args:?}: {preview}");
        assert_eq!(
            preview["evidence"]["request"]["id"], 41,
            "{args:?}: {preview}"
        );
        assert_eq!(
            preview["evidence"]["request"]["state"], "locked",
            "{args:?}: {preview}"
        );
        assert_eq!(
            preview["evidence"]["create_request"], false,
            "{args:?}: {preview}"
        );
        assert_eq!(
            preview["evidence"]["native_lifecycle"], "unknown",
            "{args:?}: {preview}"
        );
        assert_eq!(
            preview["evidence"]["head_verification"], "not_checked",
            "{args:?}: {preview}"
        );
        assert_eq!(
            preview["evidence"]["transient_state"], "locked",
            "{args:?}: {preview}"
        );
        assert_eq!(preview["evidence"]["writes"], false, "{args:?}: {preview}");
        assert_eq!(f.writes(), writes, "{args:?}: {preview}");
        assert_eq!(fs::read(&checkpoint_path).unwrap(), checkpoint, "{args:?}");
        assert_eq!(f.state()["requests"], requests, "{args:?}");
    }

    for args in [vec!["pr"], vec!["pr", "--ready"]] {
        let result = f.run(&args);
        assert_eq!(result["exit"], 3, "{args:?}: {result}");
        assert_eq!(
            result["diagnostics"][0]["code"], "unsupported_operation",
            "{args:?}: {result}"
        );
        assert_eq!(
            result["diagnostics"][0]["operation"], "request_lifecycle",
            "{args:?}: {result}"
        );
        assert_eq!(f.writes(), writes, "{args:?}");
        assert_eq!(fs::read(&checkpoint_path).unwrap(), checkpoint, "{args:?}");
        assert_eq!(f.state()["requests"], requests, "{args:?}");
    }

    fs::write(f.root.join("locked-body.md"), "Locked update\n\nCloses #1").unwrap();
    let update = f.run(&["pr", "--update-body", "--body-file", "locked-body.md"]);
    assert_eq!(update["exit"], 3, "{update}");
    assert_eq!(
        update["diagnostics"][0]["code"], "unsupported_operation",
        "{update}"
    );
    assert_eq!(update["diagnostics"][0]["operation"], "request_lifecycle");
    assert_eq!(f.writes(), writes, "{update}");
    assert_eq!(fs::read(&checkpoint_path).unwrap(), checkpoint, "{update}");
    assert_eq!(f.state()["requests"], requests, "{update}");
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
        assert_eq!(r["effects"]["outcome"], "unknown", "{r}");
        assert!(
            r["effects"]["operations"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["action"] == "create_request" && e["outcome"] == "unknown")
        );
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
fn explicit_body_update_previews_all_refs_but_never_overwrites_native_content() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider, 2);
        assert_eq!(f.run(&["pr"])["exit"], 0);
        fs::write(f.root.join("prepared.md"), "Prepared replacement").unwrap();
        let before = f.state()["requests"].clone();
        let writes = f.writes();
        let preview = f.run(&[
            "pr",
            "--update-body",
            "--body-file",
            "prepared.md",
            "--dry-run",
        ]);
        assert_eq!(preview["exit"], 0, "{preview}");
        let body = preview["evidence"]["intent"]["body"].as_str().unwrap();
        assert!(body.contains("Closes #1") && body.contains("Closes #2"));
        let rejected = f.run(&["pr", "--update-body", "--body-file", "prepared.md"]);
        assert_eq!(
            rejected["diagnostics"][0]["code"], "unsupported_operation",
            "{rejected}"
        );
        assert_eq!(f.writes(), writes);
        assert_eq!(f.state()["requests"], before);
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
    let r = f.run(&["pr", "--update-references", "--dry-run"]);
    assert_eq!(r["exit"], 0, "{r}");
    assert_eq!(
        r["evidence"]["intent"]["body"],
        "User removed reference\n\nCloses #1"
    );
}

#[test]
fn pending_labels_conflicting_with_native_edits_stop_before_any_write() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider, 1);
        f.edit(|s| s["lose_request_response"] = json!(true));
        assert_eq!(f.run(&["pr"])["exit"], 3);
        f.edit(|s| {
            s["requests"][0]["labels"] = if provider == "github" {
                json!([{"name":"kind::fix"}])
            } else {
                json!(["kind::fix"])
            };
        });
        fs::write(f.root.join("replacement.md"), "New body").unwrap();
        let before = f.state()["requests"].clone();
        let writes = f.writes();
        let result = f.run(&[
            "pr",
            "--request",
            "41",
            "--update-body",
            "--body-file",
            "replacement.md",
        ]);
        assert_eq!(result["exit"], 2, "{result}");
        assert_eq!(f.writes(), writes);
        assert_eq!(f.state()["requests"], before);
    }
}
#[test]
fn alternate_native_closing_keywords_survive_body_replacement() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider, 2);
        assert_eq!(f.run(&["pr"])["exit"], 0);
        // Make #2 a deliberate native association outside the saved selection.
        let selection = f.root.join(".git/specgit-v2/selection.json");
        let mut saved: serde_json::Value =
            serde_json::from_slice(&fs::read(&selection).unwrap()).unwrap();
        saved["issues"] = json!([1]);
        saved["adopted"]
            .as_array_mut()
            .unwrap()
            .retain(|issue| issue["id"] == 1);
        saved["intents"]
            .as_array_mut()
            .unwrap()
            .retain(|intent| intent["issue"] == 1);
        fs::write(selection, serde_json::to_vec(&saved).unwrap()).unwrap();
        f.edit(|s| {
            s["requests"][0][if provider == "github" {
                "body"
            } else {
                "description"
            }] = json!("closes #1\nFixes #2\n```\nResolves other/repo#9\n```\n<!-- Fixes #10 -->");
        });
        fs::write(f.root.join("replacement.md"), "New body").unwrap();
        let result = f.run(&[
            "pr",
            "--update-body",
            "--body-file",
            "replacement.md",
            "--dry-run",
        ]);
        assert_eq!(result["exit"], 0, "{result}");
        let body = result["evidence"]["intent"]["body"].as_str().unwrap();
        assert!(
            body.contains("Closes #1") && body.contains("Closes #2"),
            "{body}"
        );
        assert!(!body.contains("#9") && !body.contains("#10"));
    }
}
#[test]
fn unsupported_native_closing_forms_cannot_be_erased_by_body_replacement() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider, 1);
        assert_eq!(f.run(&["pr"])["exit"], 0);
        fs::write(f.root.join("replacement.md"), "New body").unwrap();
        for reference in [
            "fixes other/repo#2",
            "Text resolves #2",
            "- Closes #2",
            "CLOSES #1, #2",
        ] {
            f.edit(|s| {
                s["requests"][0][if provider == "github" {
                    "body"
                } else {
                    "description"
                }] = json!(format!("Closes #1\n{reference}"));
            });
            let before = f.state()["requests"].clone();
            let writes = f.writes();
            let result = f.run(&["pr", "--update-body", "--body-file", "replacement.md"]);
            assert_eq!(result["exit"], 2, "{reference}: {result}");
            assert_eq!(f.writes(), writes);
            assert_eq!(f.state()["requests"], before);
        }
    }
}

#[test]
fn branch_lookup_prefers_open_and_only_adopts_terminal_requests_at_local_head() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider, 1);
        assert_eq!(f.run(&["pr"])["exit"], 0);
        let selection = f.root.join(".git/specgit-v2/selection.json");
        let mut saved: serde_json::Value =
            serde_json::from_slice(&fs::read(&selection).unwrap()).unwrap();
        saved["request"] = json!(null);
        saved["request_write_started"] = json!(false);
        saved["request_intent"] = json!(null);
        fs::write(&selection, serde_json::to_vec(&saved).unwrap()).unwrap();
        f.edit(|s| {
            s["requests"][0]["state"] = json!(if provider == "github" {
                "closed"
            } else {
                "merged"
            });
            s["requests"][0]["merged"] = json!(true);
        });
        let preview = f.run(&["pr", "--dry-run"]);
        assert_eq!(preview["evidence"]["create_request"], false, "{preview}");
        f.edit(|s| {
            s["requests"][0]["head"]["sha"] = json!("b".repeat(40));
            s["requests"][0]["sha"] = json!("b".repeat(40));
        });
        let preview = f.run(&["pr", "--dry-run"]);
        assert_eq!(preview["evidence"]["create_request"], true, "{preview}");
        let status = f.run(&["pr", "--status"]);
        assert_ne!(status["status"], "merged", "{status}");
        assert_eq!(f.run(&["pr"])["exit"], 0);
        let mut saved: serde_json::Value =
            serde_json::from_slice(&fs::read(&selection).unwrap()).unwrap();
        saved["request"] = json!(null);
        saved["request_write_started"] = json!(false);
        saved["request_intent"] = json!(null);
        fs::write(&selection, serde_json::to_vec(&saved).unwrap()).unwrap();
        let preview = f.run(&["pr", "--dry-run"]);
        assert_eq!(preview["evidence"]["request"]["id"], 42, "{preview}");
        assert_eq!(preview["evidence"]["create_request"], false);
    }
}

#[test]
fn branch_lookup_ignores_fork_mrs_and_deleted_github_forks() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider, 1);
        assert_eq!(f.run(&["pr"])["exit"], 0);
        let selection = f.root.join(".git/specgit-v2/selection.json");
        let mut saved: serde_json::Value =
            serde_json::from_slice(&fs::read(&selection).unwrap()).unwrap();
        saved["request"] = json!(null);
        saved["request_write_started"] = json!(false);
        saved["request_intent"] = json!(null);
        fs::write(&selection, serde_json::to_vec(&saved).unwrap()).unwrap();
        f.edit(|s| {
            let mut fork = s["requests"][0].clone();
            fork["number"] = json!(99);
            fork["iid"] = json!(99);
            if provider == "gitlab" {
                fork["source_project_id"] = json!(99);
            } else {
                fork["head"]["repo"] = json!(null);
            }
            s["requests"].as_array_mut().unwrap().push(fork);
        });
        let preview = f.run(&["pr", "--dry-run"]);
        assert_eq!(preview["evidence"]["request"]["id"], 41, "{preview}");
        f.edit(|s| {
            s["requests"].as_array_mut().unwrap().remove(0);
        });
        let preview = f.run(&["pr", "--dry-run"]);
        assert_eq!(preview["evidence"]["create_request"], true, "{preview}");
    }
}

#[test]
fn github_existing_request_labels_keep_native_case_without_duplicate_writes() {
    let f = fixture("github", 1);
    f.edit(|s| s["labels"][0]["name"] = json!("Kind::Feat"));
    let result = f.run(&["pr"]);
    assert_eq!(result["exit"], 0, "{result}");
    f.edit(|s| s["requests"][0]["labels"][0]["name"] = json!("Kind::Feat"));
    let writes = f.writes();
    let result = f.run(&["pr"]);
    assert_eq!(result["exit"], 0, "{result}");
    assert_eq!(
        result["evidence"]["request"]["labels"][0], "Kind::Feat",
        "{result}"
    );
    assert_eq!(f.writes(), writes);
}

#[test]
fn newly_referenced_issues_are_adopted_and_installed_guards_accept_the_checkpoint() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider, 1);
        f.edit(|s| {
            s["issues"]
                .as_array_mut()
                .unwrap()
                .push(native_issue(provider, 2))
        });
        fs::write(
            f.root.join("body.md"),
            "Preserved user body\n\nCloses #2\nCloses #2",
        )
        .unwrap();
        let created = f.run(&["pr", "--body-file", "body.md"]);
        assert_eq!(created["exit"], 0, "{provider}: {created}");
        assert_eq!(
            created["evidence"]["request"]["body"],
            "Preserved user body\n\nCloses #2\nCloses #2\n\nCloses #1",
            "{provider}: {created}"
        );
        let checkpoint: Value = serde_json::from_slice(
            &fs::read(f.root.join(".git/specgit-v2/selection.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(checkpoint["issues"], json!([1, 2]), "{provider}");
        let adopted: Vec<u64> = checkpoint["adopted"]
            .as_array()
            .unwrap()
            .iter()
            .map(|issue| issue["id"].as_u64().unwrap())
            .collect();
        assert_eq!(adopted, vec![1, 2], "{provider}: {checkpoint}");
        installed_guard_accepts_commit_and_push(&f, provider);
    }
}

#[test]
fn reference_union_limit_is_checked_before_checkpoint_or_native_writes() {
    for provider in ["github", "gitlab"] {
        // 101 unique references: the selected #1 plus a body of #2..#101.
        let f = fixture(provider, 1);
        f.edit(|s| {
            let issues = s["issues"].as_array_mut().unwrap();
            for id in 2..=101 {
                issues.push(native_issue(provider, id));
            }
        });
        let overflow = (2..=101)
            .map(|id| format!("Closes #{id}"))
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(f.root.join("overflow.md"), &overflow).unwrap();
        let checkpoint = f.root.join(".git/specgit-v2/selection.json");
        let before = fs::read(&checkpoint).unwrap();
        let writes = f.writes();
        let rejected = f.run(&["pr", "--body-file", "overflow.md"]);
        assert_ne!(rejected["exit"], 0, "{provider}: {rejected}");
        assert_eq!(f.writes(), writes, "{provider}: {rejected}");
        assert_eq!(fs::read(&checkpoint).unwrap(), before, "{provider}");

        // 100 unique references, including a duplicate body reference.
        let f = fixture(provider, 1);
        f.edit(|s| {
            let issues = s["issues"].as_array_mut().unwrap();
            for id in 2..=100 {
                issues.push(native_issue(provider, id));
            }
        });
        let mut boundary = String::from("Preserved boundary body\nCloses #2\n");
        for id in 2..=100 {
            boundary.push_str(&format!("Closes #{id}\n"));
        }
        fs::write(f.root.join("boundary.md"), boundary).unwrap();
        let calls = f.state()["calls"].as_array().unwrap().len();
        let created = f.run(&["pr", "--body-file", "boundary.md"]);
        assert_eq!(created["exit"], 0, "{provider}: {created}");
        let state = f.state();
        let new_writes: Vec<_> = state["calls"].as_array().unwrap()[calls..]
            .iter()
            .filter(|call| call["method"] != "GET")
            .map(|call| {
                (
                    call["method"].as_str().unwrap(),
                    call["endpoint"].as_str().unwrap(),
                )
            })
            .collect();
        assert_eq!(new_writes.len(), 2, "{provider}: {new_writes:?}");
        assert!(
            new_writes.iter().any(|(method, endpoint)| *method == "POST"
                && (endpoint.ends_with("/pulls") || endpoint.ends_with("/merge_requests"))),
            "{provider}: {new_writes:?}"
        );
        // GitHub adds labels through its labels endpoint; GitLab updates the MR.
        assert!(
            new_writes.iter().any(|(method, endpoint)| {
                (*method == "POST" && endpoint.ends_with("/labels"))
                    || (*method == "PUT" && endpoint.contains("/merge_requests/"))
            }),
            "{provider}: {new_writes:?}"
        );
        let checkpoint: Value = serde_json::from_slice(
            &fs::read(f.root.join(".git/specgit-v2/selection.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            checkpoint["issues"].as_array().unwrap().len(),
            100,
            "{provider}: {checkpoint}"
        );
        let adopted = checkpoint["adopted"].as_array().unwrap();
        assert_eq!(adopted.len(), 100, "{provider}: {checkpoint}");

        // Adoption of a native body must reject the same 101-reference union.
        let adoption = fixture(provider, 1);
        adoption.edit(|s| {
            let issues = s["issues"].as_array_mut().unwrap();
            for id in 2..=101 {
                issues.push(native_issue(provider, id));
            }
        });
        assert_eq!(adoption.run(&["pr"])["exit"], 0);
        adoption.edit(|s| {
            s["requests"][0][if provider == "github" {
                "body"
            } else {
                "description"
            }] = json!(overflow);
        });
        let checkpoint = adoption.root.join(".git/specgit-v2/selection.json");
        let before = fs::read(&checkpoint).unwrap();
        let writes = adoption.writes();
        let rejected = adoption.run(&["pr", "--update-references", "--dry-run"]);
        assert_ne!(rejected["exit"], 0, "{provider}: {rejected}");
        assert_eq!(adoption.writes(), writes, "{provider}: {rejected}");
        assert_eq!(fs::read(&checkpoint).unwrap(), before, "{provider}");
    }
}

#[test]
fn gitlab_implement_references_are_adopted_and_preserved() {
    let f = fixture("gitlab", 1);
    assert_eq!(f.run(&["pr"])["exit"], 0);
    f.edit(|s| s["requests"][0]["description"] = json!("Implements #1"));
    let result = f.run(&["pr", "--update-references", "--dry-run"]);
    assert_eq!(result["exit"], 0, "{result}");
    assert_eq!(
        result["evidence"]["intent"]["body"], "Implements #1",
        "{result}"
    );
}

#[test]
fn existing_request_references_are_adopted_and_installed_guards_accept_the_checkpoint() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider, 1);
        f.edit(|s| {
            s["issues"]
                .as_array_mut()
                .unwrap()
                .push(native_issue(provider, 2))
        });
        assert_eq!(f.run(&["pr"])["exit"], 0);
        f.edit(|s| {
            s["requests"][0][if provider == "github" {
                "body"
            } else {
                "description"
            }] = json!("Preserved existing body\n\nCloses #1\nCloses #2");
        });
        let writes = f.writes();
        let adopted = f.run(&["pr", "--request", "41"]);
        assert_eq!(adopted["exit"], 0, "{provider}: {adopted}");
        assert_eq!(f.writes(), writes, "{provider}: {adopted}");
        assert_eq!(
            adopted["evidence"]["request"]["body"],
            "Preserved existing body\n\nCloses #1\nCloses #2",
            "{provider}: {adopted}"
        );
        let checkpoint: Value = serde_json::from_slice(
            &fs::read(f.root.join(".git/specgit-v2/selection.json")).unwrap(),
        )
        .unwrap();
        let ids: Vec<u64> = checkpoint["adopted"]
            .as_array()
            .unwrap()
            .iter()
            .map(|issue| issue["id"].as_u64().unwrap())
            .collect();
        assert_eq!(ids, vec![1, 2], "{provider}: {checkpoint}");
        installed_guard_accepts_commit_and_push(&f, provider);
    }
}

#[test]
fn kind_mode_request_tags_must_match_the_title_type() {
    for provider in ["github", "gitlab"] {
        let f = fixture(provider, 1);
        let mismatch = f.run(&[
            "pr",
            "--title",
            "feat: first spec",
            "--tags",
            "kind::fix",
            "--dry-run",
        ]);
        assert_eq!(mismatch["exit"], 2, "{mismatch}");
        assert!(mismatch.to_string().contains("`kind::feat`"), "{mismatch}");
        let matching = f.run(&[
            "pr",
            "--title",
            "feat: first spec",
            "--tags",
            "kind::feat",
            "--dry-run",
        ]);
        assert_eq!(matching["exit"], 0, "{matching}");
    }
}
