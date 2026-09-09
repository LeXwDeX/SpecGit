#![cfg(feature = "test-fixtures")]
use serde_json::{Value, json};
use std::{fs, path::PathBuf, process::Command};
struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    state: PathBuf,
    bin: PathBuf,
}
impl Fixture {
    fn new(provider: &str) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap();
        let root = base.join("project");
        fs::create_dir_all(&root).unwrap();
        for args in [
            vec!["init", "-b", "feature"],
            vec!["config", "user.name", "Fixture"],
            vec!["config", "user.email", "fixture@example.invalid"],
            vec![
                "remote",
                "add",
                "origin",
                "https://forge.example/fixture/repo.git",
            ],
        ] {
            assert!(
                Command::new("git")
                    .current_dir(&root)
                    .args(args)
                    .output()
                    .unwrap()
                    .status
                    .success()
            );
        }
        fs::write(
            root.join(".specgit.yaml"),
            format!(
                "version: 2\nremote: origin\nprovider: {provider}\nvalidation:\n  labels: kind\n"
            ),
        )
        .unwrap();
        for args in [
            vec!["add", ".specgit.yaml"],
            vec!["commit", "-m", "fixture"],
        ] {
            assert!(
                Command::new("git")
                    .current_dir(&root)
                    .args(args)
                    .output()
                    .unwrap()
                    .status
                    .success()
            );
        }
        let state = base.join("api.json");
        fs::write(&state,json!({"calls":[],"issues":[],"labels":[],"project":{"id":7,"full_name":"fixture/repo","path_with_namespace":"fixture/repo","default_branch":"main","delete_branch_on_merge":false,"remove_source_branch_after_merge":false}}).to_string()).unwrap();
        let bin = base.join("bin");
        fs::create_dir(&bin).unwrap();
        for name in ["gh", "glab"] {
            fs::copy(
                env!("CARGO_BIN_EXE_specgit-process-fixture"),
                bin.join(if cfg!(windows) {
                    format!("{name}.exe")
                } else {
                    name.into()
                }),
            )
            .unwrap();
        }
        Self {
            _temp: temp,
            root,
            state,
            bin,
        }
    }
    fn run(&self, args: &[&str]) -> Value {
        let mut paths = vec![self.bin.clone()];
        paths.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        let out = Command::new(env!("CARGO_BIN_EXE_specgit"))
            .current_dir(&self.root)
            .env("PATH", std::env::join_paths(paths).unwrap())
            .env("SPECGIT_FIXTURE_API_FILE", &self.state)
            .args(args)
            .arg("--json")
            .output()
            .unwrap();
        let value: Value = serde_json::from_slice(&out.stdout)
            .unwrap_or_else(|_| panic!("stdout={:?} stderr={:?}", out.stdout, out.stderr));
        assert_eq!(value["exit"].as_i64(), out.status.code().map(i64::from));
        value
    }
    fn state(&self) -> Value {
        serde_json::from_slice(&fs::read(&self.state).unwrap()).unwrap()
    }
    fn edit(&self, f: impl FnOnce(&mut Value)) {
        let mut s = self.state();
        f(&mut s);
        fs::write(&self.state, s.to_string()).unwrap();
    }
    fn writes(&self) -> usize {
        self.state()["calls"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| v["method"] != "GET")
            .count()
    }
}
#[test]
fn both_forges_create_many_specs_then_resume_preserving_native_edits_without_new_writes() {
    for provider in ["github", "gitlab"] {
        let f = Fixture::new(provider);
        let r = f.run(&["issue", "feat: first delivery", "fix: second delivery"]);
        assert_eq!(r["exit"], 0, "{r}");
        assert_eq!(r["evidence"]["selection"]["issues"], json!([1, 2]));
        assert_eq!(f.writes(), 4);
        f.edit(|s| {
            s["issues"][0]["title"] = json!("feat: revised user title");
            s["issues"][0][if provider == "github" {
                "body"
            } else {
                "description"
            }] = json!("User changes remain");
        });
        let r = f.run(&["issue", "1", "2"]);
        assert_eq!(r["exit"], 0, "{r}");
        assert_eq!(r["evidence"]["issues"][0]["body"], "User changes remain");
        assert_eq!(f.writes(), 4);
        let status = Command::new("git")
            .current_dir(&f.root)
            .args(["status", "--porcelain"])
            .output()
            .unwrap();
        assert!(status.stdout.is_empty());
    }
}
#[test]
fn preflight_invalid_later_spec_or_incomplete_search_writes_nothing() {
    let f = Fixture::new("github");
    let r = f.run(&["issue", "feat: valid first", "unknown: bad second"]);
    assert_eq!(r["exit"], 2, "{r}");
    assert_eq!(f.writes(), 0);
    f.edit(|s| s["search_incomplete"] = json!(true));
    let r = f.run(&["issue", "feat: valid first"]);
    assert_eq!(r["exit"], 3, "{r}");
    assert_eq!(f.writes(), 0);
}
#[test]
fn response_loss_requires_exact_native_adoption_and_never_duplicates() {
    for provider in ["github", "gitlab"] {
        let f = Fixture::new(provider);
        f.edit(|s| s["lose_issue_response"] = json!(true));
        let r = f.run(&["issue", "fix: lost response"]);
        assert_eq!(r["exit"], 3, "{r}");
        assert_eq!(f.state()["issues"].as_array().unwrap().len(), 1);
        let writes = f.writes();
        let r = f.run(&["issue", "fix: lost response"]);
        assert_eq!(r["exit"], 3, "{r}");
        assert_eq!(f.writes(), writes);
        let r = f.run(&["issue", "1"]);
        assert_eq!(r["exit"], 0, "{r}");
        assert_eq!(f.writes(), writes);
        assert_eq!(r["evidence"]["selection"]["intents"][0]["issue"], 1);
    }
}
#[test]
fn inspect_does_not_create_checkpoint_and_branch_selection_preserves_git_state() {
    let f = Fixture::new("github");
    let r = f.run(&[
        "issue",
        "feat: inspect",
        "--inspect",
        "--branch",
        "new-delivery",
    ]);
    assert_eq!(r["exit"], 0, "{r}");
    assert_eq!(f.writes(), 0);
    assert!(!f.root.join(".git/specgit-v2").exists());
    let r = f.run(&["issue", "feat: inspect", "--branch", "new-delivery"]);
    assert_eq!(r["exit"], 0, "{r}");
    assert_eq!(r["evidence"]["selection"]["branch"], "new-delivery");
    fs::write(f.root.join("user.txt"), "uncommitted").unwrap();
    let r = f.run(&["issue", "feat: another", "--branch", "another"]);
    assert_eq!(r["exit"], 2, "{r}");
    assert_eq!(
        fs::read_to_string(f.root.join("user.txt")).unwrap(),
        "uncommitted"
    );
}
