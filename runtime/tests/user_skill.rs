//! User assets are exercised only with an isolated home, through the real CLI.
use serde_json::{Value, json};
use specgit::assets::hash;
use std::{fs, path::PathBuf, process::Command};
#[path = "support/executable.rs"]
mod executable;

struct Fixture {
    _temp: tempfile::TempDir,
    home: PathBuf,
    path: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        let path = home.join(".agents/skills/specgit-native/SKILL.md");
        Self {
            _temp: temp,
            home,
            path,
        }
    }
    fn command(&self) -> Command {
        let mut command = executable::command();
        command
            .current_dir(&self.home)
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home);
        command
    }
    fn run(&self, args: &[&str]) -> Value {
        let output = self.command().args(args).arg("--json").output().unwrap();
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            report["exit"].as_i64(),
            output.status.code().map(i64::from),
            "{report}"
        );
        let schema: Value =
            serde_json::from_str(include_str!("../schemas/report.schema.json")).unwrap();
        jsonschema::draft202012::validate(&schema, &report).unwrap();
        report
    }
    fn write(&self, bytes: &[u8]) {
        fs::create_dir_all(self.path.parent().unwrap()).unwrap();
        fs::write(&self.path, bytes).unwrap();
    }
}
fn managed(body: &str) -> Vec<u8> {
    format!(
        "{body}<!-- specgit:managed sha256={} -->\n",
        hash(body.as_bytes())
    )
    .into_bytes()
}
fn assert_owned(bytes: &[u8]) {
    let text = std::str::from_utf8(bytes).unwrap();
    let (body, marker) = text.rsplit_once("<!-- specgit:managed sha256=").unwrap();
    assert_eq!(marker, format!("{} -->\n", hash(body.as_bytes())));
    assert!(body.contains(env!("CARGO_PKG_VERSION")));
}

