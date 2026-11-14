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
pub mod catalog;
pub mod permissions;
pub mod project;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Project,
}

pub use crate::project_receipt::{Agent, HookPurpose};
use crate::project_receipt::{HostRegistration, Registration};

/// Additive hook selection. Empty purposes preserve the recorded installation.
#[derive(Clone, Default)]
pub struct HookOptions {
    pub purposes: Vec<HookPurpose>,
    pub opencode_async_rewake: bool,
}

/// Purposes that can be independently removed without removing project guidance.
#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
pub enum RemovableHookPurpose {
    Guard,
    Context,
}
impl From<RemovableHookPurpose> for HookPurpose {
    fn from(value: RemovableHookPurpose) -> Self {
        match value {
            RemovableHookPurpose::Guard => Self::Guard,
            RemovableHookPurpose::Context => Self::Context,
        }
    }
}

fn purpose_manifest(
    binary: &Path,
    agent: Agent,
    purposes: &std::collections::BTreeSet<HookPurpose>,
    wake: bool,
) -> Result<BTreeMap<String, Value>, Diagnostic> {
    let _ = wake;
    if !purposes.contains(&HookPurpose::Context) {
        return Ok(BTreeMap::new());
    }
    if agent == Agent::Opencode {
        opencode_manifest(binary)
    } else {
        manifest(binary, agent)
    }
}

fn recorded_purposes(
    registration: Option<&Registration>,
) -> (std::collections::BTreeSet<HookPurpose>, bool) {
    let mut purposes = std::collections::BTreeSet::new();
    let mut wake = false;
    if let Some(registration) = registration {
        for (event, entry) in &registration.entries {
            for hook in entry["hooks"].as_array().into_iter().flatten() {
                let observe = hook["args"]
                    .as_array()
                    .is_some_and(|args| args.iter().any(|a| a == "--observe"))
                    || hook["command"]
                        .as_str()
                        .is_some_and(|c| c.ends_with(" --observe"));
                if observe {
                    purposes.insert(HookPurpose::Observe);
                    wake |= event == "Stop" && hook["asyncRewake"] == true && hook["async"] == true;
                } else if matches!(event.as_str(), "PreToolUse" | "Stop") {
                    purposes.insert(HookPurpose::Guard);
                } else if matches!(event.as_str(), "SessionStart" | "PostToolUse") {
                    purposes.insert(HookPurpose::Context);
                }
            }
        }
    }
    (purposes, wake)
}

const HOST_START: &str = "<!-- specgit:project:v2:start -->";
const HOST_END: &str = "<!-- specgit:project:v2:end -->";
const LEGACY_START: &str = "<!-- specgit:global:v2:start -->";
const LEGACY_END: &str = "<!-- specgit:global:v2:end -->";
const TOOL_MATCHER: &str = "*";

fn instruction_change(
    host: &str,
    root: &Path,
    old: Option<&HostRegistration>,
    uninstall: bool,
    refresh_proven: bool,
) -> Result<(Change, Option<HostRegistration>), Diagnostic> {
    instruction_change_after(host, root, old, uninstall, refresh_proven, None)
}

fn instruction_target(
    host: &str,
    root: &Path,
    old: Option<&HostRegistration>,
) -> Result<String, Diagnostic> {
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
    Ok(instructions)
}

