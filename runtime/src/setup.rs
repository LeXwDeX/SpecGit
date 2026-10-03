//! Project-only integration. The executable is installed separately by the user.
use crate::{
    assets::{self, AssetStore, Change, Snapshot},
    diagnostic::{Code, Diagnostic},
    input,
    process::Process,
    report::Report,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
};
const VERSION: &str = env!("CARGO_PKG_VERSION");
pub mod project;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Project,
}

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, clap::ValueEnum,
)]
#[serde(rename_all = "snake_case")]
pub enum Agent {
    Generic,
    Claude,
    Codex,
    Opencode,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
struct HostRegistration {
    root: PathBuf,
    skill_hash: String,
    instructions: String,
    block: String,
    created_instructions: bool,
}
const HOST_START: &str = "<!-- specgit:project:v2:start -->";
const HOST_END: &str = "<!-- specgit:project:v2:end -->";
const LEGACY_START: &str = "<!-- specgit:global:v2:start -->";
const LEGACY_END: &str = "<!-- specgit:global:v2:end -->";
const TOOL_MATCHER: &str = "Write|Edit|MultiEdit|Bash|PowerShell|apply_patch|functions.apply_patch|mcp__functions__apply_patch";

fn instruction_change(
    host: &str,
    root: &Path,
    old: Option<&HostRegistration>,
    uninstall: bool,
) -> Result<(Change, Option<HostRegistration>), Diagnostic> {
    if old.is_some_and(|r| r.root != root) {
        return Err(conflict_at(
            host,
            root,
            None,
            "The recorded guidance belongs to another project.",
        ));
    }
    if host == "codex"
        && old.is_some_and(|r| r.instructions == "AGENTS.md")
        && Snapshot::read(&root.join("AGENTS.override.md"))?
            .bytes
            .is_some_and(|b| !b.iter().all(u8::is_ascii_whitespace))
    {
        return Err(conflict_at(
            host,
            &root.join("AGENTS.override.md"),
            None,
            "A new Codex override shadows the registered instructions; reconcile the host guidance first.",
        ));
    }
    let instructions = if let Some(old) = old {
        if !["AGENTS.md", "AGENTS.override.md", "CLAUDE.md"].contains(&old.instructions.as_str()) {
            return Err(conflict_at(
                host,
                root,
                None,
                "The host instruction receipt is unsafe.",
            ));
        }
        old.instructions.clone()
    } else if host == "codex"
        && Snapshot::read(&root.join("AGENTS.override.md"))?
            .bytes
            .is_some_and(|b| !b.iter().all(u8::is_ascii_whitespace))
    {
        "AGENTS.override.md".into()
    } else if host == "claude" {
        "CLAUDE.md".into()
    } else {
        "AGENTS.md".into()
    };
    let mut guidance = Change::new(root.join(&instructions), None)?;
    let before = std::str::from_utf8(guidance.before.bytes.as_deref().unwrap_or_default())
        .map_err(|_| {
            conflict_at(
                host,
                &guidance.path,
                None,
                "Host instructions must be UTF-8.",
            )
        })?;
    let prompt = crate::prompts::host_entry();
    let entry = prompt.trim_end();
    let generated = format!("{HOST_START}\n## SpecGit 2\n\n{entry}\n{HOST_END}");
    let (after, block) = if let Some(old) = old {
        // 2.3 used a global-labelled marker even in proven project receipts.
        let (start, end, other_start, other_end) = if old.block.contains(HOST_START) {
            (HOST_START, HOST_END, LEGACY_START, LEGACY_END)
        } else {
            (LEGACY_START, LEGACY_END, HOST_START, HOST_END)
        };
        if before.matches(start).count() != 1
            || before.matches(end).count() != 1
            || !old.block.contains(start)
            || !old.block.contains(end)
            || before.contains(other_start)
            || before.contains(other_end)
            || before.matches(&old.block).count() != 1
        {
            return Err(conflict_at(
                host,
                &guidance.path,
                None,
                "The managed host instruction block was edited or removed.",
            ));
        }
        let block = format!(
            "{}{generated}\n",
            if old.block.starts_with("\n\n") {
                "\n\n"
            } else {
                ""
            }
        );
        (
            before.replacen(&old.block, if uninstall { "" } else { &block }, 1),
            block,
        )
    } else {
        if [HOST_START, HOST_END, LEGACY_START, LEGACY_END]
            .iter()
            .any(|marker| before.contains(marker))
        {
            return Err(conflict_at(
                host,
                &guidance.path,
                None,
                "An unowned SpecGit instruction marker already exists.",
            ));
        }
        let block = format!(
            "{}{generated}\n",
            if before.is_empty() { "" } else { "\n\n" }
        );
        (format!("{before}{block}"), block)
    };
    let created_instructions =
        old.map_or(guidance.before.bytes.is_none(), |r| r.created_instructions);
    guidance.after = if uninstall && created_instructions && after.is_empty() {
        None
    } else {
        Some(after.into_bytes())
    };
    let registration = (!uninstall).then(|| HostRegistration {
        root: root.to_owned(),
        skill_hash: assets::hash(&skill_bytes()),
        instructions,
        block,
        created_instructions,
    });
    Ok((guidance, registration))
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
struct Registration {
    settings: PathBuf,
    entries: BTreeMap<String, Value>,
    #[serde(default)]
    created_file: bool,
    #[serde(default)]
    created_hook_map: bool,
    #[serde(default)]
    created_event_keys: Vec<String>,
    // Persisted 2.3 project receipts contain this null field; project hooks never own an external skill.
    #[serde(default)]
    skill: Option<Value>,
}
fn skill_bytes() -> Vec<u8> {
    include_str!("../assets/SKILL.md")
        .replace("{{version}}", VERSION)
        .into_bytes()
}
fn conflict(message: &str) -> Diagnostic {
    Diagnostic::new(
        Code::OwnershipConflict,
        "setup",
        message,
        "Preserve existing content and explicitly reconcile ownership before retrying.",
    )
}
fn conflict_at(host: &str, path: &Path, event: Option<&str>, message: &str) -> Diagnostic {
    let quote = |value: &str, limit| {
        let mut bounded: String = value.chars().take(limit).collect();
        if value.chars().count() > limit {
            bounded.push_str("...[truncated]");
        }
        serde_json::to_string(&bounded).expect("strings are JSON serializable")
    };
    let context = format!(
        "Host {host}, asset {}",
        quote(&path.to_string_lossy(), 4096)
    );
    let context = if let Some(event) = event {
        format!("{context}, event {}", quote(event, 64))
    } else {
        context
    };
    Diagnostic::new(
        Code::OwnershipConflict,
        "setup",
        &format!("{context}: {message}"),
        "Preserve user edits. Restore the exact recorded owned content before retrying; if stale, explicitly remove only this project's proven owned integration. Do not overwrite or adopt foreign content.",
    )
}
fn manifest(binary: &Path) -> BTreeMap<String, Value> {
    ["SessionStart", "PreToolUse", "PostToolUse", "Stop"].into_iter().map(|event| {
        let mut entry = json!({"matcher":if matches!(event,"PreToolUse"|"PostToolUse"){ TOOL_MATCHER }else{""},
            "hooks":[{"type":"command","command":binary,"args":["hook","--event",event],"timeout":5}]});
        if event == "PostToolUse" {
            entry["hooks"].as_array_mut().expect("hooks is an array").push(
                json!({"type":"command","command":binary,"args":["hook","--event",event,"--observe"],"async":true,"timeout":1830}));
        }
        (event.into(), entry)
    }).collect()
}
fn opencode_manifest(binary: &Path) -> Result<BTreeMap<String, Value>, Diagnostic> {
    let binary = binary
        .to_str()
        .ok_or_else(|| Diagnostic::input("Hook executable path must be UTF-8."))?;
    if binary.contains(['\n', '\r', '\0']) {
        return Err(Diagnostic::input(
            "Hook executable path contains an unsupported control character.",
        ));
    }
    // The custom host expands these placeholders before applying shell quoting.
    if ["${CLAUDE_PLUGIN_ROOT}", "${CLAUDE_PLUGIN_DATA}"]
        .iter()
        .any(|token| binary.contains(token))
    {
        return Err(Diagnostic::input(
            "Hook executable path contains a reserved OpenCode plugin placeholder; use an installation path without host expansion tokens.",
        ));
    }
    // Explicit bash keeps the same literal quoting on POSIX and Git-for-Windows hosts.
    #[cfg(windows)]
    let binary = if let Some(unc) = binary.strip_prefix("\\\\?\\UNC\\") {
        format!("//{}", unc.replace('\\', "/"))
    } else {
        binary
            .strip_prefix("\\\\?\\")
            .unwrap_or(binary)
            .replace('\\', "/")
    };
    let quoted = format!("'{}'", binary.replace('\'', "'\\''"));
    Ok(["SessionStart", "PreToolUse", "PostToolUse", "Stop"].into_iter().map(|event| {
        (event.into(), json!({"matcher":if matches!(event,"PreToolUse"|"PostToolUse"){ TOOL_MATCHER }else{"*"},
            "hooks":[{"type":"command","shell":"bash","command":format!("{quoted} hook --event {event}"),"inputFormat":"claude-code","timeout":5}]}))
    }).collect())
}

/// Exact recorded groups are ownership; names alone do not permit adoption.
fn registration_change(
    host: &str,
    path: &Path,
    old: Option<&Registration>,
    new: Option<&BTreeMap<String, Value>>,
) -> Result<Change, Diagnostic> {
    let before = Snapshot::read(path)?;
    let mut settings = match &before.bytes {
        Some(bytes) => input::json(bytes, 1_048_576, 32)?,
        None => json!({}),
    };
    let top_level = host == "opencode";
    let map = settings
        .as_object_mut()
        .ok_or_else(|| conflict_at(host, path, None, "Host settings must be a JSON object."))?;
    if let Some(old) = old {
        if old.settings != path {
            return Err(conflict_at(
                host,
                &old.settings,
                None,
                "Registration targets another settings path.",
            ));
        }
        let hooks = if top_level {
            &mut *map
        } else {
            map.get_mut("hooks")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| {
                    conflict_at(
                        host,
                        path,
                        None,
                        "Recorded host hooks were removed or changed.",
                    )
                })?
        };
        for (event, entry) in &old.entries {
            let array = hooks
                .get_mut(event)
                .and_then(Value::as_array_mut)
                .ok_or_else(|| {
                    conflict_at(
                        host,
                        path,
                        Some(event),
                        "Recorded host event is missing or is not an array.",
                    )
                })?;
            let positions: Vec<_> = array
                .iter()
                .enumerate()
                .filter(|(_, v)| *v == entry)
                .map(|(i, _)| i)
                .collect();
            if positions.len() != 1 {
                return Err(conflict_at(
                    host,
                    path,
                    Some(event),
                    if positions.is_empty() {
                        "Owned host registration was edited or removed."
                    } else {
                        "Owned host registration is duplicated."
                    },
                ));
            }
            if let Some(replacement) = new.and_then(|entries| entries.get(event)) {
                array[positions[0]] = replacement.clone();
            } else {
                array.remove(positions[0]);
            }
            if array.is_empty() && old.created_event_keys.contains(event) {
                hooks.remove(event);
            }
        }
        if !top_level && hooks.is_empty() && old.created_hook_map {
            map.remove("hooks");
        }
    }
    if let Some(new) = new {
        let hooks = if top_level {
            &mut *map
        } else {
            map.entry("hooks")
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or_else(|| conflict_at(host, path, None, "Host hooks is not an object."))?
        };
        for (event, entry) in new {
            if old.is_some_and(|old| old.entries.contains_key(event)) {
                continue;
            }
            let array = hooks
                .entry(event)
                .or_insert_with(|| json!([]))
                .as_array_mut()
                .ok_or_else(|| {
                    conflict_at(host, path, Some(event), "Host hook event is not an array.")
                })?;
            if array.contains(entry) {
                return Err(conflict_at(
                    host,
                    path,
                    Some(event),
                    "An identical unowned host hook already exists; reconcile it explicitly.",
                ));
            }
            array.push(entry.clone());
        }
    }
    if new.is_none()
        && old.is_some_and(|old| old.created_file)
        && settings.as_object().is_some_and(|o| o.is_empty())
    {
        return Ok(Change {
            path: path.into(),
            permissions: before.permissions.clone(),
            before,
            after: None,
        });
    }
    let after = if before
        .bytes
        .as_ref()
        .is_some_and(|bytes| input::json(bytes, 1_048_576, 32).ok().as_ref() == Some(&settings))
    {
        before.bytes.clone().unwrap()
    } else {
        [
            serde_json::to_vec_pretty(&settings)
                .map_err(|_| Diagnostic::input("Host settings cannot be represented."))?,
            b"\n".to_vec(),
        ]
        .concat()
    };
    Ok(Change {
        path: path.into(),
        permissions: before.permissions.clone(),
        before,
        after: Some(after),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn host_prompt_refresh_is_canonical_and_preserves_foreign_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let path = root.join("AGENTS.md");
        let foreign = b"User CRLF\r\nUser LF\n";
        std::fs::write(&path, foreign).unwrap();
        let (first, registration) = instruction_change("codex", &root, None, false).unwrap();
        let registration = registration.unwrap();
        assert!(!registration.block.contains('\r'));
        let first = first.after.unwrap();
        assert!(first.starts_with(foreign));
        std::fs::write(&path, &first).unwrap();
        let (refreshed, _) =
            instruction_change("codex", &root, Some(&registration), false).unwrap();
        assert_eq!(refreshed.after.unwrap(), first);
        let edited = String::from_utf8(first)
            .unwrap()
            .replace("permanently project-only", "User edit");
        std::fs::write(&path, edited).unwrap();
        assert_eq!(
            instruction_change("codex", &root, Some(&registration), false)
                .err()
                .unwrap()
                .code,
            Code::OwnershipConflict,
        );
    }

    #[test]
    fn conflict_context_is_bounded_and_escaped() {
        let diagnostic = conflict_at(
            "codex",
            Path::new(&format!("/local/\n{}", "p".repeat(5000))),
            Some(&format!("\n{}", "e".repeat(100))),
            "Missing asset.",
        );
        assert_eq!(diagnostic.code, Code::OwnershipConflict);
        assert_eq!(diagnostic.exit(), 3);
        assert!(diagnostic.message.contains("\\n"));
        assert!(!diagnostic.message.contains('\n'));
        assert_eq!(diagnostic.message.matches("...[truncated]").count(), 2);
        assert!(diagnostic.message.len() < 4300);
    }
}
