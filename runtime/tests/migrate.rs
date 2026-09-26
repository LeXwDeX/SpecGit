#![cfg(feature = "test-fixtures")]
#[path = "support/delivery.rs"]
mod delivery;
use delivery::Fixture;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
const MAIN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
fn git(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "{:?}", out.stderr);
    String::from_utf8(out.stdout).unwrap().trim().into()
}
fn fixture(provider: &str) -> (Fixture, PathBuf) {
    let f = Fixture::new(provider);
    let selected = f.root.parent().unwrap().join("next.yaml");
    fs::write(
        &selected,
        format!("version: 2\nremote: origin\nprovider: {provider}\nlanguage: zh\n"),
    )
    .unwrap();
    fs::write(
        f.root.join(".specgit.yaml"),
        "version: 1\ndelivery: unfinished\nissues: [1, 2]\npr: 41\n",
    )
    .unwrap();
    fs::create_dir_all(f.root.join("spec_git/scopes")).unwrap();
    fs::write(
        f.root.join("spec_git/policy.yaml"),
        "version: 1\nautomation:\n  merge: true\n",
    )
    .unwrap();
    fs::write(
        f.root.join("spec_git/scopes/old.yaml"),
        "private retained programme\n",
    )
    .unwrap();
    fs::write(f.root.join("AGENTS.md"),"Human prefix\n<!-- specgit:block:start -->\nold contract\n<!-- specgit:block:end -->\nHuman suffix\n").unwrap();
    fs::write(f.root.join(".gitignore"),"keep\n# >>> specgit: local delivery assets (managed by specgit init) >>>\n/spec_git\n# <<< specgit: local delivery assets (managed by specgit init) <<<\nother\n").unwrap();
    fs::create_dir_all(f.root.join(".github/workflows")).unwrap();
    fs::write(
        f.root.join(".github/workflows/specgit-complete.yml"),
        "# Managed by SpecGit: trusted delivery completion.\nname: SpecGit Completion\n",
    )
    .unwrap();
    fs::write(
        f.root.join(".github/workflows/business.yml"),
        "name: Business\njobs: {}\n",
    )
    .unwrap();
    fs::create_dir_all(f.root.join(".opencode/hooks")).unwrap();
    fs::write(
        f.root.join(".opencode/hooks/specgit-merge-guard.sh"),
        "#!/bin/sh\n# SpecGit guard (managed by specgit init): test\n",
    )
    .unwrap();
    fs::write(f.root.join(".opencode/hooks.json"),json!({"metadata":{"mine":true},"PreToolUse":[{"matcher":"Bash","extension":7,"hooks":[{"type":"command","command":".opencode/hooks/specgit-merge-guard.sh"},{"type":"command","command":"user-hook"}]}]}).to_string()).unwrap();
    fs::create_dir_all(f.root.join(".agents/skills/specgit-finish")).unwrap();
    fs::write(
        f.root.join(".agents/skills/specgit-finish/SKILL.md"),
        "---\nname: specgit-finish\n---\n\n<!-- specgit-managed-entry-point -->\nold\n",
    )
    .unwrap();
    fs::write(f.root.join("unrelated-dirty.txt"), "preserve dirty content").unwrap();
    let hook = PathBuf::from(git(
        &f.root,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "hooks/pre-push",
        ],
    ));
    fs::write(
        hook,
        "#!/bin/sh\n# >>> specgit:start >>>\nold guard\n# <<< specgit:end <<<\necho user\n",
    )
    .unwrap();
    f.edit(|s| {
        let mut r = json!({});
        let base = if provider == "github" {
            "repos/fixture/repo"
        } else {
            "projects/fixture%2Frepo"
        };
        if provider == "github" {
            r[format!("{base}/branches/main")] = json!({"name":"main","commit":{"sha":MAIN}});
            r[format!("{base}/actions/workflows?per_page=100&page=1")] =
                json!({"total_count":0,"workflows":[]});
            for state in ["queued", "in_progress", "waiting", "pending", "requested"] {
                r[format!("{base}/actions/runs?status={state}&per_page=100&page=1")] =
                    json!({"total_count":0,"workflow_runs":[]});
            }
        } else {
            r[format!("{base}/repository/branches/main")] =
                json!({"name":"main","commit":{"id":MAIN}});
            r[format!("{base}/repository/tree?ref={MAIN}&recursive=true&per_page=100&page=1")] =
                json!([]);
            for state in [
                "created",
                "waiting_for_resource",
                "preparing",
                "waiting_for_callback",
                "canceling",
                "pending",
                "running",
                "scheduled",
                "manual",
            ] {
                r[format!("{base}/pipelines?status={state}&per_page=100&page=1")] = json!([]);
                r[format!(
                    "{base}/pipelines?status={state}&source=parent_pipeline&per_page=100&page=1"
                )] = json!([]);
            }
        }
        r[format!("{base}/pipeline_schedules?scope=active&per_page=100&page=1")] = json!([]);
        r[base] = s["project"].clone();
        s["read_routes"] = r;
    });
    (f, selected)
}
fn preview(f: &Fixture, path: &Path, extra: &[&str]) -> Value {
    let mut args = vec!["migrate", "--config-file", path.to_str().unwrap()];
    args.extend(extra);
    f.run(&args)
}
fn apply(f: &Fixture, path: &Path, preview: &Value, extra: &[&str]) -> Value {
    let mut args = vec![
        "migrate",
        "--config-file",
        path.to_str().unwrap(),
        "--apply",
        "--expect",
        preview["evidence"]["preview_sha256"].as_str().unwrap(),
    ];
    args.extend(extra);
    f.run(&args)
}
#[test]
fn native_cutover_and_rollback_preserve_old_work_and_foreign_bytes_on_both_forges() {
    for provider in ["github", "gitlab"] {
        let (f, path) = fixture(provider);
        let before = fs::read(f.root.join("AGENTS.md")).unwrap();
        let pointer = fs::read(f.root.join(".specgit.yaml")).unwrap();
        let p = preview(&f, &path, &[]);
        assert_eq!(p["exit"], 0, "{p}");
        assert_eq!(fs::read(f.root.join("AGENTS.md")).unwrap(), before);
        let a = apply(&f, &path, &p, &[]);
        assert_eq!(a["exit"], 0, "{a}");
        assert_eq!(a["status"], "migrated");
        let private = PathBuf::from(git(&f.root, &["rev-parse", "--absolute-git-dir"]))
            .join("specgit-v2/guidance.json");
        let receipt: Value = serde_json::from_slice(&fs::read(&private).unwrap()).unwrap();
        assert_eq!(receipt["generator"], env!("CARGO_PKG_VERSION"));
        assert!(receipt["blocks"]["AGENTS.md"].as_str().is_some());
        assert_eq!(
            a["evidence"]["local_exclusion"]["excluded_paths"],
            json!([".specgit.yaml"])
        );
        assert!(
            Command::new("git")
                .current_dir(&f.root)
                .args(["check-ignore", "--no-index", ".specgit.yaml"])
                .output()
                .unwrap()
                .status
                .success()
        );
        assert!(
            !f.root
                .join(".github/workflows/specgit-complete.yml")
                .exists()
        );
        assert!(
            !f.root
                .join(".agents/skills/specgit-finish/SKILL.md")
                .exists()
        );
        assert_eq!(
            fs::read_to_string(f.root.join("unrelated-dirty.txt")).unwrap(),
            "preserve dirty content"
        );
        let agents = fs::read_to_string(f.root.join("AGENTS.md")).unwrap();
        assert!(agents.starts_with("Human prefix\nHuman suffix\n"));
        assert!(agents.contains("<!-- specgit:v2:start -->"));
        let hooks: Value =
            serde_json::from_slice(&fs::read(f.root.join(".opencode/hooks.json")).unwrap())
                .unwrap();
        assert_eq!(hooks["metadata"]["mine"], true);
        assert_eq!(hooks["PreToolUse"][0]["extension"], 7);
        assert_eq!(hooks["PreToolUse"][0]["hooks"][0]["command"], "user-hook");
        let archive: Value =
            serde_json::from_slice(&fs::read(a["evidence"]["backup"].as_str().unwrap()).unwrap())
                .unwrap();
        assert!(archive["entries"].as_array().unwrap().iter().any(|e| {
            Path::new(e["path"].as_str().unwrap()).ends_with("spec_git/scopes/old.yaml")
        }));
        let r = f.run(&[
            "migrate",
            "--rollback",
            a["evidence"]["transaction"].as_str().unwrap(),
        ]);
        assert_eq!(r["exit"], 0, "{r}");
        assert!(!private.exists());
        assert_eq!(fs::read(f.root.join("AGENTS.md")).unwrap(), before);
        assert_eq!(fs::read(f.root.join(".specgit.yaml")).unwrap(), pointer);
        assert!(
            f.root
                .join(".github/workflows/specgit-complete.yml")
                .exists()
        );
        assert_eq!(f.writes(), 0);
    }
}
#[test]
fn changed_preview_and_foreign_writers_never_activate_v2() {
    let (f, path) = fixture("github");
    let p = preview(&f, &path, &[]);
    assert_eq!(p["exit"], 0, "{p}");
    fs::write(f.root.join("AGENTS.md"), "new user edit\n").unwrap();
    let a = apply(&f, &path, &p, &[]);
    assert_eq!(a["exit"], 3, "{a}");
    assert_eq!(a["diagnostics"][0]["code"], "concurrent_edit");
    fs::write(
        f.root.join(".github/workflows/user-writer.yml"),
        "name: mine\nrun: node specgit-completion.js\n",
    )
    .unwrap();
    let p = preview(&f, &path, &[]);
    assert_eq!(p["exit"], 3, "{p}");
    assert_eq!(p["status"], "preview_blocked");
    assert!(
        fs::read_to_string(f.root.join(".specgit.yaml"))
            .unwrap()
            .starts_with("version: 1")
    );
    assert!(f.root.join(".github/workflows/user-writer.yml").exists());
}
#[test]
fn unfinished_remote_runs_block_activation_but_local_retirement_preserves_v1() {
    let (f, path) = fixture("github");
    f.edit(|s| {
        s["read_routes"]["repos/fixture/repo/actions/runs?status=in_progress&per_page=100&page=1"] =
            json!({"total_count":1,"workflow_runs":[{"id":91,"status":"in_progress"}]})
    });
    let p = preview(&f, &path, &[]);
    assert_eq!(p["exit"], 3, "{p}");
    assert_eq!(
        p["evidence"]["remote_retirement"]["unfinished_runs"],
        json!([91])
    );
    let p = preview(&f, &path, &["--retire-only"]);
    assert_eq!(p["exit"], 0, "{p}");
    let a = apply(&f, &path, &p, &["--retire-only"]);
    assert_eq!(a["exit"], 0, "{a}");
    assert!(
        fs::read_to_string(f.root.join(".specgit.yaml"))
            .unwrap()
            .starts_with("version: 1")
    );
    assert!(
        !fs::read_to_string(f.root.join("AGENTS.md"))
            .unwrap()
            .contains("specgit:v2")
    );
}
#[test]
fn rollback_keeps_post_migration_user_edits_and_retains_backups() {
    let (f, path) = fixture("github");
    let p = preview(&f, &path, &[]);
    let a = apply(&f, &path, &p, &[]);
    assert_eq!(a["exit"], 0, "{a}");
    fs::write(f.root.join("AGENTS.md"), "user changed after migration\n").unwrap();
    let r = f.run(&[
        "migrate",
        "--rollback",
        a["evidence"]["transaction"].as_str().unwrap(),
    ]);
    assert_eq!(r["exit"], 3, "{r}");
    assert_eq!(
        fs::read_to_string(f.root.join("AGENTS.md")).unwrap(),
        "user changed after migration\n"
    );
    assert!(Path::new(a["evidence"]["backup"].as_str().unwrap()).exists());
}
#[cfg(windows)]
#[test]
fn ordinary_and_verbatim_hook_paths_have_the_same_migration_identity() {
    let (f, path) = fixture("github");
    let hooks = f.root.join(".git/hooks").canonicalize().unwrap();
    let verbatim = hooks.to_str().unwrap();
    let ordinary = verbatim.strip_prefix(r"\\?\").unwrap();
    git(&f.root, &["config", "core.hooksPath", ordinary]);
    let first = preview(&f, &path, &[]);
    assert_eq!(first["exit"], 0, "{first}");
    git(&f.root, &["config", "core.hooksPath", verbatim]);
    let second = preview(&f, &path, &[]);
    assert_eq!(second["exit"], 0, "{second}");
    assert_eq!(
        first["evidence"]["inventory"],
        second["evidence"]["inventory"]
    );
    assert_eq!(
        first["evidence"]["preview_sha256"],
        second["evidence"]["preview_sha256"]
    );
    let applied = apply(&f, &path, &second, &[]);
    assert_eq!(applied["exit"], 0, "{applied}");
    assert_eq!(
        fs::read_to_string(hooks.join("pre-push")).unwrap(),
        "#!/bin/sh\necho user\n"
    );
}
#[test]
fn absent_in_project_hook_directory_does_not_block_verified_migration() {
    let (f, path) = fixture("github");
    git(
        &f.root,
        &["config", "core.hooksPath", "missing/native-hooks"],
    );
    let p = preview(&f, &path, &[]);
    assert_eq!(p["exit"], 0, "{p}");
    assert_eq!(apply(&f, &path, &p, &[])["exit"], 0);
    assert!(!f.root.join("missing/native-hooks").exists());
}
#[cfg(unix)]
#[test]
fn symlinked_asset_ancestor_is_rejected_before_any_change() {
    let (f, path) = fixture("github");
    let original = f.root.join(".agents");
    let outside = f.root.parent().unwrap().join("owned-elsewhere");
    fs::rename(&original, &outside).unwrap();
    std::os::unix::fs::symlink(&outside, &original).unwrap();
    let p = preview(&f, &path, &[]);
    assert_eq!(p["exit"], 3, "{p}");
    assert_eq!(p["diagnostics"][0]["code"], "unsafe_path");
    assert!(outside.join("skills/specgit-finish/SKILL.md").exists());
}

#[test]
fn active_native_workflow_and_incomplete_counted_page_block_cutover() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let (f, path) = fixture("github");
    let content = "name: legacy\njobs:\n  complete:\n    steps:\n      - run: specgit pr --merge\n";
    f.edit(|s| {
        s["read_routes"]["repos/fixture/repo/actions/workflows?per_page=100&page=1"]=json!({"total_count":1,"workflows":[{"id":5,"state":"active","path":".github/workflows/renamed.yml"}]});
        s["read_routes"][format!("repos/fixture/repo/contents/.github/workflows/renamed.yml?ref={MAIN}")]=json!({"path":".github/workflows/renamed.yml","type":"file","sha":"b".repeat(40),"size":content.len(),"encoding":"base64","content":STANDARD.encode(content)});
    });
    let p = preview(&f, &path, &[]);
    assert_eq!(p["exit"], 3, "{p}");
    assert_eq!(
        p["evidence"]["remote_retirement"]["blockers"],
        json!([".github/workflows/renamed.yml"])
    );
    f.edit(|s| {
        s["read_routes"]["repos/fixture/repo/actions/workflows?per_page=100&page=1"] =
            json!({"total_count":1,"workflows":[]})
    });
    let p = preview(&f, &path, &[]);
    assert_eq!(p["diagnostics"][0]["code"], "malformed_response", "{p}");
}