#[test]
fn install_requires_explicit_user_and_writes_only_the_skill() {
    let f = Fixture::new();
    assert_eq!(f.run(&["skill"])["exit"], 2);
    assert!(!f.home.join(".agents").exists());
    let report = f.run(&["skill", "--user"]);
    assert_eq!(report["exit"], 0, "{report}");
    assert_eq!(report["operation"], "skill");
    assert_eq!(report["status"], "installed");
    assert_eq!(report["effects"]["outcome"], "applied");
    assert_owned(&fs::read(&f.path).unwrap());
    assert_eq!(fs::read_dir(f.path.parent().unwrap()).unwrap().count(), 1);
}
#[test]
fn managed_refresh_uses_current_bytes_and_edited_refresh_preserves_backup() {
    let f = Fixture::new();
    f.write(&managed("old version\n"));
    let report = f.run(&["skill", "--user"]);
    assert_eq!(report["status"], "refreshed", "{report}");
    let current = fs::read(&f.path).unwrap();
    assert_owned(&current);
    assert_eq!(fs::read_dir(f.path.parent().unwrap()).unwrap().count(), 1);
    let edited = [b"user edit\n".as_slice(), current.as_slice()].concat();
    f.write(&edited);
    for _ in 0..2 {
        let report = f.run(&["skill", "--user"]);
        assert_eq!(report["exit"], 0, "{report}");
        let backup = PathBuf::from(report["evidence"]["backup"].as_str().unwrap());
        assert_eq!(backup.parent(), f.path.parent());
        assert!(
            backup
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("SKILL.md.specgit-backup-")
        );
        assert_eq!(fs::read(backup).unwrap(), edited);
        assert_eq!(fs::read(&f.path).unwrap(), current);
        f.write(&edited);
    }
    assert_eq!(fs::read_dir(f.path.parent().unwrap()).unwrap().count(), 3);
}
#[test]
fn foreign_content_conflicts_but_refresh_only_skips_it() {
    let f = Fixture::new();
    f.write(b"foreign skill\n");
    for args in [&["skill", "--user"][..], &["skill", "--user", "--remove"]] {
        let report = f.run(args);
        assert_eq!(
            report["diagnostics"][0]["code"], "ownership_conflict",
            "{report}"
        );
        assert_eq!(fs::read(&f.path).unwrap(), b"foreign skill\n");
    }
    assert_eq!(
        f.run(&["skill", "--user", "--refresh-only"])["status"],
        "skipped"
    );
    assert_eq!(fs::read_dir(f.path.parent().unwrap()).unwrap().count(), 1);
}
#[test]
fn dry_run_never_creates_directories_backups_or_deletes_files() {
    let f = Fixture::new();
    let report = f.run(&["skill", "--user", "--dry-run"]);
    assert_eq!(report["status"], "prepared", "{report}");
    assert_eq!(report["evidence"]["action"], "install");
    assert!(!f.home.join(".agents").exists());
    let edited = [b"edit\n".as_slice(), &managed("old\n")].concat();
    f.write(&edited);
    assert_eq!(
        f.run(&["skill", "--user", "--dry-run"])["status"],
        "prepared"
    );
    assert_eq!(fs::read(&f.path).unwrap(), edited);
    assert_eq!(fs::read_dir(f.path.parent().unwrap()).unwrap().count(), 1);
    f.write(&managed("old\n"));
    assert_eq!(
        f.run(&["skill", "--user", "--remove", "--dry-run"])["evidence"]["action"],
        "remove"
    );
    assert!(f.path.exists());
}
#[test]
fn removal_preserves_edits_and_other_files() {
    let f = Fixture::new();
    f.write(&[b"edit\n".as_slice(), &managed("old\n")].concat());
    let report = f.run(&["skill", "--user", "--remove"]);
    assert_eq!(
        report["diagnostics"][0]["code"], "ownership_conflict",
        "{report}"
    );
    assert!(f.path.exists());
    f.write(&managed("old\n"));
    let other = f.path.parent().unwrap().join("user.txt");
    fs::write(&other, b"keep").unwrap();
    assert_eq!(f.run(&["skill", "--user", "--remove"])["status"], "removed");
    assert!(!f.path.exists());
    assert!(other.exists());
    fs::remove_file(other).unwrap();
    f.write(&managed("old\n"));
    assert_eq!(f.run(&["skill", "--user", "--remove"])["status"], "removed");
    assert!(!f.path.parent().unwrap().exists());
}
#[test]
fn refresh_only_skips_absence_and_refreshes_owned_files() {
    let f = Fixture::new();
    assert_eq!(
        f.run(&["skill", "--user", "--refresh-only"])["status"],
        "skipped"
    );
    assert!(!f.home.join(".agents").exists());
    f.write(&managed("old\n"));
    assert_eq!(
        f.run(&["skill", "--user", "--refresh-only"])["status"],
        "refreshed"
    );
    assert_owned(&fs::read(&f.path).unwrap());
}
#[test]
fn invalid_home_is_input_failure_without_writes() {
    let f = Fixture::new();
    for home in [None, Some(""), Some("relative")] {
        let mut command = f.command();
        command.env_remove("HOME").env_remove("USERPROFILE");
        if let Some(home) = home {
            command.env("HOME", home).env("USERPROFILE", home);
        }
        let output = command
            .args(["skill", "--user", "--json"])
            .output()
            .unwrap();
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["exit"], 2, "{report}");
        assert_eq!(report["operation"], "skill", "{report}");
    }
    assert!(!f.home.join(".agents").exists());
}

#[test]
fn content_appended_after_the_marker_is_backed_up_not_discarded() {
    let f = Fixture::new();
    let edited = [managed("old\n"), b"user appended text\n".to_vec()].concat();
    f.write(&edited);
    assert_eq!(
        f.run(&["skill", "--user", "--remove"])["diagnostics"][0]["code"],
        "ownership_conflict"
    );
    let report = f.run(&["skill", "--user"]);
    assert_eq!(report["exit"], 0, "{report}");
    let backup = report["evidence"]["backup"].as_str().unwrap();
    assert_eq!(fs::read(backup).unwrap(), edited);
    assert_owned(&fs::read(&f.path).unwrap());
}

