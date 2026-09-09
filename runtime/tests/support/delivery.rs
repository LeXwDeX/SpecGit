#[path = "snapshot.rs"]
mod snapshot;
use serde_json::{Value, json};
use std::{fs, path::PathBuf, process::Command};
pub struct Fixture {
    _temp: tempfile::TempDir,
    pub root: PathBuf,
    state: PathBuf,
    bin: PathBuf,
}
impl Fixture {
    pub fn new(provider: &str) -> Self {
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
    pub fn run(&self, args: &[&str]) -> Value {
        let out = self.command(args).output().unwrap();
        let value: Value = serde_json::from_slice(&out.stdout)
            .unwrap_or_else(|_| panic!("stdout={:?} stderr={:?}", out.stdout, out.stderr));
        assert_eq!(value["exit"].as_i64(), out.status.code().map(i64::from));
        value
    }
    pub fn command(&self, args: &[&str]) -> Command {
        let mut paths = vec![self.bin.clone()];
        paths.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        let mut command = Command::new(env!("CARGO_BIN_EXE_specgit"));
        command
            .current_dir(&self.root)
            .env("PATH", std::env::join_paths(paths).unwrap())
            .env("SPECGIT_FIXTURE_API_FILE", &self.state)
            .args(args)
            .arg("--json");
        command
    }
    pub fn state(&self) -> Value {
        serde_json::from_slice(&fs::read(&self.state).unwrap()).unwrap()
    }
    pub fn edit(&self, f: impl FnOnce(&mut Value)) {
        let mut s = self.state();
        f(&mut s);
        snapshot::write(&self.state, &s);
    }
    pub fn writes(&self) -> usize {
        self.state()["calls"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| v["method"] != "GET")
            .count()
    }
}