#[test]
fn github_managed_dynamic_workflows_are_reported_and_repository_workflows_are_scanned() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let (f, path) = fixture("github");
    let content = "name: business\njobs:\n  build:\n    steps:\n      - run: cargo test\n";
    let dynamic = [
        "dynamic/dependabot/dependabot-updates",
        "dynamic/github-code-scanning/codeql",
        "dynamic/agents/github-advanced-security",
    ];
    let mut workflows: Vec<Value> = dynamic
        .iter()
        .enumerate()
        .map(|(index, path)| json!({"id":20 + index as u64,"state":"active","path":path}))
        .collect();
    workflows.push(json!({"id":30,"state":"active","path":".github/workflows/business.yml"}));
    f.edit(|s| {
        s["read_routes"]["repos/fixture/repo/actions/workflows?per_page=100&page=1"] =
            json!({"total_count":4,"workflows":workflows});
        s["read_routes"][format!("repos/fixture/repo/contents/.github/workflows/business.yml?ref={MAIN}")]=json!({"path":".github/workflows/business.yml","type":"file","sha":"b".repeat(40),"size":content.len(),"encoding":"base64","content":STANDARD.encode(content)});
    });

    let preview = preview(&f, &path, &[]);

    assert_eq!(preview["exit"], 0, "{preview}");
    assert_eq!(
        preview["evidence"]["remote_retirement"]["managed_workflows"],
        json!([
            [20, "dynamic/dependabot/dependabot-updates"],
            [21, "dynamic/github-code-scanning/codeql"],
            [22, "dynamic/agents/github-advanced-security"]
        ])
    );
    assert_eq!(
        preview["evidence"]["remote_retirement"]["scanned_paths"],
        json!([".github/workflows/business.yml"])
    );
}

