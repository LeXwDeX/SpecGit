use serde_json::{Value, json};
use specgit::{
    assets::{self, AssetStore, Change},
    guidance, local_exclude,
};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
#[cfg(feature = "test-fixtures")]
#[path = "support/acceptance.rs"]
mod acceptance;
#[cfg(feature = "test-fixtures")]
#[path = "support/delivery.rs"]
mod delivery;
#[cfg(feature = "test-fixtures")]
use delivery::executable;
#[cfg(not(feature = "test-fixtures"))]
#[path = "support/executable.rs"]
mod executable;

fn git(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(root)
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
fn inventory(root: &Path) -> BTreeMap<PathBuf, Value> {
    let mut files = BTreeMap::new();
    for entry in fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files.extend(inventory(&path));
        } else if path.file_name().unwrap() != ".specgit-lock" {
            #[cfg(unix)]
            let mode = {
                use std::os::unix::fs::PermissionsExt;
                Some(fs::metadata(&path).unwrap().permissions().mode() & 0o7777)
            };
            #[cfg(not(unix))]
            let mode: Option<u32> = None;
            files.insert(
                path.clone(),
                json!({"hash":assets::hash(&fs::read(&path).unwrap()),"mode":mode}),
            );
        }
    }
    files
}
fn initialize(root: &Path) {
    let private = PathBuf::from(git(root, &["rev-parse", "--absolute-git-dir"])).join("specgit-v2");
    let exclude = PathBuf::from(git(
        root,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "info/exclude",
        ],
    ));
    let declaration = specgit::config::read(root).unwrap().unwrap_or_default();
    let mut bytes = declaration.bytes().unwrap();
    bytes.push(b'\n');
    let mut changes = guidance::changes(root, &private, &declaration, &declaration, true).unwrap();
    changes.push(Change::new(root.join(".specgit.yaml"), Some(bytes)).unwrap());
    changes.push(local_exclude::change(&exclude, &[".specgit.yaml"]).unwrap());
    AssetStore::lock(
        &private.join("assets"),
        &[
            root.into(),
            private.clone(),
            exclude.parent().unwrap().into(),
        ],
        Duration::from_secs(2),
    )
    .unwrap()
    .apply(changes)
    .unwrap();
}
struct Fixture {
    _temp: tempfile::TempDir,
    base: PathBuf,
    root: PathBuf,
    private: PathBuf,
}
impl Fixture {
    fn new(initialized: bool) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let root = base.join("checkout");
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "-b", "feature"]);
        git(
            &root,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "fixture",
            ],
        );
        let root = PathBuf::from(git(&root, &["rev-parse", "--show-toplevel"]));
        let private =
            PathBuf::from(git(&root, &["rev-parse", "--absolute-git-dir"])).join("specgit-v2");
        if initialized {
            initialize(&root);
        }
        Self {
            _temp: temp,
            base,
            root,
            private,
        }
    }
    fn run(&self, args: &[&str]) -> Value {
        let out = executable::command()
            .current_dir(&self.root)
            .args(args)
            .arg("--json")
            .output()
            .unwrap();
        let value: Value =
            serde_json::from_slice(&out.stdout).unwrap_or_else(|_| panic!("{:?}", out));
        assert_eq!(out.status.code(), value["exit"].as_i64().map(|n| n as i32));
        value
    }
    fn apply(&self, preview: &Value) -> Value {
        self.run(&[
            "remove",
            "--apply",
            "--expect",
            preview["evidence"]["preview_sha256"].as_str().unwrap(),
        ])
    }
    fn agents(&self) -> PathBuf {
        let shared = self.base.join("shared");
        specgit::setup::install(
            &specgit::setup::Options {
                root: shared.clone(),
                provider: None,
                api_host: None,
                claude_settings: None,
                host_roots: Default::default(),
                uninstall: false,
                dry_run: false,
                rollback: None,
            },
            &executable::binary().canonicalize().unwrap(),
        )
        .unwrap();
        specgit::setup::project::install(
            &specgit::setup::project::Options {
                shared_root: shared.clone(),
                agents: vec![specgit::setup::Agent::Claude, specgit::setup::Agent::Codex],
                uninstall: false,
                dry_run: false,
                rollback: None,
            },
            &self.root,
            &self.private.join("agent-assets"),
        )
        .unwrap();
        shared
    }
}

