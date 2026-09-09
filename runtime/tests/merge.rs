#![cfg(feature = "test-fixtures")]
#[path = "support/acceptance.rs"]
mod acceptance;
#[path = "support/delivery.rs"]
mod delivery;
use acceptance::fixture;
use serde_json::json;
fn command(mode: &str) -> [&str; 7] {
    [
        "merge",
        "--request",
        "41",
        "--mode",
        mode,
        "--strategy",
        "squash",
    ]
}
#[test]
fn native_merge_checks_head_and_reports_real_closure_without_fallback() {
    for provider in ["github", "gitlab"] {
        for closed in [false, true] {
            let f = fixture(provider);
            f.edit(|s| s["close_on_merge"] = json!(closed));
            let writes = f.writes();
            let r = f.run(&command("now"));
            assert_eq!(
                r["status"],
                if closed {
                    "completed"
                } else {
                    "merged_issues_open"
                },
                "{provider}: {r}"
            );
            assert_eq!(f.writes(), writes + 1);
            assert_eq!(f.run(&command("now"))["status"], r["status"]);
            assert_eq!(f.writes(), writes + 1);
        }
    }
}
#[test]
fn auto_merge_and_lost_response_recover_only_from_native_readback() {
    for provider in ["github", "gitlab"] {
        for response in ["queued", "lost_queued", "lost_merged"] {
            let f = fixture(provider);
            f.edit(|s| {
                s["merge_response"] = json!(response);
                s["close_on_merge"] = json!(true);
            });
            let writes = f.writes();
            let r = f.run(&command("auto"));
            assert_eq!(
                r["status"],
                if response == "lost_merged" {
                    "completed"
                } else {
                    "queued"
                },
                "{provider}: {r}"
            );
            assert_eq!(f.run(&command("auto"))["status"], r["status"]);
            assert_eq!(f.writes(), writes + 1);
            let state = f.state();
            if provider == "gitlab" {
                assert_eq!(state["effective_merge"]["auto_merge"], true);
            }
            let call = state["calls"]
                .as_array()
                .unwrap()
                .iter()
                .rev()
                .find(|v| v["method"] == "NATIVE")
                .unwrap();
            assert!(
                call["argv"]
                    .as_array()
                    .unwrap()
                    .contains(&json!(if provider == "github" {
                        "--auto"
                    } else {
                        "--auto-merge=true"
                    }))
            );
        }
    }
}
#[test]
fn denied_or_opaque_success_never_resubmits_or_falls_back() {
    for provider in ["github", "gitlab"] {
        for response in ["denied", "opaque"] {
            let f = fixture(provider);
            f.edit(|s| s["merge_response"] = json!(response));
            let writes = f.writes();
            assert_eq!(f.run(&command("auto"))["exit"], 3);
            assert_eq!(f.run(&command("now"))["exit"], 3);
            assert_eq!(f.writes(), writes + 1);
        }
    }
}
#[test]
fn draft_failed_checks_dirty_tree_and_changed_request_refuse_before_write() {
    for fault in ["draft", "failed", "dirty", "edit"] {
        let f = fixture("github");
        f.edit(|s| {
            if fault == "draft" {
                s["requests"][0]["draft"] = json!(true);
            }
            if fault == "failed" {
                for (route, value) in s["read_routes"].as_object_mut().unwrap() {
                    if route.contains("/actions/runs?") {
                        value["workflow_runs"][0]["conclusion"] = json!("failure");
                    }
                }
            }
            if fault == "edit" {
                s["request_reads"] = json!(0);
                s["edit_request_on_read"] = json!(4);
            }
        });
        if fault == "dirty" {
            std::fs::write(f.root.join("untracked"), "dirty").unwrap();
        }
        let writes = f.writes();
        let r = f.run(&command("now"));
        assert_ne!(r["exit"], 0, "{fault}: {r}");
        assert_eq!(f.writes(), writes);
    }
}
#[test]
fn gitlab_unverified_train_routing_and_rebase_have_no_write_capability() {
    for value in [json!(true), serde_json::Value::Null] {
        let f = fixture("gitlab");
        f.edit(|s| s["project"]["merge_trains_enabled"] = value);
        let writes = f.writes();
        assert_eq!(f.run(&command("auto"))["exit"], 3);
        assert_eq!(f.writes(), writes);
    }
    let f = fixture("gitlab");
    let writes = f.writes();
    assert_eq!(
        f.run(&[
            "merge",
            "--request",
            "41",
            "--mode",
            "auto",
            "--strategy",
            "rebase"
        ])["exit"],
        3
    );
    assert_eq!(f.writes(), writes);
}