#[test]
fn unknown_github_dynamic_workflow_blocks_with_specific_diagnostic() {
    let (f, path) = fixture("github");
    f.edit(|s| {
        s["read_routes"]["repos/fixture/repo/actions/workflows?per_page=100&page=1"] =
            json!({"total_count":1,"workflows":[{"id":40,"state":"active","path":"dynamic/new-platform-workflow"}]});
    });

    let preview = preview(&f, &path, &[]);

    assert_eq!(preview["exit"], 3, "{preview}");
    assert_eq!(preview["diagnostics"][0]["code"], "evidence_rejected");
    assert_eq!(
        preview["diagnostics"][0]["message"],
        "GitHub returned an unsupported active workflow path: dynamic/new-platform-workflow."
    );
}

#[test]
fn unreadable_registered_github_workflows_keep_failure_class_and_add_path_context() {
    let workflow_path = ".github/workflows/specgit-reuse.yml";
    let workflow_route =
        "repos/fixture/repo/contents/.github/workflows/specgit-reuse.yml?ref=".to_owned() + MAIN;

    let (missing, missing_config) = fixture("github");
    missing.edit(|state| {
        state["read_routes"]["repos/fixture/repo/actions/workflows?per_page=100&page=1"] =
            json!({"total_count":1,"workflows":[{"id":41,"state":"active","path":workflow_path}]});
    });
    let missing_preview = preview(&missing, &missing_config, &[]);
    assert_eq!(missing_preview["exit"], 3, "{missing_preview}");
    assert_eq!(
        missing_preview["diagnostics"][0]["code"],
        "ambiguous_not_found"
    );
    assert!(
        missing_preview["diagnostics"][0]["message"]
            .as_str()
            .unwrap()
            .contains(workflow_path)
    );

    let (forbidden, forbidden_config) = fixture("github");
    forbidden.edit(|state| {
        state["read_routes"]["repos/fixture/repo/actions/workflows?per_page=100&page=1"] =
            json!({"total_count":1,"workflows":[{"id":41,"state":"active","path":workflow_path}]});
        state["read_routes"][workflow_route] =
            json!({"__fixture_error":"HTTP 403 private https://sentinel:secret@example.invalid/?token=secret"});
    });
    let forbidden_preview = preview(&forbidden, &forbidden_config, &[]);
    assert_eq!(forbidden_preview["exit"], 3, "{forbidden_preview}");
    assert_eq!(
        forbidden_preview["diagnostics"][0]["code"],
        "permission_denied"
    );
    let diagnostic = forbidden_preview["diagnostics"][0].to_string();
    assert!(diagnostic.contains(workflow_path));
    assert!(!diagnostic.contains("sentinel"));
    assert!(!diagnostic.contains("secret"));
}