fn instruction_change_after(
    host: &str,
    root: &Path,
    old: Option<&HostRegistration>,
    uninstall: bool,
    refresh_proven: bool,
    planned: Option<&Change>,
) -> Result<(Change, Option<HostRegistration>), Diagnostic> {
    let instructions = instruction_target(host, root, old)?;
    let mut guidance = Change::new(root.join(&instructions), None)?;
    let before = std::str::from_utf8(
        planned
            .filter(|change| change.path == guidance.path)
            .map(|c| c.after.as_deref().unwrap_or_default())
            .unwrap_or_else(|| guidance.before.bytes.as_deref().unwrap_or_default()),
    )
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
    let canonical = format!("{HOST_START}\n## SpecGit 2\n\n{entry}\n{HOST_END}");
    let newline = if before.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let generated = canonical.replace('\n', newline);
    let (after, block) = if let Some(old) = old {
        // 2.3 used a global-labelled marker even in proven project receipts.
        let (start, end, other_start, other_end) = if old.block.contains(HOST_START) {
            (HOST_START, HOST_END, LEGACY_START, LEGACY_END)
        } else {
            (LEGACY_START, LEGACY_END, HOST_START, HOST_END)
        };
        if before.matches(start).count() != 1
            || before.matches(end).count() != 1
            || old.block.matches(start).count() != 1
            || old.block.matches(end).count() != 1
            || before.contains(other_start)
            || before.contains(other_end)
            || (before.matches(&old.block).count() != 1 && (uninstall || !refresh_proven))
        {
            return Err(conflict_at(
                host,
                &guidance.path,
                None,
                "The managed host instruction block was edited or removed.",
            ));
        }
        let start_at = before.find(start).expect("unique start checked");
        let end_at = before.find(end).expect("unique end checked") + end.len();
        let old_start = old
            .block
            .find(start)
            .expect("unique recorded start checked");
        let old_end = old.block.find(end).expect("unique recorded end checked") + end.len();
        if start_at >= end_at || old_start >= old_end {
            return Err(conflict_at(
                host,
                &guidance.path,
                None,
                "The managed host instruction markers are damaged.",
            ));
        }
        if before.matches(&old.block).count() == 1 {
            let block = if old.block.replace("\r\n", "\n").trim() == canonical {
                old.block.replace("\r\n", "\n").replace('\n', newline)
            } else {
                format!(
                    "{}{generated}{}",
                    if old.block.replace("\r\n", "\n").starts_with("\n\n") {
                        if newline == "\r\n" {
                            "\r\n\r\n"
                        } else {
                            "\n\n"
                        }
                    } else {
                        ""
                    },
                    if old.block.ends_with('\n') {
                        newline
                    } else {
                        ""
                    }
                )
            };
            (
                before.replacen(&old.block, if uninstall { "" } else { &block }, 1),
                block,
            )
        } else {
            // Only the region between the unique markers is owned; surrounding
            // manual bytes remain exactly as they were.
            (
                format!("{}{}{}", &before[..start_at], generated, &before[end_at..]),
                generated,
            )
        }
    } else {
        if before.matches(HOST_START).count() == 1
            && before.matches(HOST_END).count() == 1
            && !before.contains(LEGACY_START)
            && !before.contains(LEGACY_END)
        {
            let start_at = before.find(HOST_START).expect("unique start checked");
            let end_at = before.find(HOST_END).expect("unique end checked") + HOST_END.len();
            if start_at >= end_at {
                return Err(conflict_at(
                    host,
                    &guidance.path,
                    None,
                    "An unowned SpecGit instruction marker already exists.",
                ));
            }
            let raw_block = &before[start_at..end_at];
            if raw_block.replace("\r\n", "\n") == canonical {
                (before.to_owned(), raw_block.to_owned())
            } else {
                return Err(conflict_at(
                    host,
                    &guidance.path,
                    None,
                    "An unowned SpecGit instruction marker already exists.",
                ));
            }
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
                "{}{generated}{newline}",
                if before.is_empty() {
                    ""
                } else if newline == "\r\n" {
                    "\r\n\r\n"
                } else {
                    "\n\n"
                }
            );
            (format!("{before}{block}"), block)
        }
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

fn skill_bytes() -> Vec<u8> {
    crate::skill::bytes()
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
fn manifest(binary: &Path, agent: Agent) -> Result<BTreeMap<String, Value>, Diagnostic> {
    manifest_for(binary, agent, &CURRENT_EVENTS)
}

/// Host callbacks written by this release.
const CURRENT_EVENTS: [&str; 2] = ["SessionStart", "PreToolUse"];
/// Callbacks written through 2.12. Used only to recognize exact receiptless
/// registrations; recognition grants no ownership and nothing new is written.
const LEGACY_EVENTS: [&str; 4] = ["SessionStart", "PreToolUse", "PostToolUse", "Stop"];

fn legacy_manifest(binary: &Path, agent: Agent) -> Result<BTreeMap<String, Value>, Diagnostic> {
    manifest_for(binary, agent, &LEGACY_EVENTS)
}

fn manifest_for(
    binary: &Path,
    agent: Agent,
    events: &[&str],
) -> Result<BTreeMap<String, Value>, Diagnostic> {
    // Claude accepts executable + argv. Codex runs only command through its shell.
    let codex = (agent == Agent::Codex)
        .then(|| codex_executable(binary))
        .transpose()?;
    let handler = |event: &str, observe: bool| {
        let mut args = vec!["hook", "--event", event];
        if observe {
            args.push("--observe");
        }
        let mut hook = if let Some(quoted) = &codex {
            json!({"type":"command","command":format!("{quoted} {}", args.join(" "))})
        } else {
            json!({"type":"command","command":binary,"args":args})
        };
        hook["timeout"] = json!(if observe { 1830 } else { 5 });
        if observe {
            hook["async"] = json!(true);
        }
        hook
    };
    Ok(events
        .iter()
        .map(|&event| {
            let mut hooks = vec![handler(event, false)];
            if event == "PostToolUse" {
                hooks.push(handler(event, true));
            }
            (
                event.into(),
                json!({"matcher":if matches!(event, "PreToolUse" | "PostToolUse"){ TOOL_MATCHER }else{""},"hooks":hooks}),
            )
        })
        .collect())
}

fn codex_executable(binary: &Path) -> Result<String, Diagnostic> {
    let binary = binary
        .to_str()
        .ok_or_else(|| Diagnostic::input("Codex hook executable path must be UTF-8."))?;
    if binary.chars().any(char::is_control) {
        return Err(Diagnostic::input(
            "Codex hook executable path contains an unsupported control character.",
        ));
    }
    #[cfg(windows)]
    {
        codex_windows_executable(binary)
    }
    #[cfg(not(windows))]
    {
        Ok(format!("'{}'", binary.replace('\'', "'\\''")))
    }
}

#[cfg(any(windows, test))]
fn codex_windows_executable(binary: &str) -> Result<String, Diagnostic> {
    // cmd expands %variables% even inside quotes, and !variables! when delayed
    // expansion is enabled. Reject these paths instead of executing another CLI.
    if binary.contains(['%', '!', '"']) || binary.chars().any(char::is_control) {
        return Err(Diagnostic::input(
            "Codex cmd hooks cannot safely use executable paths containing %, !, quotes or control characters; use a shared installation path without them.",
        ));
    }
    let binary = if let Some(unc) = binary.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{unc}")
    } else {
        binary.strip_prefix("\\\\?\\").unwrap_or(binary).to_owned()
    };
    Ok(format!("\"{binary}\""))
}
fn opencode_manifest(binary: &Path) -> Result<BTreeMap<String, Value>, Diagnostic> {
    opencode_manifest_for(binary, &CURRENT_EVENTS)
}

fn legacy_opencode_manifest(binary: &Path) -> Result<BTreeMap<String, Value>, Diagnostic> {
    opencode_manifest_for(binary, &LEGACY_EVENTS)
}

fn opencode_manifest_for(
    binary: &Path,
    events: &[&str],
) -> Result<BTreeMap<String, Value>, Diagnostic> {
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
    Ok(events.iter().map(|&event| {
        (event.into(), json!({"matcher":if matches!(event, "PreToolUse" | "PostToolUse"){ TOOL_MATCHER }else{"*"},
            "hooks":[{"type":"command","shell":"bash","command":format!("{quoted} hook --event {event}"),"inputFormat":"claude-code","timeout":5}]}))
    }).collect())
}

struct HostSettingsChange {
    change: Change,
    hooks: Option<Registration>,
    permissions: Option<crate::project_receipt::ReadonlyPermissionRegistration>,
    preexisting: std::collections::BTreeSet<String>,
}

/// Exact recorded groups are ownership; names alone do not permit adoption.
///
/// Hooks and read-only permissions share one settings document, so they are
/// applied to the same value and serialized once. A shared path therefore
/// yields exactly one `Change`, which the asset store requires.
fn host_settings_change(
    host: &str,
    path: &Path,
    old_hooks: Option<&Registration>,
    new_hooks: Option<&BTreeMap<String, Value>>,
    recover_missing: &std::collections::BTreeSet<String>,
    old_permissions: Option<&crate::project_receipt::ReadonlyPermissionRegistration>,
    desired_permissions: Option<&std::collections::BTreeSet<String>>,
) -> Result<HostSettingsChange, Diagnostic> {
    let before = Snapshot::read(path)?;
    if before.bytes.is_none() && (old_hooks.is_some() || old_permissions.is_some()) {
        // A recorded settings file may have contained user fields. Recreating
        // only managed content would silently discard that ownership evidence.
        return Err(conflict_at(
            host,
            path,
            None,
            "Recorded host settings were removed and cannot be reconstructed.",
        ));
    }
    let original = match &before.bytes {
        Some(bytes) => Some(input::json(bytes, 1_048_576, 32)?),
        None => None,
    };
    let mut settings = original.clone().unwrap_or_else(|| json!({}));
    let top_level = host == "opencode";
    // A settings file is one path-level fact. Both managed sections agree on
    // whether this tool created it so a later removal can delete it safely.
    let created_file = match (old_hooks, old_permissions) {
        (None, None) => before.bytes.is_none(),
        _ => {
            old_hooks.is_some_and(|old| old.created_file)
                || old_permissions.is_some_and(|old| old.created_file)
        }
    };
    let mut permissions_registration = None;
    let mut observed_preexisting = std::collections::BTreeSet::new();
    {
        let map = settings
            .as_object_mut()
            .ok_or_else(|| conflict_at(host, path, None, "Host settings must be a JSON object."))?;
        if let Some(old) = old_hooks {
            if old.settings != path {
                return Err(conflict_at(
                    host,
                    &old.settings,
                    None,
                    "Registration targets another settings path.",
                ));
            }
            if !top_level
                && map.get("hooks").is_none()
                && old.created_hook_map
                && old
                    .entries
                    .keys()
                    .all(|event| recover_missing.contains(event))
            {
                // Only a map created by this receipt may be reconstructed. Every
                // recorded event must also be individually proven absent.
                map.insert("hooks".into(), json!({}));
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
                if recover_missing.contains(event) {
                    if !old.created_event_keys.contains(event) || hooks.contains_key(event) {
                        return Err(conflict_at(
                            host,
                            path,
                            Some(event),
                            "Missing hook entry cannot be safely recovered.",
                        ));
                    }
                    continue;
                }
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
                if let Some(replacement) = new_hooks.and_then(|entries| entries.get(event)) {
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
        if let Some(new) = new_hooks {
            let hooks = if top_level {
                &mut *map
            } else {
                map.entry("hooks")
                    .or_insert_with(|| json!({}))
                    .as_object_mut()
                    .ok_or_else(|| conflict_at(host, path, None, "Host hooks is not an object."))?
            };
            for (event, entry) in new {
                if old_hooks.is_some_and(|old| old.entries.contains_key(event))
                    && !recover_missing.contains(event)
                {
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
        if host == "claude" && (old_permissions.is_some() || desired_permissions.is_some()) {
            let permissions_absent = map.get("permissions").is_none();
            let allow_absent = map
                .get("permissions")
                .and_then(|permissions| permissions.get("allow"))
                .is_none();
            let created_permissions_object =
                old_permissions.map_or(permissions_absent, |old| old.created_permissions_object);
            let created_allow_array =
                old_permissions.map_or(allow_absent, |old| old.created_allow_array);
            let permissions = map
                .entry("permissions")
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .ok_or_else(|| {
                    conflict_at(host, path, None, "Host permissions must be a JSON object.")
                })?;
            if permissions
                .get("allow")
                .is_some_and(|allow| !allow.is_array())
            {
                return Err(conflict_at(
                    host,
                    path,
                    None,
                    "Host permissions.allow must be an array.",
                ));
            }
            // A deleted array is recoverable only when this tool created it and
            // every recorded rule was written by this tool.
            if allow_absent
                && old_permissions.is_some_and(|old| {
                    !(old.created_allow_array && old.rules.is_subset(&old.created_rules))
                })
            {
                return Err(conflict_at(
                    host,
                    path,
                    None,
                    "Recorded read-only permissions were removed or changed.",
                ));
            }
            let mut rules = old_permissions
                .map(|old| old.rules.clone())
                .unwrap_or_default();
            let mut preexisting = old_permissions
                .map(|old| old.preexisting.clone())
                .unwrap_or_default();
            let mut created_rules = old_permissions
                .map(|old| old.created_rules.clone())
                .unwrap_or_default();
            let allow = permissions
                .entry("allow")
                .or_insert_with(|| json!([]))
                .as_array_mut()
                .ok_or_else(|| {
                    conflict_at(host, path, None, "Host permissions.allow must be an array.")
                })?;
            if allow.iter().any(|value| !value.is_string()) {
                return Err(conflict_at(
                    host,
                    path,
                    None,
                    "Host permissions.allow must contain only strings.",
                ));
            }
            if allow_absent {
                allow.extend(rules.iter().cloned().map(Value::String));
            }
            for rule in &rules {
                if allow
                    .iter()
                    .filter(|value| value.as_str() == Some(rule))
                    .count()
                    != 1
                {
                    return Err(conflict_at(
                        host,
                        path,
                        None,
                        "A recorded read-only permission rule was edited, removed or duplicated.",
                    ));
                }
            }
            let desired = desired_permissions.cloned().unwrap_or_default();
            for rule in &desired {
                if rules.contains(rule) || preexisting.contains(rule) {
                    continue;
                }
                if allow.iter().any(|value| value.as_str() == Some(rule)) {
                    // A matching rule that predates this receipt stays user-owned.
                    preexisting.insert(rule.clone());
                    continue;
                }
                allow.push(Value::String(rule.clone()));
                rules.insert(rule.clone());
                created_rules.insert(rule.clone());
            }
            let stale: Vec<_> = rules.difference(&desired).cloned().collect();
            for rule in stale {
                let position = allow
                    .iter()
                    .position(|value| value.as_str() == Some(&rule))
                    .expect("recorded rule is unique");
                allow.remove(position);
                rules.remove(&rule);
                created_rules.remove(&rule);
            }
            observed_preexisting = preexisting.clone();
            let allow_empty = allow.is_empty();
            if allow_empty && created_allow_array {
                permissions.remove("allow");
            }
            if permissions.is_empty() && created_permissions_object {
                map.remove("permissions");
            }
            if !rules.is_empty() {
                permissions_registration =
                    Some(crate::project_receipt::ReadonlyPermissionRegistration {
                        settings: path.into(),
                        rules,
                        preexisting,
                        created_file,
                        created_permissions_object,
                        created_allow_array,
                        created_rules,
                    });
            }
        }
    }
    let hooks_registration = new_hooks.and_then(|new| {
        if new.is_empty() {
            return None;
        }
        Some(match old_hooks {
            Some(old) => {
                let mut registration = old.clone();
                for event in new.keys() {
                    let before_hooks = if top_level {
                        original.as_ref()
                    } else {
                        original.as_ref().and_then(|document| document.get("hooks"))
                    };
                    if before_hooks.and_then(|hooks| hooks.get(event)).is_none()
                        && !registration.created_event_keys.contains(event)
                    {
                        registration.created_event_keys.push(event.clone());
                    }
                }
                registration.entries = new.clone();
                registration.created_file = created_file;
                registration
            }
            None => {
                let before_hooks = if top_level {
                    original.as_ref()
                } else {
                    original.as_ref().and_then(|document| document.get("hooks"))
                };
                Registration {
                    settings: path.into(),
                    entries: new.clone(),
                    created_file,
                    created_hook_map: !top_level
                        && original
                            .as_ref()
                            .and_then(|document| document.get("hooks"))
                            .is_none(),
                    created_event_keys: new
                        .keys()
                        .filter(|event| before_hooks.and_then(|hooks| hooks.get(*event)).is_none())
                        .cloned()
                        .collect(),
                    skill: None,
                }
            }
        })
    });
    if new_hooks.is_none()
        && permissions_registration.is_none()
        && (old_hooks.is_some() || old_permissions.is_some())
        && created_file
        && settings.as_object().is_some_and(|object| object.is_empty())
    {
        return Ok(HostSettingsChange {
            change: Change {
                path: path.into(),
                permissions: before.permissions.clone(),
                before,
                after: None,
            },
            hooks: None,
            permissions: None,
            preexisting: observed_preexisting,
        });
    }
    let after = if before.bytes.is_some() && original.as_ref() == Some(&settings) {
        before.bytes.clone().unwrap()
    } else {
        [
            serde_json::to_vec_pretty(&settings)
                .map_err(|_| Diagnostic::input("Host settings cannot be represented."))?,
            b"\n".to_vec(),
        ]
        .concat()
    };
    Ok(HostSettingsChange {
        change: Change {
            path: path.into(),
            permissions: before.permissions.clone(),
            before,
            after: Some(after),
        },
        hooks: hooks_registration,
        permissions: permissions_registration,
        preexisting: observed_preexisting,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn codex_cmd_paths_are_quoted_without_variable_expansion() {
        assert_eq!(
            codex_windows_executable(r"\\?\C:\Program Files\O'Brien & tools\specgit.exe").unwrap(),
            r#""C:\Program Files\O'Brien & tools\specgit.exe""#
        );
        assert_eq!(
            codex_windows_executable(r"\\?\UNC\server\share name\specgit.exe").unwrap(),
            r#""\\server\share name\specgit.exe""#
        );
        for path in [
            r"C:\%USERPROFILE%\specgit.exe",
            r"C:\!expanded!\specgit.exe",
            "C:\\broken\"path\\specgit.exe",
            "C:\\broken\npath\\specgit.exe",
        ] {
            assert!(codex_windows_executable(path).is_err(), "{path}");
        }
    }

    #[test]
    fn host_prompt_refresh_is_canonical_and_preserves_foreign_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let path = root.join("AGENTS.md");
        let foreign = b"User CRLF\r\nUser LF\n";
        std::fs::write(&path, foreign).unwrap();
        let (first, registration) = instruction_change("codex", &root, None, false, false).unwrap();
        let registration = registration.unwrap();
        assert!(registration.block.contains("\r\n"));
        let first = first.after.unwrap();
        assert!(first.starts_with(foreign));
        std::fs::write(&path, &first).unwrap();
        let (refreshed, _) =
            instruction_change("codex", &root, Some(&registration), false, false).unwrap();
        assert_eq!(refreshed.after.unwrap(), first);
        let original = String::from_utf8(first).unwrap();
        assert!(
            original.contains("specgit init"),
            "the fixture must target managed entry text"
        );
        let edited = original.replace("specgit init", "User edit");
        assert_ne!(
            edited, original,
            "the managed entry must actually be edited"
        );
        std::fs::write(&path, edited).unwrap();
        assert_eq!(
            instruction_change("codex", &root, Some(&registration), false, false)
                .err()
                .unwrap()
                .code,
            Code::OwnershipConflict,
        );
    }

    #[test]
    fn host_prompt_refresh_recognizes_a_legacy_lf_block_in_crlf_guidance() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let path = root.join("CLAUDE.md");
        let (change, old) = instruction_change("claude", &root, None, false, false).unwrap();
        let old = old.unwrap();
        let prefix = "# Manual\r\nkeep\r\n";
        std::fs::write(
            &path,
            [prefix.as_bytes(), change.after.as_ref().unwrap()].concat(),
        )
        .unwrap();
        let (change, next) = instruction_change("claude", &root, Some(&old), false, true).unwrap();
        let bytes = change.after.unwrap();
        assert!(
            !String::from_utf8(bytes.clone())
                .unwrap()
                .replace("\r\n", "")
                .contains('\n')
        );
        std::fs::write(&path, bytes).unwrap();
        let (removed, _) = instruction_change("claude", &root, next.as_ref(), true, false).unwrap();
        assert_eq!(removed.after.unwrap(), prefix.as_bytes());
    }

    #[test]
    fn host_prompt_ignores_a_planned_change_for_another_path() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let manual = b"override manual\r\n";
        std::fs::write(root.join("AGENTS.override.md"), manual).unwrap();
        let wrong = Change::new(
            root.join("AGENTS.md"),
            Some(b"wrong file contents".to_vec()),
        )
        .unwrap();
        let (change, registration) =
            instruction_change_after("codex", &root, None, false, false, Some(&wrong)).unwrap();
        assert_eq!(change.path, root.join("AGENTS.override.md"));
        let after = change.after.unwrap();
        assert!(after.starts_with(manual));
        assert!(
            !after
                .windows(b"wrong file contents".len())
                .any(|bytes| bytes == b"wrong file contents")
        );
        assert_eq!(registration.unwrap().instructions, "AGENTS.override.md");
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