#[test]
fn default_preview_is_read_only_and_removal_rollback_preserve_mixed_owned_assets() {
    let f = Fixture::new(false);
    fs::write(f.root.join("AGENTS.md"), "user rules\n\n").unwrap();
    fs::write(f.root.join("CLAUDE.md"), "claude rules\n\n").unwrap();
    initialize(&f.root);
    let hook = PathBuf::from(git(
        &f.root,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "hooks/pre-commit",
        ],
    ));
    let user_hook = b"#!/bin/sh\nprintf 'user hook'\n";
    fs::write(&hook, user_hook).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o751)).unwrap();
    }
    assert!(
        Command::new(executable::binary())
            .current_dir(&f.root)
            .args(["guard", "--install"])
            .output()
            .unwrap()
            .status
            .success()
    );
    let shared = f.agents();
    let global = inventory(&shared);
    let before = inventory(&f.base);
    let preview = f.run(&["remove"]);
    assert_eq!(preview["status"], "prepared", "{preview}");
    assert_eq!(inventory(&f.base), before);
    assert_eq!(
        f.run(&["remove", "--dry-run"])["evidence"]["preview_sha256"],
        preview["evidence"]["preview_sha256"]
    );
    assert!(!f.private.join("removal").exists());
    let applied = f.apply(&preview);
    assert_eq!(applied["status"], "removed", "{applied}");
    assert!(!f.root.join(".specgit.yaml").exists());
    assert_eq!(
        fs::read(f.root.join("AGENTS.md")).unwrap(),
        b"user rules\n\n"
    );
    assert_eq!(
        fs::read(f.root.join("CLAUDE.md")).unwrap(),
        b"claude rules\n\n"
    );
    assert_eq!(fs::read(&hook).unwrap(), user_hook);
    assert!(!f.private.join("guard-hooks.json").exists());
    assert!(
        !f.root
            .join(".agents/skills/specgit-native/SKILL.md")
            .exists()
    );
    assert_eq!(inventory(&shared), global);
    assert_eq!(f.run(&["remove"])["status"], "prepared");
    let id = applied["evidence"]["transaction"]["transaction"]
        .as_str()
        .unwrap();
    assert_eq!(
        f.run(&["remove", "--rollback", id])["status"],
        "rolled_back"
    );
    for (path, value) in &before {
        assert_eq!(
            inventory(&f.base).get(path),
            Some(value),
            "{}",
            path.display()
        );
    }
}

#[test]
fn a_user_only_repository_is_not_adopted_and_preview_never_creates_private_state() {
    let f = Fixture::new(false);
    let tracked = f.root.join("notes.txt");
    fs::write(&tracked, "unchanged user content").unwrap();
    git(&f.root, &["add", "notes.txt"]);
    git(
        &f.root,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-m",
            "user content",
        ],
    );
    fs::File::options()
        .write(true)
        .open(tracked)
        .unwrap()
        .set_times(
            fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH + Duration::from_secs(1)),
        )
        .unwrap();
    fs::write(f.root.join("AGENTS.md"), b"unmanaged rules").unwrap();
    let hooks = PathBuf::from(git(
        &f.root,
        &["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
    ));
    fs::write(hooks.join("pre-push"), b"not a shell hook").unwrap();
    let before = inventory(&f.base);
    let preview = f.run(&["remove", "--dry-run"]);
    assert_eq!(preview["exit"], 0, "{preview}");
    assert_eq!(inventory(&f.base), before);
    assert!(!f.private.exists());
    assert_eq!(f.apply(&preview)["evidence"]["transaction"]["changes"], 0);
    assert_eq!(inventory(&f.base), before);
}