#[test]
fn gitlab_static_includes_are_followed_and_external_includes_are_explicitly_unverified() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let (f, path) = fixture("gitlab");
    let files = [
        (".gitlab-ci.yml", "include:\n  - local: /ci/build.yml\n"),
        ("ci/build.yml", "build:\n  script: echo build\n"),
    ];
    f.edit(|s| {
        s["read_routes"][format!("projects/fixture%2Frepo/repository/tree?ref={MAIN}&recursive=true&per_page=100&page=1")]=json!(files.iter().map(|(p,_)|json!({"path":p,"id":"b".repeat(40),"type":"blob","mode":"100644"})).collect::<Vec<_>>());
        for (p,bytes) in files {
            s["read_routes"][format!("projects/fixture%2Frepo/repository/files/{}?ref={MAIN}",p.replace('/',"%2F"))]=json!({"file_path":p,"commit_id":MAIN,"blob_id":"b".repeat(40),"size":bytes.len(),"encoding":"base64","content":STANDARD.encode(bytes)});
        }
    });
    let p = preview(&f, &path, &[]);
    assert_eq!(p["exit"], 0, "{p}");
    assert_eq!(
        p["evidence"]["remote_retirement"]["scanned_paths"],
        json!([".gitlab-ci.yml", "ci/build.yml"])
    );
    let remote = "include:\n  - remote: https://example.invalid/ci.yml\n";
    f.edit(|s| {
        let route = &mut s["read_routes"]
            [format!("projects/fixture%2Frepo/repository/files/.gitlab-ci.yml?ref={MAIN}")];
        route["content"] = json!(STANDARD.encode(remote));
        route["size"] = json!(remote.len());
    });
    let p = preview(&f, &path, &[]);
    assert_eq!(p["exit"], 3, "{p}");
    assert_eq!(
        p["evidence"]["remote_retirement"]["blockers"],
        json!(["unverified_include:.gitlab-ci.yml"])
    );
}
#[test]
fn custom_in_project_hook_is_preserved_outside_its_owned_block() {
    let (f, path) = fixture("github");
    fs::create_dir_all(f.root.join("custom-hooks")).unwrap();
    let bytes =
        "#!/bin/sh\n# >>> specgit:start >>>\nold\n# <<< specgit:end <<<\necho personal hook\n";
    fs::write(f.root.join("custom-hooks/pre-push"), bytes).unwrap();
    git(&f.root, &["config", "core.hooksPath", "custom-hooks"]);
    let p = preview(&f, &path, &[]);
    assert_eq!(p["exit"], 0, "{p}");
    let a = apply(&f, &path, &p, &[]);
    assert_eq!(a["exit"], 0, "{a}");
    assert_eq!(
        fs::read_to_string(f.root.join("custom-hooks/pre-push")).unwrap(),
        "#!/bin/sh\necho personal hook\n"
    );
}
#[test]
fn legacy_arguments_have_an_actionable_major_version_diagnostic() {
    let (f, _) = fixture("github");
    for args in [
        vec!["pr", "--merge"],
        vec!["finish", "--scope", "programme"],
        vec!["bind", "--issue", "1"],
        vec!["init", "--automation", "yes"],
    ] {
        let r = f.run(&args);
        assert_eq!(r["exit"], 2, "{r}");
        assert_eq!(r["diagnostics"][0]["operation"], "major_version");
        assert!(
            r["diagnostics"][0]["remedy"]
                .as_str()
                .unwrap()
                .contains("migrate")
        );
    }
    assert_eq!(f.writes(), 0);
}

