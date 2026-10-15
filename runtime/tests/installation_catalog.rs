//! The installation catalog is a pure discovery surface, even without a project or tools.
#[path = "support/executable.rs"]
mod executable;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

fn files(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut found = BTreeMap::new();
    fn visit(base: &Path, dir: &Path, found: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                visit(base, &path, found);
            } else {
                found.insert(
                    path.strip_prefix(base).unwrap().to_owned(),
                    fs::read(path).unwrap(),
                );
            }
        }
    }
    visit(root, root, &mut found);
    found
}

#[test]
fn catalog_is_available_offline_without_project_tools_and_leaves_directory_unchanged() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("manual.txt"), "keep this content").unwrap();
    let before = files(temp.path());
    let out = executable::command()
        .current_dir(temp.path())
        .env("PATH", temp.path())
        .args(["setup", "--catalog", "--json"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    assert!(
        out.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let report: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(report["operation"], "setup");
    assert_eq!(report["status"], "catalog");
    let catalog = &report["evidence"]["installation_catalog"];
    assert_eq!(catalog["catalog_version"], 1);
    assert_eq!(catalog["host_discovery"], "not_performed");
    assert_eq!(catalog["installation_verification"], "not_performed");
    assert_eq!(catalog["side_effects"], "none");
    assert_eq!(catalog["runtime_version"], env!("CARGO_PKG_VERSION"));
    let ids: Vec<_> = catalog["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap())
        .collect();
    for id in [
        "project_skill",
        "instruction_entry",
        "session_context",
        "tool_context",
        "git_guard",
        "observation",
        "local_exclusions",
        "private_state",
    ] {
        assert!(ids.contains(&id), "missing {id}");
    }
    assert_eq!(files(temp.path()), before);
}

#[test]
fn catalog_rejects_installation_selectors_before_any_work() {
    let temp = tempfile::tempdir().unwrap();
    for extra in [
        vec!["--agent", "generic"],
        vec!["--dry-run"],
        vec!["--uninstall"],
        vec!["--rollback", "tx-example"],
        vec!["--hook-purpose", "context"],
        vec!["--opencode-claude-hooks"],
        vec!["--opencode-async-rewake"],
    ] {
        let out = executable::command()
            .current_dir(temp.path())
            .env("PATH", temp.path())
            .args(["setup", "--catalog", "--json"])
            .args(&extra)
            .output()
            .unwrap();
        assert_eq!(
            out.status.code(),
            Some(2),
            "{extra:?}: {}",
            String::from_utf8_lossy(&out.stdout)
        );
        let report: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(report["ok"], false);
        assert!(files(temp.path()).is_empty());
    }
}

#[test]
fn catalog_is_discoverable_through_schema_explicit_input_and_human_output() {
    let temp = tempfile::tempdir().unwrap();
    let out = executable::command()
        .args(["setup", "--schema"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let report: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert!(
        report["evidence"]["command"]["arguments"]
            .as_array()
            .unwrap()
            .iter()
            .any(|arg| arg["long"] == "catalog")
    );
    let input = temp.path().join("request.json");
    fs::write(&input, r#"{"command":"setup","options":{"catalog":true}}"#).unwrap();
    let out = executable::command()
        .current_dir(temp.path())
        .env("PATH", temp.path())
        .arg("--input-file")
        .arg(&input)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    let report: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(report["status"], "catalog");
    let out = executable::command()
        .current_dir(temp.path())
        .env("PATH", temp.path())
        .args(["setup", "--catalog", "--human"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let text = String::from_utf8(out.stdout).unwrap();
    assert!(
        text.contains("project_skill") && text.contains("git_guard"),
        "{text}"
    );
    assert!(
        !text.trim_start().starts_with('{'),
        "human output must be readable guidance"
    );
}

#[test]
fn catalog_ignores_an_unavailable_project_directory() {
    let temp = tempfile::tempdir().unwrap();
    let missing = temp.path().join("unavailable");
    let out = executable::command()
        .env("PATH", temp.path())
        .arg("--cwd")
        .arg(&missing)
        .args(["setup", "--catalog", "--json"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    let report: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(report["status"], "catalog");
    assert!(!missing.exists());
}

#[test]
fn catalog_schema_rejects_installation_claims_and_malformed_commands() {
    let out = executable::command()
        .args(["setup", "--catalog", "--json"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let report: Value = serde_json::from_slice(&out.stdout).unwrap();
    let schema: Value =
        serde_json::from_str(include_str!("../schemas/report.schema.json")).unwrap();
    jsonschema::draft202012::validate(&schema, &report).unwrap();
    for (pointer, value) in [
        (
            "/evidence/installation_catalog/host_discovery",
            Value::from("verified"),
        ),
        (
            "/evidence/installation_catalog/installation_verification",
            Value::from("verified"),
        ),
        (
            "/evidence/installation_catalog/side_effects",
            Value::from("installed"),
        ),
        (
            "/evidence/installation_catalog/items/0/verification/written",
            Value::from(true),
        ),
        (
            "/evidence/installation_catalog/items/0/commands/0/argv",
            Value::from("specgit setup"),
        ),
        (
            "/evidence/installation_catalog/entrypoints/0/requires_project",
            Value::from("false"),
        ),
    ] {
        let mut invalid = report.clone();
        *invalid.pointer_mut(pointer).unwrap() = value;
        assert!(
            jsonschema::draft202012::validate(&schema, &invalid).is_err(),
            "accepted invalid {pointer}"
        );
    }
    let mut invalid = report;
    invalid["evidence"] = serde_json::json!({"installed": true});
    assert!(jsonschema::draft202012::validate(&schema, &invalid).is_err());
}