#[test]
fn edited_unowned_or_tracked_assets_are_conflicts_and_stale_previews_never_write() {
    for fault in [
        "declaration",
        "guidance",
        "skill",
        "tracked",
        "unowned",
        "malformed config",
        "malformed checkpoint",
    ] {
        let f = Fixture::new(true);
        match fault {
            "declaration" => {
                let mut bytes = fs::read(f.root.join(".specgit.yaml")).unwrap();
                bytes.extend(b"# user edit\n");
                fs::write(f.root.join(".specgit.yaml"), bytes).unwrap();
            }
            "guidance" => {
                let path = f.root.join("AGENTS.md");
                let text = fs::read_to_string(&path).unwrap();
                fs::write(path, text.replace("Runtime:", "user changed:")).unwrap();
            }
            "skill" => {
                f.agents();
                fs::write(
                    f.root.join(".agents/skills/specgit-native/SKILL.md"),
                    "edited private skill",
                )
                .unwrap();
            }
            "tracked" => {
                git(&f.root, &["add", "-f", ".specgit.yaml"]);
            }
            "malformed config" => {
                fs::write(f.root.join(".specgit.yaml"), "version: invalid\n").unwrap()
            }
            "malformed checkpoint" => {
                fs::write(f.private.join("selection.json"), "not-json").unwrap()
            }
            _ => {
                fs::remove_dir_all(f.private.join("assets")).unwrap();
            }
        }
        let before = inventory(&f.base);
        let rejected = f.run(&["remove"]);
        assert_ne!(rejected["exit"], 0, "{fault}: {rejected}");
        assert!(
            rejected["evidence"]["assets"]
                .as_array()
                .unwrap()
                .iter()
                .any(|a| a["state"] == "conflict"),
            "{fault}: {rejected}"
        );
        assert_eq!(inventory(&f.base), before, "{fault}");
        assert!(!f.private.join("removal").exists());
    }
    let f = Fixture::new(true);
    let preview = f.run(&["remove"]);
    let path = f.root.join("AGENTS.md");
    let text = fs::read_to_string(&path).unwrap();
    fs::write(&path, format!("{text}later user rules")).unwrap();
    let before = inventory(&f.base);
    let rejected = f.apply(&preview);
    assert_eq!(
        rejected["diagnostics"][0]["code"], "concurrent_edit",
        "{rejected}"
    );
    assert_eq!(inventory(&f.base), before);
    assert!(!f.private.join("removal").exists());
}