#[test]
fn shared_worktree_hook_is_reported_and_never_removed_for_another_v1_worktree() {
    let (f, path) = fixture("github");
    let sibling = f.root.parent().unwrap().join("sibling");
    git(&f.root, &["worktree", "add", "-b", "sibling", "../sibling"]);
    fs::write(
        sibling.join(".specgit.yaml"),
        "version: 1\ndelivery: sibling\nissues: [3]\npr: 42\n",
    )
    .unwrap();
    let out = f
        .command(&["migrate", "--config-file", path.to_str().unwrap()])
        .current_dir(&sibling)
        .output()
        .unwrap();
    let r: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(r["exit"], 3, "{r}");
    assert_eq!(r["status"], "preview_blocked");
    assert!(
        r["evidence"]["inventory"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["action"] == "preserve_shared_hook")
    );
    let hook = PathBuf::from(git(
        &f.root,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "hooks/pre-push",
        ],
    ));
    assert!(fs::read_to_string(hook).unwrap().contains("old guard"));
    assert!(
        fs::read_to_string(f.root.join(".specgit.yaml"))
            .unwrap()
            .contains("unfinished")
    );
}
#[test]
fn gitlab_business_routing_is_restored_but_added_user_jobs_are_not_discarded() {
    let (f, path) = fixture("gitlab");
    fs::create_dir_all(f.root.join(".gitlab")).unwrap();
    let business = "build:\n  script: echo user build\n";
    fs::write(f.root.join(".gitlab/specgit-business.yml"), business).unwrap();
    let routing = include_str!("fixtures/v1-gitlab-router.yml");
    fs::write(f.root.join(".gitlab-ci.yml"), routing).unwrap();
    let p = preview(&f, &path, &[]);
    assert_eq!(p["exit"], 0, "{p}");
    let a = apply(&f, &path, &p, &[]);
    assert_eq!(a["exit"], 0, "{a}");
    assert_eq!(
        fs::read_to_string(f.root.join(".gitlab-ci.yml")).unwrap(),
        business
    );
    assert_eq!(
        fs::read_to_string(f.root.join(".gitlab/specgit-business.yml")).unwrap(),
        business
    );
    f.run(&[
        "migrate",
        "--rollback",
        a["evidence"]["transaction"].as_str().unwrap(),
    ]);
    fs::write(
        f.root.join(".gitlab-ci.yml"),
        format!("{routing}user-job:\n  script: echo keep\n"),
    )
    .unwrap();
    let p = preview(&f, &path, &[]);
    assert_eq!(p["exit"], 3, "{p}");
    assert!(
        fs::read_to_string(f.root.join(".gitlab-ci.yml"))
            .unwrap()
            .contains("user-job")
    );
}