#[test]
fn explicit_gitlab_strategy_overrides_native_squash_default() {
    for strategy in ["merge", "squash"] {
        let f = fixture("gitlab");
        f.edit(|s| {
            s["requests"][0]["squash"] = json!(strategy == "merge");
            s["project"]["squash_option"] = json!(if strategy == "merge" {
                "never"
            } else {
                "default_off"
            });
            s["close_on_merge"] = json!(true);
        });
        let r = f.run(&[
            "merge",
            "--request",
            "41",
            "--mode",
            "now",
            "--strategy",
            strategy,
        ]);
        assert_eq!(r["status"], "completed", "{r}");
        let state = f.state();
        assert_eq!(state["effective_merge"]["squash"], strategy == "squash");
        let call = state["calls"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|v| v["method"] == "NATIVE")
            .unwrap();
        assert!(
            call["argv"]
                .as_array()
                .unwrap()
                .contains(&json!(if strategy == "merge" {
                    "--squash=false"
                } else {
                    "--squash=true"
                }))
        );
    }
}

#[test]
fn glab_no_pipeline_auto_and_unenforceable_squash_are_rejected_before_intent() {
    for fault in [
        "no_pipeline",
        "optional_squash",
        "unknown_squash",
        "required_squash",
    ] {
        let f = fixture("gitlab");
        f.edit(|s| {
            if fault == "no_pipeline" {
                s["requests"][0]["head_pipeline"] = serde_json::Value::Null;
                s["project"]["only_allow_merge_if_pipeline_succeeds"] = json!(false);
            } else {
                s["requests"][0]["squash"] = json!(true);
                s["project"]["squash_option"] = match fault {
                    "optional_squash" => json!("default_on"),
                    "required_squash" => json!("always"),
                    _ => serde_json::Value::Null,
                };
            }
        });
        let writes = f.writes();
        let strategy = if fault == "no_pipeline" {
            "squash"
        } else {
            "merge"
        };
        assert_eq!(
            f.run(&[
                "merge",
                "--request",
                "41",
                "--mode",
                "auto",
                "--strategy",
                strategy
            ])["exit"],
            3
        );
        assert_eq!(f.writes(), writes);
        let state_dir = f.root.join(".git/specgit-v2");
        assert!(!std::fs::read_dir(state_dir).unwrap().any(|e| {
            e.unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("merge-")
        }));
    }
}

#[test]
fn glab_consumed_pipeline_must_match_the_current_head_pipeline() {
    for fault in ["absent", "null", "wrong_head", "wrong_id"] {
        let f = fixture("gitlab");
        f.edit(|s| {
            let request = &mut s["requests"][0];
            match fault {
                "absent" => {
                    request.as_object_mut().unwrap().remove("pipeline");
                }
                "null" => request["pipeline"] = serde_json::Value::Null,
                "wrong_head" => request["pipeline"]["sha"] = json!("f".repeat(40)),
                _ => request["pipeline"]["id"] = json!(72),
            }
        });
        let writes = f.writes();
        assert_eq!(f.run(&command("auto"))["exit"], 3, "{fault}");
        assert_eq!(f.writes(), writes);
    }
}
