//! Bounded input and the addressed project/branch context.
use super::{
    INPUT_LIMIT, Output,
    classification::{patch_tool, relevant},
    deny, notice,
};
use crate::{
    config::{self, Language},
    diagnostic::Code,
    input,
    process::{Limits, Process},
    project,
};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    time::Duration,
};

pub(super) struct Prepared {
    pub(super) context: project::Context,
    pub(super) language: Language,
    pub(super) session: String,
    pub(super) target: Option<String>,
    pub(super) observation: config::Observation,
}
fn requested_paths(payload: &Value, cwd: &Path) -> Vec<PathBuf> {
    let tool = payload
        .get("tool_name")
        .and_then(Value::as_str)
        .unwrap_or("");
    let input = payload.get("tool_input").unwrap_or(&Value::Null);
    let mut values = vec![];
    for key in ["file_path", "filePath", "path"] {
        if let Some(path) = input.get(key).and_then(Value::as_str) {
            values.push(path.to_owned());
        }
    }
    if patch_tool(tool) {
        let patch = input
            .get("patch")
            .or_else(|| input.get("patchText"))
            .or_else(|| input.get("command"))
            .and_then(Value::as_str)
            .unwrap_or("");
        for line in patch.lines() {
            for marker in [
                "*** Add File: ",
                "*** Update File: ",
                "*** Delete File: ",
                "*** Move to: ",
            ] {
                if let Some(path) = line.strip_prefix(marker) {
                    values.push(path.trim().to_owned());
                }
            }
        }
    }
    values
        .into_iter()
        .filter(|path| !path.is_empty() && path.len() <= 4096)
        .map(PathBuf::from)
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            }
        })
        .collect()
}
fn existing_anchor(path: &Path) -> Option<PathBuf> {
    let mut current = if path.is_dir() {
        path.to_owned()
    } else {
        path.parent()?.to_owned()
    };
    while !current.exists() {
        current = current.parent()?.to_owned();
    }
    Some(current)
}
async fn target_root(
    process: &Process,
    payload: &Value,
    cwd: &Path,
) -> Result<Option<project::GitState>, Output> {
    let paths = requested_paths(payload, cwd);
    let anchors = if paths.is_empty() {
        vec![cwd.to_owned()]
    } else {
        paths
            .iter()
            .filter_map(|path| existing_anchor(path))
            .collect()
    };
    let mut selected: Option<project::GitState> = None;
    let mut seen = BTreeSet::new();
    for anchor in anchors {
        if !seen.insert(anchor.clone()) {
            continue;
        }
        let state = match project::git_state(process, &anchor).await {
            Ok(state) => state,
            Err(_) => continue,
        };
        if selected
            .as_ref()
            .is_some_and(|existing| existing.root != state.root)
        {
            return Err(deny(
                "SpecGit cannot authorize one tool call that edits multiple repositories; split the edit by repository.",
            ));
        }
        selected.get_or_insert(state);
    }
    Ok(selected)
}
pub(super) async fn prepare(event: &str, bytes: &[u8]) -> Result<Option<Prepared>, Output> {
    if !["SessionStart", "PreToolUse", "PostToolUse", "Stop"].contains(&event) {
        return Err(notice("This hook event version is unsupported."));
    }
    let payload = match input::json(bytes, INPUT_LIMIT, 32) {
        Ok(v) => v,
        Err(d) => return Err(notice(&d)),
    };
    if payload.get("hook_event_name").and_then(Value::as_str) != Some(event) {
        return Err(notice(
            "The hook event identity does not match the registered event.",
        ));
    }
    if payload
        .get("schema_version")
        .is_some_and(|v| v.as_u64() != Some(1))
    {
        return Err(notice("This hook input schema version is unsupported."));
    }
    let session = match payload.get("session_id").and_then(Value::as_str) {
        Some(s)
            if !s.is_empty()
                && s.len() <= 128
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"-_".contains(&c)) =>
        {
            s
        }
        _ => return Err(notice("The hook session identity is missing or invalid.")),
    };
    if event == "Stop" && payload.get("stop_hook_active").and_then(Value::as_bool) == Some(true) {
        return Ok(None);
    }
    if matches!(event, "PreToolUse" | "PostToolUse") && !relevant(event, &payload) {
        return Ok(None);
    }
    let cwd = match payload
        .get("cwd")
        .and_then(Value::as_str)
        .map(PathBuf::from)
    {
        Some(p) if p.is_absolute() => p,
        _ => return Err(notice("The hook cwd is missing or invalid.")),
    };
    let process = Process {
        limits: Limits {
            timeout: Duration::from_secs(2),
            output_bytes: 262_144,
            ..Limits::default()
        },
        ..Process::default()
    };
    let Some(state) = target_root(&process, &payload, &cwd).await? else {
        return Ok(None);
    };
    let root = &state.root;
    let marker = match config::read(root) {
        Ok(Some(d)) => d,
        Ok(None) => {
            return match config::worktree::declaration_lost(&process, root).await {
                Ok(None) => Ok(None),
                Ok(Some(lost)) if event == "PreToolUse" => Err(deny(&lost.to_string())),
                Ok(Some(lost)) => Err(notice(&lost)),
                Err(d) => Err(notice(&d)),
            };
        }
        Err(d) if d.code == Code::MigrationRequired => return Ok(None),
        Err(d) => return Err(notice(&d)),
    };
    let context = match project::resolve_git_state(
        &process,
        state,
        marker.remote.as_deref(),
        marker.provider,
        None,
    )
    .await
    {
        Ok(mut c) => {
            // Keep config::resolve's repository-scoped API routing semantics
            // while reusing the Git probe that selected the actual edit target.
            match config::read_routing(&c) {
                Ok(Some(routing)) => c.repository.host = routing.api_host,
                Ok(None) => {}
                Err(d) => return Err(notice(&d)),
            }
            c
        }
        Err(d) => return Err(notice(&d)),
    };
    Ok(Some(Prepared {
        context,
        language: marker.language,
        session: session.to_owned(),
        target: marker.target,
        observation: marker.observation,
    }))
}