#[test]
fn main_checkout_cannot_retire_a_guard_shared_with_a_linked_v1_worktree() {
    let (f, path) = fixture("github");
    let sibling = f.root.parent().unwrap().join("sibling-v1");
    git(
        &f.root,
        &["worktree", "add", "-b", "sibling-v1", "../sibling-v1"],
    );
    fs::write(
        sibling.join(".specgit.yaml"),
        "version: 1\ndelivery: sibling\nissues: [3]\npr: 42\n",
    )
    .unwrap();
    let hook = PathBuf::from(git(
        &f.root,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "hooks/pre-push",
        ],
    ));
    let before = fs::read(&hook).unwrap();
    let p = preview(&f, &path, &["--retire-only"]);
    assert_eq!(p["exit"], 3, "{p}");
    assert!(
        p["evidence"]["inventory"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["action"] == "preserve_shared_hook")
    );
    let a = apply(&f, &path, &p, &["--retire-only"]);
    assert_eq!(a["exit"], 3, "{a}");
    assert_eq!(fs::read(&hook).unwrap(), before);
    fs::remove_file(sibling.join(".specgit.yaml")).unwrap();
    fs::create_dir_all(sibling.join("spec_git")).unwrap();
    fs::write(sibling.join("spec_git/policy.yaml"), "version: 1\n").unwrap();
    let p = preview(&f, &path, &["--retire-only"]);
    assert_eq!(p["exit"], 3, "{p}");
    assert!(
        p["evidence"]["inventory"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["action"] == "preserve_shared_hook")
    );
    assert_eq!(fs::read(&hook).unwrap(), before);
}
#[test]
fn a_user_include_inside_the_marked_gitlab_router_is_preserved() {
    for newline in ["\n", "\r\n"] {
        assert_user_include_is_preserved(newline);
    }
}
fn assert_user_include_is_preserved(newline: &str) {
    let (f, path) = fixture("gitlab");
    fs::create_dir_all(f.root.join(".gitlab")).unwrap();
    fs::write(
        f.root.join(".gitlab/specgit-business.yml"),
        "build:\n  script: echo build\n",
    )
    .unwrap();
    let original = include_str!("fixtures/v1-gitlab-router.yml")
        .replace("\r\n", "\n")
        .replace("include:\n", "include:\n  - local: /ci/user-extra.yml\n")
        .replace('\n', newline);
    assert!(original.contains("  - local: /ci/user-extra.yml"));
    fs::write(f.root.join(".gitlab-ci.yml"), &original).unwrap();
    let p = preview(&f, &path, &[]);
    assert_eq!(p["exit"], 3, "{p}");
    assert_eq!(p["diagnostics"][0]["code"], "ownership_conflict");
    assert_eq!(
        fs::read_to_string(f.root.join(".gitlab-ci.yml")).unwrap(),
        original
    );
}
#[test]
fn detached_child_pipelines_and_old_ref_schedules_block_gitlab_activation() {
    let (f, path) = fixture("gitlab");
    f.edit(|s| {
        s["read_routes"]["projects/fixture%2Frepo/pipelines?status=running&source=parent_pipeline&per_page=100&page=1"]=json!([{"id":97,"status":"running"}]);
    });
    let p = preview(&f, &path, &[]);
    assert_eq!(p["exit"], 3, "{p}");
    assert_eq!(
        p["evidence"]["remote_retirement"]["unfinished_runs"],
        json!([97])
    );
    f.edit(|s| {
        s["read_routes"]["projects/fixture%2Frepo/pipelines?status=running&source=parent_pipeline&per_page=100&page=1"]=json!([]);
        s["read_routes"]["projects/fixture%2Frepo/pipeline_schedules?scope=active&per_page=100&page=1"]=json!([{"id":7,"active":true,"ref":"old-automation"}]);
    });
    let p = preview(&f, &path, &[]);
    assert_eq!(p["exit"], 3, "{p}");
    assert_eq!(
        p["evidence"]["remote_retirement"]["active_schedules"],
        json!([[7, "old-automation"]])
    );
    assert_eq!(
        p["evidence"]["remote_retirement"]["blockers"],
        json!(["unverified_schedule_ref:7:old-automation"])
    );
    f.edit(|s|s["read_routes"]["projects/fixture%2Frepo/pipeline_schedules?scope=active&per_page=100&page=1"][0]["ref"]=json!("refs/heads/main"));
    let p = preview(&f, &path, &[]);
    assert_eq!(p["exit"], 0, "{p}");
    assert!(
        f.state()["calls"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| !c["endpoint"].as_str().unwrap().contains("variables"))
    );
}

