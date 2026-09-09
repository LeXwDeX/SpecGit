//! Explicit v1 asset inventory. Unknown content is retained and prevents activation.
use crate::{
    assets::{Change, Snapshot, hash, safe_path},
    diagnostic::{Code, Diagnostic},
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

#[derive(Serialize)]
pub struct Item {
    pub path: PathBuf,
    pub before_sha256: Option<String>,
    pub after_sha256: Option<String>,
    pub action: &'static str,
    pub ownership: &'static str,
}
pub struct Inventory {
    pub items: Vec<Item>,
    pub changes: Vec<Change>,
    pub snapshots: BTreeMap<PathBuf, Snapshot>,
    pub blockers: Vec<PathBuf>,
}
fn conflict(message: &str) -> Diagnostic {
    Diagnostic::new(
        Code::OwnershipConflict,
        "migration",
        message,
        "Preserve the asset and reconcile its ownership or damaged markers before migration.",
    )
}
/// Remove only full marker lines, preserving all bytes outside the marked region.
pub fn strip_block(bytes: &[u8], start: &str, end: &str) -> Result<Option<Vec<u8>>, Diagnostic> {
    let text =
        std::str::from_utf8(bytes).map_err(|_| conflict("A migration asset is not UTF-8."))?;
    let mut offset = 0;
    let mut starts = vec![];
    let mut ends = vec![];
    for line in text.split_inclusive('\n') {
        let body = line.trim_end_matches(['\r', '\n']);
        if body == start {
            starts.push(offset);
        }
        if body == end {
            ends.push(offset + line.len());
        }
        offset += line.len();
    }
    match (starts.as_slice(), ends.as_slice()) {
        ([], []) => Ok(None),
        ([a], [b]) if a < b => Ok(Some([&bytes[..*a], &bytes[*b..]].concat())),
        _ => Err(conflict(
            "A legacy generated block has incomplete, duplicate or reversed markers.",
        )),
    }
}
fn entry_owned(text: &str) -> bool {
    const MARKER: &str = "<!-- specgit-managed-entry-point -->";
    if text.starts_with(&format!("{MARKER}\n")) {
        return true;
    }
    if !text.starts_with("---\n") {
        return false;
    }
    let Some(end) = text[4..].find("\n---\n").map(|n| n + 4) else {
        return false;
    };
    text[end + 5..].starts_with(&format!("\n{MARKER}\n"))
        || text[end + 5..].starts_with(&format!("{MARKER}\n"))
        || text[4..end].lines().any(|s| {
            matches!(
                s.trim(),
                "author: specgit" | "author: 'specgit'" | "author: \"specgit\""
            )
        })
}
fn pristine_router(document: &serde_yaml_ng::Value) -> bool {
    let Some(default) = document["specgit-request-completion"]["trigger"]["branch"].as_str() else {
        return false;
    };
    let Some(target_rule) = document["specgit-request-closure"]["rules"][0]["if"].as_str() else {
        return false;
    };
    let Some(encoded_target) =
        target_rule.strip_prefix("$CI_PIPELINE_SOURCE == \"push\" && $CI_COMMIT_BRANCH == ")
    else {
        return false;
    };
    let Ok(target) = serde_json::from_str::<String>(encoded_target) else {
        return false;
    };
    if !crate::config::valid_branch(default) || !crate::config::valid_branch(&target) {
        return false;
    }
    let condition = format!(
        "$CI_COMMIT_BRANCH == {} && $CI_PIPELINE_SOURCE == \"pipeline\" && $SPECGIT_SOURCE_PROJECT == $CI_PROJECT_ID && $SPECGIT_SOURCE_PIPELINE && (($SPECGIT_PR && $SPECGIT_HEAD) || ($SPECGIT_MERGE_SHA && $SPECGIT_TARGET_BRANCH))",
        serde_json::to_string(default).expect("string")
    );
    let trigger = serde_json::json!({"project":"$CI_PROJECT_PATH","branch":default,"forward":{"yaml_variables":true,"pipeline_variables":false}});
    let inheritance = serde_json::json!({"default":false,"variables":false});
    let expected = serde_json::json!({
        "include":[
            {"local":"/.gitlab/specgit-business.yml","rules":[{"if":condition,"when":"never"},{"when":"always"}]},
            {"local":"/.gitlab/specgit-complete.yml","rules":[{"if":condition}]}
        ],
        "specgit-request-completion":{
            "stage":".post","inherit":inheritance,
            "rules":[{"if":"$CI_PIPELINE_SOURCE == \"merge_request_event\"","when":"always"},{"when":"never"}],
            "variables":{"SPECGIT_PR":"$CI_MERGE_REQUEST_IID","SPECGIT_HEAD":"$CI_COMMIT_SHA","SPECGIT_SOURCE_PROJECT":"$CI_PROJECT_ID","SPECGIT_SOURCE_PIPELINE":"$CI_PIPELINE_ID"},
            "trigger":trigger
        },
        "specgit-request-closure":{
            "stage":".post","inherit":inheritance,
            "rules":[{"if":target_rule},{"when":"never"}],
            "variables":{"SPECGIT_MERGE_SHA":"$CI_COMMIT_SHA","SPECGIT_TARGET_BRANCH":"$CI_COMMIT_BRANCH","SPECGIT_SOURCE_PROJECT":"$CI_PROJECT_ID","SPECGIT_SOURCE_PIPELINE":"$CI_PIPELINE_ID"},
            "trigger":trigger
        }
    });
    serde_yaml_ng::to_value(expected).is_ok_and(|value| value == *document)
}
fn hook_json(bytes: &[u8], nested: bool) -> Result<Option<Vec<u8>>, Diagnostic> {
    let mut value = crate::input::json(bytes, 1_048_576, 24)?;
    let Some(top) = value.as_object_mut() else {
        return Err(conflict("A host configuration is not a JSON object."));
    };
    let events = if nested {
        let Some(hooks) = top.get_mut("hooks") else {
            return Ok(None);
        };
        hooks
            .as_object_mut()
            .ok_or_else(|| conflict("Host hooks are not an object."))?
    } else {
        top
    };
    let mut changed = false;
    for groups in events.values_mut() {
        let Some(groups) = groups.as_array_mut() else {
            continue;
        };
        for group in groups.iter_mut() {
            let Some(hooks) = group.get_mut("hooks").and_then(Value::as_array_mut) else {
                continue;
            };
            hooks.retain(|hook| {
                let owned = hook.get("command").and_then(Value::as_str)
                    == Some(".opencode/hooks/specgit-merge-guard.sh")
                    && hook.get("type").and_then(Value::as_str) == Some("command");
                changed |= owned;
                !owned
            });
        }
        // Empty groups may carry unknown metadata, so preserve them as well.
    }
    if !changed {
        return Ok(None);
    }
    serde_json::to_vec_pretty(&value)
        .map(Some)
        .map_err(|_| conflict("Cannot encode host configuration."))
}
fn walk(root: &Path, depth: usize, paths: &mut Vec<PathBuf>) -> Result<(), Diagnostic> {
    safe_path(root)?;
    if !root.exists() {
        return Ok(());
    }
    if depth > 8 {
        return Err(conflict(
            "The migration inventory exceeds its directory depth bound.",
        ));
    }
    let meta = fs::symlink_metadata(root)
        .map_err(|_| conflict("Cannot inspect a migration directory."))?;
    if !meta.is_dir() {
        paths.push(root.to_owned());
        return Ok(());
    }
    for entry in
        fs::read_dir(root).map_err(|_| conflict("Cannot enumerate a migration directory."))?
    {
        let path = entry
            .map_err(|_| conflict("Cannot enumerate a migration entry."))?
            .path();
        if paths.len() >= 512 {
            return Err(conflict("The migration inventory exceeds 512 files."));
        }
        walk(&path, depth + 1, paths)?;
    }
    Ok(())
}
pub fn legacy_present(root: &Path) -> Result<bool, Diagnostic> {
    for relative in [
        "spec_git/policy.yaml",
        ".github/workflows/specgit-complete.yml",
        ".github/workflows/specgit-accept.yml",
        ".gitlab/specgit-complete.yml",
        ".gitlab/specgit-accept.mjs",
        ".opencode/hooks/specgit-merge-guard.sh",
    ] {
        if Snapshot::read(&root.join(relative))?.bytes.is_some() {
            return Ok(true);
        }
    }
    for name in ["AGENTS.md", "CLAUDE.md"] {
        if Snapshot::read(&root.join(name))?
            .bytes
            .as_deref()
            .is_some_and(|bytes| String::from_utf8_lossy(bytes).contains("<!-- specgit:block:"))
        {
            return Ok(true);
        }
    }
    Ok(false)
}
impl Inventory {
    pub fn read(root: &Path, hook: &Path) -> Result<Self, Diagnostic> {
        let mut paths: Vec<_> = [
            ".specgit.yaml",
            "AGENTS.md",
            "CLAUDE.md",
            ".gitignore",
            ".gitlab-ci.yml",
            ".opencode/hooks.json",
            ".claude/settings.json",
            ".claude/settings.local.json",
        ]
        .iter()
        .map(|s| root.join(s))
        .collect();
        paths.push(hook.to_owned());
        for dir in [
            "spec_git",
            ".github/workflows",
            ".gitlab",
            ".opencode/hooks",
            ".opencode/command",
            ".agents/skills",
            ".claude/commands",
            ".claude/skills",
            ".codex/skills",
        ] {
            walk(&root.join(dir), 0, &mut paths)?;
        }
        paths.sort();
        paths.dedup();
        let mut inventory = Self {
            items: vec![],
            changes: vec![],
            snapshots: BTreeMap::new(),
            blockers: vec![],
        };
        let mut total = 0usize;
        for path in paths {
            let snapshot = Snapshot::read(&path)?;
            let Some(bytes) = &snapshot.bytes else {
                continue;
            };
            total = total.saturating_add(bytes.len());
            if bytes.len() > 1_048_576 || total > 32 * 1_048_576 {
                return Err(conflict(
                    "Migration assets exceed the 1 MiB file or 32 MiB total bound.",
                ));
            }
            let relative = path
                .strip_prefix(root)
                .ok()
                .and_then(Path::to_str)
                .unwrap_or("")
                .replace('\\', "/");
            let text = std::str::from_utf8(bytes).ok();
            let normalized = text.unwrap_or("").replace("\r\n", "\n");
            let mut after = Some(bytes.clone());
            let mut ownership = "foreign_preserved";
            let mut action = "preserve";
            let mut writer = false;
            if relative == ".specgit.yaml" || relative.starts_with("spec_git/") {
                ownership = "legacy_input_preserved";
            } else if ["AGENTS.md", "CLAUDE.md"].contains(&relative.as_str()) {
                if let Some(stripped) = strip_block(
                    bytes,
                    "<!-- specgit:block:start -->",
                    "<!-- specgit:block:end -->",
                )? {
                    after = Some(stripped);
                    ownership = "marked_block";
                    action = "remove_block";
                }
            } else if relative == ".gitignore" {
                if let Some(stripped) = strip_block(
                    bytes,
                    "# >>> specgit: local delivery assets (managed by specgit init) >>>",
                    "# <<< specgit: local delivery assets (managed by specgit init) <<<",
                )? {
                    after = Some(stripped);
                    ownership = "marked_block";
                    action = "remove_block";
                }
            } else if path == hook {
                if let Some(stripped) =
                    strip_block(bytes, "# >>> specgit:start >>>", "# <<< specgit:end <<<")?
                {
                    after = Some(stripped);
                    ownership = "marked_block";
                    action = "remove_block";
                } else if normalized.to_ascii_lowercase().contains("specgit") {
                    writer = true;
                }
            } else if [
                ".opencode/hooks.json",
                ".claude/settings.json",
                ".claude/settings.local.json",
            ]
            .contains(&relative.as_str())
            {
                if let Some(stripped) = hook_json(bytes, relative != ".opencode/hooks.json")? {
                    after = Some(stripped);
                    ownership = "exact_hook_command";
                    action = "remove_hook";
                }
                writer = String::from_utf8_lossy(after.as_deref().unwrap_or_default())
                    .contains("specgit");
            } else if relative == ".gitlab-ci.yml"
                && normalized.starts_with("# Managed by SpecGit: isolated GitLab routing.\n")
            {
                let document: serde_yaml_ng::Value = serde_yaml_ng::from_slice(bytes)
                    .map_err(|_| conflict("The legacy routing document is malformed."))?;
                if !pristine_router(&document) {
                    return Err(conflict(
                        "The generated GitLab router has user edits or an unrecognized generation; preserve and reconcile it before retirement.",
                    ));
                }
                // The routed business document remains separately preserved and is restored verbatim.
                let source = root.join(".gitlab/specgit-business.yml");
                let business = Snapshot::read(&source)?;
                after = Some(business.bytes.ok_or_else(|| {
                    conflict("The preserved GitLab business configuration is missing.")
                })?);
                ownership = "marked_routing";
                action = "restore_business";
                writer = String::from_utf8_lossy(after.as_deref().unwrap_or_default())
                    .contains("specgit");
            } else if relative == ".gitlab/specgit-accept.mjs"
                && normalized.starts_with("// Managed by SpecGit: acceptance checkout adapter.\n")
            {
                after = None;
                ownership = "generated_acceptance_adapter";
                action = "retire";
            } else if relative.starts_with(".github/workflows/")
                || relative.starts_with(".gitlab/")
                || relative == ".gitlab-ci.yml"
            {
                if normalized.starts_with("# Managed by SpecGit: trusted delivery completion.\n")
                    || normalized.starts_with(
                        "# Managed by SpecGit: include in a trusted default-branch pipeline.\n",
                    )
                    || (relative == ".github/workflows/specgit-accept.yml"
                        && normalized.starts_with("name: SpecGit Acceptance\n")
                        && normalized.contains("specgit finish"))
                {
                    after = None;
                    ownership = "generated_workflow";
                    action = "retire";
                } else if let Some(stripped) = strip_block(
                    bytes,
                    "# specgit:ci-acceptance:start",
                    "# specgit:ci-acceptance:end",
                )? {
                    after = Some(stripped);
                    ownership = "marked_block";
                    action = "remove_block";
                    writer = String::from_utf8_lossy(after.as_deref().unwrap_or_default())
                        .contains("specgit");
                } else if relative != ".gitlab/specgit-business.yml"
                    && normalized.to_ascii_lowercase().contains("specgit")
                {
                    writer = true;
                }
            } else if relative == ".opencode/hooks/specgit-merge-guard.sh"
                && normalized.starts_with("#!/bin/sh\n# SpecGit guard (managed by specgit init):")
            {
                after = None;
                ownership = "generated_guard";
                action = "retire";
            } else if entry_owned(&normalized) {
                after = None;
                ownership = "anchored_entrypoint";
                action = "retire";
            } else if normalized.to_ascii_lowercase().contains("specgit") {
                writer = true;
            }
            if writer {
                inventory.blockers.push(path.clone());
            }
            inventory.items.push(Item {
                path: path.clone(),
                before_sha256: snapshot.digest(),
                after_sha256: after.as_deref().map(hash),
                action,
                ownership,
            });
            if after != snapshot.bytes {
                inventory.changes.push(Change {
                    path: path.clone(),
                    permissions: snapshot.permissions.clone(),
                    before: snapshot.clone(),
                    after,
                });
            }
            inventory.snapshots.insert(path, snapshot);
        }
        Ok(inventory)
    }
    pub fn verify(&self) -> Result<(), Diagnostic> {
        for (path, expected) in &self.snapshots {
            let actual = Snapshot::read(path)?;
            if actual.bytes != expected.bytes || actual.permissions != expected.permissions {
                return Err(Diagnostic::new(
                    Code::ConcurrentEdit,
                    "migration",
                    "An inventoried asset changed after preview.",
                    "Keep concurrent edits and generate a fresh migration preview.",
                ));
            }
        }
        Ok(())
    }
}