#[test]
fn linked_worktrees_keep_shared_exclusions_hooks_and_private_agent_assets() {
    for husky in [false, true] {
        let f = Fixture::new(true);
        let shared = f.agents();
        if husky {
            fs::create_dir_all(f.root.join(".husky/_")).unwrap();
            git(
                &f.root,
                &[
                    "config",
                    "core.hooksPath",
                    f.root.join(".husky/_").to_str().unwrap(),
                ],
            );
        }
        assert!(
            executable::command()
                .current_dir(&f.root)
                .args(["guard", "--install"])
                .output()
                .unwrap()
                .status
                .success()
        );
        git(
            &f.root,
            &["worktree", "add", "-b", "sibling", "../linked", "HEAD"],
        );
        let sibling = f.root.parent().unwrap().join("linked");
        initialize(&sibling);
        let sibling_private = PathBuf::from(git(&sibling, &["rev-parse", "--absolute-git-dir"]))
            .join("specgit-v2/agent-assets");
        specgit::setup::project::install(
            &specgit::setup::project::Options {
                shared_root: shared,
                agents: vec![specgit::setup::Agent::Opencode],
                uninstall: false,
                dry_run: false,
                rollback: None,
            },
            &sibling,
            &sibling_private,
        )
        .unwrap();
        let sibling_before = inventory(&sibling);
        let exclude = PathBuf::from(git(
            &f.root,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "info/exclude",
            ],
        ));
        let exclude_before = fs::read(&exclude).unwrap();
        let hook = if husky {
            f.root.join(".husky/pre-push")
        } else {
            PathBuf::from(git(
                &f.root,
                &[
                    "rev-parse",
                    "--path-format=absolute",
                    "--git-path",
                    "hooks/pre-push",
                ],
            ))
        };
        let hook_before = fs::read(&hook).unwrap();
        let preview = f.run(&["remove"]);
        assert_eq!(preview["status"], "prepared", "{preview}");
        assert_eq!(
            preview["evidence"]["shared_consumers"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(f.apply(&preview)["status"], "removed");
        assert_eq!(inventory(&sibling), sibling_before);
        assert_eq!(fs::read(exclude).unwrap(), exclude_before);
        assert_eq!(fs::read(hook).unwrap(), hook_before);
        assert!(f.private.join("guard-hooks.json").exists());
    }
}

#[test]
fn rollback_does_not_overwrite_later_user_edits_and_invalid_modes_are_zero_write() {
    let f = Fixture::new(true);
    for args in [
        vec!["remove", "--apply"],
        vec!["remove", "--expect", "invalid"],
        vec!["remove", "--apply", "--expect", "bad", "--dry-run"],
        vec!["remove", "--rollback", "bad", "--dry-run"],
    ] {
        let before = inventory(&f.base);
        assert_eq!(f.run(&args)["exit"], 2);
        assert_eq!(inventory(&f.base), before);
    }
    let applied = f.apply(&f.run(&["remove"]));
    assert_eq!(applied["status"], "removed", "{applied}");
    fs::write(f.root.join("AGENTS.md"), "later user edit").unwrap();
    let before = inventory(&f.base);
    let id = applied["evidence"]["transaction"]["transaction"]
        .as_str()
        .unwrap();
    assert_eq!(
        f.run(&["remove", "--rollback", id])["diagnostics"][0]["code"],
        "rollback_conflict"
    );
    assert_eq!(inventory(&f.base), before);
}

#[cfg(feature = "test-fixtures")]
#[test]
fn only_native_completed_checkpoints_can_be_removed_without_remote_writes() {
    for provider in ["github", "gitlab"] {
        let f = acceptance::fixture(provider);
        let tracked = f.root.join("notes.txt");
        fs::write(&tracked, "unchanged user content").unwrap();
        git(&f.root, &["add", "notes.txt"]);
        git(&f.root, &["commit", "-m", "user content"]);
        git(&f.root, &["rm", "--cached", ".specgit.yaml"]);
        initialize(&f.root);
        let inspect = || {
            let out = f
                .command(&["remove"])
                .env_remove("GIT_OPTIONAL_LOCKS")
                .output()
                .unwrap();
            serde_json::from_slice::<Value>(&out.stdout).unwrap()
        };
        fs::File::options()
            .write(true)
            .open(&tracked)
            .unwrap()
            .set_times(
                fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH + Duration::from_secs(1)),
            )
            .unwrap();
        let before = inventory(&f.root);
        let writes = f.writes();
        let rejected = inspect();
        assert_ne!(rejected["exit"], 0, "{provider}: {rejected}");
        assert_eq!(inventory(&f.root), before);
        f.edit(|s| {
            s["requests"][0]["state"] = json!(if provider == "github" {
                "closed"
            } else {
                "merged"
            });
            s["requests"][0]["merged"] = json!(true);
        });
        assert_ne!(f.run(&["remove"])["exit"], 0);
        f.edit(|s| s["issues"][0]["state"] = json!("closed"));
        fs::File::options()
            .write(true)
            .open(&tracked)
            .unwrap()
            .set_times(
                fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH + Duration::from_secs(2)),
            )
            .unwrap();
        let before = inventory(&f.root);
        let preview = inspect();
        assert_eq!(preview["status"], "prepared", "{provider}: {preview}");
        assert_eq!(inventory(&f.root), before);
        let digest = preview["evidence"]["preview_sha256"].as_str().unwrap();
        f.edit(|s| s["issues"][0]["state"] = json!("open"));
        let local = inventory(&f.root);
        assert_ne!(f.run(&["remove", "--apply", "--expect", digest])["exit"], 0);
        assert_eq!(inventory(&f.root), local);
        f.edit(|s| s["issues"][0]["state"] = json!("closed"));
        let applied = f.run(&["remove", "--apply", "--expect", digest]);
        assert_eq!(applied["status"], "removed", "{provider}: {applied}");
        let private =
            PathBuf::from(git(&f.root, &["rev-parse", "--absolute-git-dir"])).join("specgit-v2");
        assert!(!private.join("selection.json").exists());
        assert!(!f.root.join(".specgit.yaml").exists());
        assert_eq!(f.writes(), writes);
        let id = applied["evidence"]["transaction"]["transaction"]
            .as_str()
            .unwrap();
        // The rollback entrypoint requires neither the removed declaration nor native access.
        assert_eq!(
            f.run(&["remove", "--rollback", id])["status"],
            "rolled_back"
        );
        assert!(private.join("selection.json").exists());
    }
}