#[test]
fn an_unbound_v1_project_requires_migration_and_preserves_its_policy() {
    let (f, path) = fixture("github");
    fs::remove_file(f.root.join(".specgit.yaml")).unwrap();
    let old = fs::read(f.root.join("spec_git/policy.yaml")).unwrap();
    let r = f.run(&["init", "--provider", "github"]);
    assert_eq!(r["exit"], 3, "{r}");
    assert_eq!(r["diagnostics"][0]["code"], "migration_required");
    assert!(!f.root.join(".specgit.yaml").exists());
    let p = preview(&f, &path, &[]);
    assert_eq!(p["exit"], 0, "{p}");
    assert_eq!(p["evidence"]["legacy_work"]["issues"], json!([]));
    let a = apply(&f, &path, &p, &[]);
    assert_eq!(a["exit"], 0, "{a}");
    assert_eq!(fs::read(f.root.join("spec_git/policy.yaml")).unwrap(), old);
    let r = f.run(&[
        "migrate",
        "--rollback",
        a["evidence"]["transaction"].as_str().unwrap(),
    ]);
    assert_eq!(r["exit"], 0, "{r}");
    assert!(!f.root.join(".specgit.yaml").exists());
}

fn interrupt_migration(stage: &str) -> (Fixture, String, Value) {
    let (f, path) = fixture("github");
    let p = preview(&f, &path, &[]);
    assert_eq!(p["exit"], 0, "{p}");
    let planned = p["evidence"]["planned_changes"].as_array().unwrap();
    let point = match stage {
        "after_backup" => "before-write:0".to_owned(),
        "during_writes" => "before-write:2".to_owned(),
        "before_retirement" => {
            let index = planned
                .iter()
                .position(|change| {
                    Path::new(change["path"].as_str().unwrap())
                        .ends_with(".github/workflows/specgit-complete.yml")
                })
                .unwrap();
            format!("before-write:{}", index + 1)
        }
        "before_completion" => "before-commit".to_owned(),
        _ => panic!("unknown interruption stage: {stage}"),
    };
    let out = f
        .command(&[
            "migrate",
            "--config-file",
            path.to_str().unwrap(),
            "--apply",
            "--expect",
            p["evidence"]["preview_sha256"].as_str().unwrap(),
        ])
        .env("SPECGIT_FIXTURE_ASSET_CRASH", point)
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(99), "{out:?}");
    assert_eq!(f.writes(), 0);
    let transactions = PathBuf::from(git(&f.root, &["rev-parse", "--absolute-git-dir"]))
        .join("specgit-v2/assets/transactions");
    let mut dirs = fs::read_dir(transactions)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    assert_eq!(dirs.len(), 1);
    let dir = dirs.pop().unwrap();
    let journal: Value =
        serde_json::from_slice(&fs::read(dir.join("journal.json")).unwrap()).unwrap();
    assert_eq!(journal["state"], "prepared");
    assert_eq!(
        journal["entries"].as_array().unwrap().len(),
        planned.len() + 1
    );
    for entry in journal["entries"].as_array().unwrap() {
        if entry["before"].is_string() {
            assert!(dir.join(entry["backup"].as_str().unwrap()).is_file());
        }
    }
    let id = dir.file_name().unwrap().to_str().unwrap().to_owned();
    (f, id, journal)
}