#[test]
fn unchanged_refresh_is_a_noop_and_nonfiles_fail_closed() {
    let f = Fixture::new();
    assert_eq!(f.run(&["skill", "--user", "--remove"])["status"], "skipped");
    assert!(!f.home.join(".agents").exists());
    assert_eq!(f.run(&["skill", "--user"])["exit"], 0);
    let before = fs::read(&f.path).unwrap();
    let report = f.run(&["skill", "--user"]);
    assert_eq!(report["status"], "refreshed");
    assert_eq!(report["effects"]["outcome"], "not_applied");
    assert_eq!(fs::read(&f.path).unwrap(), before);
    fs::remove_file(&f.path).unwrap();
    fs::create_dir(&f.path).unwrap();
    assert_eq!(
        f.run(&["skill", "--user"])["diagnostics"][0]["code"],
        "ownership_conflict"
    );
}

#[cfg(unix)]
#[test]
fn existing_skill_permissions_are_preserved_on_refresh_and_backup() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    f.write(&[b"edit\n".as_slice(), &managed("old\n")].concat());
    fs::set_permissions(&f.path, fs::Permissions::from_mode(0o640)).unwrap();
    let report = f.run(&["skill", "--user"]);
    assert_eq!(report["exit"], 0, "{report}");
    for path in [
        &f.path,
        &PathBuf::from(report["evidence"]["backup"].as_str().unwrap()),
    ] {
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }
}

#[test]
fn another_process_lock_preserves_the_original_file() {
    let f = Fixture::new();
    let before = managed("old\n");
    f.write(&before);
    let lock = fs::File::open(&f.path).unwrap();
    lock.try_lock().unwrap();
    let report = f.run(&["skill", "--user"]);
    // Windows refuses the initial read through another locked handle; Unix
    // permits the read but refuses the second writer's advisory lock.
    assert!(
        matches!(
            report["diagnostics"][0]["code"].as_str(),
            Some("lock_busy" | "io_failed")
        ),
        "{report}"
    );
    drop(lock);
    assert_eq!(fs::read(&f.path).unwrap(), before);
    assert_eq!(fs::read_dir(f.path.parent().unwrap()).unwrap().count(), 1);
}
#[cfg(unix)]
#[test]
fn symlinks_at_every_user_asset_component_are_refused() {
    for relative in [
        ".agents",
        ".agents/skills",
        ".agents/skills/specgit-native",
        ".agents/skills/specgit-native/SKILL.md",
    ] {
        let f = Fixture::new();
        let link = f.home.join(relative);
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        let target = f.home.join("outside");
        fs::create_dir(&target).unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        for args in [
            &["skill", "--user"][..],
            &["skill", "--user", "--dry-run"],
            &["skill", "--user", "--remove"],
            &["skill", "--user", "--refresh-only"],
        ] {
            let report = f.run(args);
            assert_eq!(
                report["diagnostics"][0]["code"], "unsafe_path",
                "{relative}: {report}"
            );
        }
        assert_eq!(fs::read_dir(target).unwrap().count(), 0);
    }
}
#[test]
fn help_schema_and_json_input_describe_explicit_user_scope() {
    let f = Fixture::new();
    let help = f.run(&["skill", "--help"]);
    for flag in ["--user", "--dry-run", "--remove", "--refresh-only"] {
        assert!(
            help["evidence"]["text"].as_str().unwrap().contains(flag),
            "{help}"
        );
    }
    let schema = f.run(&["skill", "--schema"]);
    let args = schema["evidence"]["command"]["arguments"]
        .as_array()
        .unwrap();
    assert!(
        args.iter()
            .any(|arg| arg["long"] == "user" && arg["required"] == true)
    );
    let request = f.home.join("request.json");
    fs::write(
        &request,
        json!({"command":"skill","options":{"user":true,"dry-run":true}}).to_string(),
    )
    .unwrap();
    let report = f.run(&["--input-file", request.to_str().unwrap()]);
    assert_eq!(report["status"], "prepared", "{report}");
    assert!(!f.home.join(".agents").exists());
}