#[cfg(feature = "test-fixtures")]
#[test]
fn interrupted_removal_blocks_new_plans_and_recovers_from_durable_preimages() {
    let f = Fixture::new(true);
    let before = inventory(&f.root);
    let preview = f.run(&["remove"]);
    let out = Command::new(env!("CARGO_BIN_EXE_specgit"))
        .current_dir(&f.root)
        .args([
            "remove",
            "--apply",
            "--expect",
            preview["evidence"]["preview_sha256"].as_str().unwrap(),
        ])
        .env("SPECGIT_FIXTURE_ASSET_CRASH", "before-write:1")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(99));
    let rejected = f.run(&["remove"]);
    assert_ne!(rejected["exit"], 0, "{rejected}");
    let id = fs::read_dir(f.private.join("removal/transactions"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .file_name()
        .into_string()
        .unwrap();
    assert_eq!(
        f.run(&["remove", "--rollback", &id])["status"],
        "rolled_back"
    );
    for (path, value) in before {
        assert_eq!(inventory(&f.root).get(&path), Some(&value));
    }
}

#[test]
fn removal_help_and_schema_export_digest_gating_without_forge_access() {
    let out = executable::command()
        .args(["remove", "--schema"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let text = String::from_utf8(out.stdout).unwrap();
    for name in ["dry-run", "apply", "expect", "rollback"] {
        assert!(text.contains(name));
    }
    assert!(
        executable::command()
            .args(["remove", "--help"])
            .output()
            .unwrap()
            .status
            .success()
    );
}

#[cfg(feature = "test-fixtures")]
#[test]
fn removal_revalidates_owned_and_preserved_assets_after_lock_wait() {
    use std::{process::Stdio, time::Instant};
    for fault in ["owned content", "user hook", "permissions"] {
        #[cfg(not(unix))]
        if fault == "permissions" {
            continue;
        }
        let f = Fixture::new(true);
        let hook = PathBuf::from(git(
            &f.root,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "hooks/pre-push",
            ],
        ));
        fs::write(&hook, "user hook").unwrap();
        let preview = f.run(&["remove"]);
        let lock = AssetStore::lock(
            &f.private.join("assets"),
            std::slice::from_ref(&f.root),
            Duration::from_secs(1),
        )
        .unwrap();
        let ready = f.base.join("planned");
        let mut child = Command::new(env!("CARGO_BIN_EXE_specgit"))
            .current_dir(&f.root)
            .args([
                "remove",
                "--apply",
                "--expect",
                preview["evidence"]["preview_sha256"].as_str().unwrap(),
                "--json",
            ])
            .env("SPECGIT_FIXTURE_REMOVE_PLAN_READY", &ready)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        while !ready.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        if !ready.exists() {
            let _ = child.kill();
            let out = child.wait_with_output().unwrap();
            panic!("removal never completed planning: {out:?}");
        }
        match fault {
            "owned content" => {
                fs::write(f.root.join("AGENTS.md"), "user edit during lock wait").unwrap()
            }
            "user hook" => fs::write(&hook, "later user hook").unwrap(),
            _ => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(
                        f.root.join(".specgit.yaml"),
                        fs::Permissions::from_mode(0o640),
                    )
                    .unwrap();
                }
            }
        }
        let before = inventory(&f.base);
        drop(lock);
        let out = child.wait_with_output().unwrap();
        let result: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(
            result["diagnostics"][0]["code"], "concurrent_edit",
            "{fault}: {result}"
        );
        assert_eq!(inventory(&f.base), before);
        assert!(f.root.join(".specgit.yaml").exists());
    }
}

#[test]
fn changed_git_branch_invalidates_the_preview_even_with_identical_assets() {
    let f = Fixture::new(true);
    let preview = f.run(&["remove"]);
    git(&f.root, &["switch", "-c", "other"]);
    let before = inventory(&f.base);
    let rejected = f.apply(&preview);
    assert_eq!(
        rejected["diagnostics"][0]["code"], "concurrent_edit",
        "{rejected}"
    );
    assert_eq!(inventory(&f.base), before);
}