fn rollback_interrupted_migration(f: &Fixture, id: &str) {
    let rollback = f.run(&["migrate", "--rollback", id]);
    assert_eq!(rollback["exit"], 0, "{rollback}");
    assert_eq!(f.writes(), 0);
    assert!(
        fs::read_to_string(f.root.join(".specgit.yaml"))
            .unwrap()
            .starts_with("version: 1")
    );
    assert!(
        f.root
            .join(".github/workflows/specgit-complete.yml")
            .exists()
    );
    assert_eq!(
        fs::read_to_string(f.root.join("AGENTS.md")).unwrap(),
        "Human prefix\n<!-- specgit:block:start -->\nold contract\n<!-- specgit:block:end -->\nHuman suffix\n"
    );
}

#[test]
fn migration_interrupted_after_durable_backup_can_roll_back() {
    let (f, id, journal) = interrupt_migration("after_backup");
    assert_eq!(journal["entries"][0]["before"], Value::Null);
    assert!(!Path::new(journal["entries"][0]["path"].as_str().unwrap()).exists());
    rollback_interrupted_migration(&f, &id);
}

#[test]
fn migration_interrupted_during_asset_writes_can_roll_back() {
    let (f, id, journal) = interrupt_migration("during_writes");
    assert!(Path::new(journal["entries"][0]["path"].as_str().unwrap()).exists());
    let first_asset = &journal["entries"][1];
    assert_ne!(first_asset["before"], first_asset["after"]);
    let written = Path::new(first_asset["path"].as_str().unwrap());
    match first_asset["after"].as_str() {
        Some(expected) => assert_eq!(specgit::assets::hash(&fs::read(written).unwrap()), expected),
        None => assert!(!written.exists()),
    }
    rollback_interrupted_migration(&f, &id);
}

#[test]
fn migration_interrupted_before_old_writer_retirement_can_roll_back() {
    let (f, id, journal) = interrupt_migration("before_retirement");
    let entries = journal["entries"].as_array().unwrap();
    let writer = f.root.join(".github/workflows/specgit-complete.yml");
    let writer_index = entries
        .iter()
        .position(|entry| entry["path"] == writer.to_str().unwrap())
        .unwrap();
    assert!(writer_index > 1);
    assert_eq!(
        specgit::assets::hash(&fs::read(&writer).unwrap()),
        entries[writer_index]["before"].as_str().unwrap()
    );
    assert!(
        fs::read_to_string(f.root.join(".specgit.yaml"))
            .unwrap()
            .starts_with("version: 1")
    );
    rollback_interrupted_migration(&f, &id);
}

#[test]
fn migration_interrupted_before_completion_preserves_user_edit_then_rolls_back() {
    let (f, id, journal) = interrupt_migration("before_completion");
    assert!(Path::new(journal["entries"][0]["path"].as_str().unwrap()).exists());
    assert!(
        !f.root
            .join(".github/workflows/specgit-complete.yml")
            .exists()
    );
    assert!(
        fs::read_to_string(f.root.join(".specgit.yaml"))
            .unwrap()
            .starts_with("version: 2")
    );
    let agents = f.root.join("AGENTS.md");
    let migrated = fs::read(&agents).unwrap();
    fs::write(&agents, b"user edit after interruption\n").unwrap();
    let conflict = f.run(&["migrate", "--rollback", &id]);
    assert_eq!(conflict["exit"], 3, "{conflict}");
    assert_eq!(conflict["diagnostics"][0]["code"], "rollback_conflict");
    assert_eq!(
        fs::read(&agents).unwrap(),
        b"user edit after interruption\n"
    );
    assert!(
        fs::read_to_string(f.root.join(".specgit.yaml"))
            .unwrap()
            .starts_with("version: 2")
    );
    fs::write(agents, migrated).unwrap();
    rollback_interrupted_migration(&f, &id);
}
