//! Native host framing. Errors are informational and never become permission grants.
use crate::{
    assets::Snapshot,
    input,
    process::{Limits, Process},
    project::{self, Provider},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::AsyncReadExt;
const INPUT_LIMIT: usize = 1_048_576;
#[derive(Default)]
pub struct Output {
    pub json: Option<Value>,
    pub diagnostic: Option<String>,
}
#[derive(Deserialize)]
struct Marker {
    version: u32,
    remote: Option<String>,
    provider: Option<Provider>,
    #[serde(default)]
    language: String,
}
fn info(message: &str) -> Output {
    Output {
        json: Some(json!({"systemMessage":message})),
        diagnostic: None,
    }
}
pub async fn stdin(event: &str, state_root: Option<&Path>) -> Output {
    let read = async {
        let mut bytes = vec![];
        tokio::io::stdin()
            .take((INPUT_LIMIT + 1) as u64)
            .read_to_end(&mut bytes)
            .await
            .map(|_| bytes)
    };
    match tokio::time::timeout(Duration::from_secs(2), read).await {
        Ok(Ok(bytes)) => tokio::time::timeout(
            Duration::from_millis(2500),
            handle(event, &bytes, state_root),
        )
        .await
        .unwrap_or_else(|_| info("SpecGit context deadline expired; use explicit diagnostics.")),
        _ => info(
            "SpecGit could not read bounded hook input; ordinary tool execution remains unchanged.",
        ),
    }
}
fn relevant(payload: &Value) -> bool {
    let tool = payload
        .get("tool_name")
        .and_then(Value::as_str)
        .unwrap_or("");
    if ["Write", "Edit", "MultiEdit", "apply_patch"].contains(&tool) {
        return true;
    }
    if !["Bash", "PowerShell"].contains(&tool) {
        return false;
    }
    let command = payload
        .pointer("/tool_input/command")
        .and_then(Value::as_str)
        .unwrap_or("");
    let tokens: Vec<_> = command.split_whitespace().collect();
    if tokens.iter().any(|s| s.contains("specgit")) {
        return false;
    }
    tokens.windows(2).any(|pair| {
        ["git", "git.exe", "gh", "glab"].contains(&pair[0])
            && [
                "push", "commit", "checkout", "switch", "merge", "rebase", "reset", "add",
                "restore", "pr", "mr",
            ]
            .contains(&pair[1])
    })
}
pub async fn handle(event: &str, bytes: &[u8], _state_root: Option<&Path>) -> Output {
    if !["SessionStart", "PreToolUse", "PostToolUse", "Stop"].contains(&event) {
        return info("SpecGit does not support this hook event version.");
    }
    let payload = match input::json(bytes, INPUT_LIMIT, 32) {
        Ok(v) => v,
        Err(_) => return info("SpecGit received invalid or oversized hook input."),
    };
    if payload.get("hook_event_name").and_then(Value::as_str) != Some(event) {
        return info("SpecGit hook event identity does not match the registered event.");
    }
    if payload
        .get("schema_version")
        .is_some_and(|v| v.as_u64() != Some(1))
    {
        return info("SpecGit does not support this hook input schema version.");
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
        _ => return info("SpecGit hook session identity is missing or invalid."),
    };
    if event == "Stop" && payload.get("stop_hook_active").and_then(Value::as_bool) == Some(true) {
        return Output::default();
    }
    if matches!(event, "PreToolUse" | "PostToolUse") && !relevant(&payload) {
        return Output::default();
    }
    let cwd = match payload
        .get("cwd")
        .and_then(Value::as_str)
        .map(PathBuf::from)
    {
        Some(p) if p.is_absolute() => p,
        _ => return info("SpecGit hook cwd is missing or invalid."),
    };
    let process = Process {
        limits: Limits {
            timeout: Duration::from_secs(2),
            output_bytes: 262_144,
            ..Limits::default()
        },
        ..Process::default()
    };
    let root = match project::git(&process, &cwd, &["rev-parse", "--show-toplevel"]).await {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(s) => PathBuf::from(s.trim_end_matches(['\r', '\n'])),
            Err(_) => return Output::default(),
        },
        Err(_) => return Output::default(),
    };
    let snapshot = match Snapshot::read(&root.join(".specgit.yaml")) {
        Ok(s) => s,
        Err(_) => return info("SpecGit project context is unavailable; run doctor explicitly."),
    };
    let bytes = match snapshot.bytes {
        Some(b) if b.len() <= INPUT_LIMIT => b,
        None => return Output::default(),
        _ => return info("SpecGit project declaration exceeds its read allowance."),
    };
    let marker: Marker = match serde_yaml_ng::from_slice(&bytes) {
        Ok(m) => m,
        Err(_) => {
            return info("SpecGit project declaration is malformed; use explicit diagnostics.");
        }
    };
    if marker.version != 2 {
        return Output::default();
    }
    let context = match project::resolve(
        &process,
        &root,
        marker.remote.as_deref(),
        marker.provider,
        None,
    )
    .await
    {
        Ok(c) => c,
        Err(_) => {
            return info("SpecGit local identity is unavailable; remote state remains unknown.");
        }
    };
    let branch = context.branch.as_deref().unwrap_or("detached");
    let context_id = crate::assets::hash(
        format!(
            "{session}\0{:?}\0{}\0{event}\0{}",
            context.root, context.head, context.dirty
        )
        .as_bytes(),
    );
    let context_id = &context_id[..16];
    let text = if marker.language == "zh" {
        format!(
            "SpecGit 2 [{context_id}]：当前分支 {branch}，本地{}。远端状态尚未检查；开始受跟踪的修改前先选择原生 issue，完成以原生合并和 issue 状态为准。",
            if context.dirty { "有改动" } else { "干净" }
        )
    } else {
        format!(
            "SpecGit 2 [{context_id}]: branch {branch}; local tree {}. Remote state is not checked. Select native issues before tracked edits; completion requires observed native merge and issue states.",
            if context.dirty {
                "has changes"
            } else {
                "is clean"
            }
        )
    };
    if event == "Stop" {
        // additionalContext on Stop requests another model turn. An informational
        // systemMessage is an honest one-shot handoff, without a blocking loop.
        if context.dirty {
            info(&text)
        } else {
            Output::default()
        }
    } else {
        Output {
            json: Some(
                json!({"hookSpecificOutput":{"hookEventName":event,"additionalContext":text}}),
            ),
            diagnostic: None,
        }
    }
}
