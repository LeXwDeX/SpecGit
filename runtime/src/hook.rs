//! Native host framing. Errors are informational and never become permission grants.
use crate::{
    config::{self, Language},
    diagnostic::Code,
    input,
    process::{Limits, Process},
    project,
};
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
fn info(message: &str) -> Output {
    Output {
        json: Some(json!({"systemMessage":message})),
        diagnostic: None,
    }
}
pub async fn stdin(event: &str, state_root: Option<&Path>, observe: bool) -> Output {
    let read = async {
        let mut bytes = vec![];
        tokio::io::stdin()
            .take((INPUT_LIMIT + 1) as u64)
            .read_to_end(&mut bytes)
            .await
            .map(|_| bytes)
    };
    match tokio::time::timeout(Duration::from_secs(2), read).await {
        Ok(Ok(bytes)) if observe => {
            let process = Process::default();
            let cancel = process.cancellation.clone();
            let task = observe_handle(event, &bytes, state_root, process);
            tokio::pin!(task);
            tokio::select! {
                output = &mut task => output,
                _ = termination() => { cancel.cancel(); task.await }
            }
        }
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
    if let Some(index) = tokens.iter().position(|token| {
        let executable = token
            .trim_matches(['\'', '"'])
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("");
        ["specgit", "specgit.exe", "specgit.js"].contains(&executable)
    }) {
        let mut remaining = &tokens[index + 1..];
        loop {
            let Some(option) = remaining.first().copied() else {
                return false;
            };
            if option == "--json" {
                remaining = &remaining[1..];
                continue;
            }
            let value = if option == "--cwd" {
                remaining = &remaining[1..];
                let Some(value) = remaining.first().copied() else {
                    return false;
                };
                value
            } else if let Some(value) = option.strip_prefix("--cwd=") {
                value
            } else {
                return ["issue", "pr", "merge"].contains(&option);
            };
            let quote = value.chars().next().filter(|c| ['\'', '"'].contains(c));
            let mut ends_here = quote.is_none_or(|q| value.len() > 1 && value.ends_with(q));
            remaining = &remaining[1..];
            while !ends_here {
                let Some(part) = remaining.first().copied() else {
                    return false;
                };
                ends_here = part.ends_with(quote.expect("an open quote exists"));
                remaining = &remaining[1..];
            }
        }
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
struct Prepared {
    context: project::Context,
    language: Language,
    session: String,
}
async fn prepare(event: &str, bytes: &[u8]) -> Result<Option<Prepared>, Output> {
    if !["SessionStart", "PreToolUse", "PostToolUse", "Stop"].contains(&event) {
        return Err(info("SpecGit does not support this hook event version."));
    }
    let payload = match input::json(bytes, INPUT_LIMIT, 32) {
        Ok(v) => v,
        Err(_) => return Err(info("SpecGit received invalid or oversized hook input.")),
    };
    if payload.get("hook_event_name").and_then(Value::as_str) != Some(event) {
        return Err(info(
            "SpecGit hook event identity does not match the registered event.",
        ));
    }
    if payload
        .get("schema_version")
        .is_some_and(|v| v.as_u64() != Some(1))
    {
        return Err(info(
            "SpecGit does not support this hook input schema version.",
        ));
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
        _ => return Err(info("SpecGit hook session identity is missing or invalid.")),
    };
    if event == "Stop" && payload.get("stop_hook_active").and_then(Value::as_bool) == Some(true) {
        return Ok(None);
    }
    if matches!(event, "PreToolUse" | "PostToolUse") && !relevant(&payload) {
        return Ok(None);
    }
    let cwd = match payload
        .get("cwd")
        .and_then(Value::as_str)
        .map(PathBuf::from)
    {
        Some(p) if p.is_absolute() => p,
        _ => return Err(info("SpecGit hook cwd is missing or invalid.")),
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
            Err(_) => return Ok(None),
        },
        Err(_) => return Ok(None),
    };
    let marker = match config::read(&root) {
        Ok(Some(d)) => d,
        Ok(None) => return Ok(None),
        Err(d) if d.code == Code::MigrationRequired => return Ok(None),
        Err(_) => {
            return Err(info(
                "SpecGit project declaration is invalid; use explicit diagnostics.",
            ));
        }
    };
    let context = match config::resolve(
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
            return Err(info(
                "SpecGit local identity is unavailable; remote state remains unknown.",
            ));
        }
    };
    Ok(Some(Prepared {
        context,
        language: marker.language,
        session: session.to_owned(),
    }))
}
pub async fn handle(event: &str, bytes: &[u8], state_root: Option<&Path>) -> Output {
    let Prepared {
        context,
        language,
        session,
    } = match prepare(event, bytes).await {
        Ok(Some(p)) => p,
        Ok(None) => return Output::default(),
        Err(output) => return output,
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
    let mut text = if language == Language::Zh {
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
    if ["SessionStart", "PostToolUse"].contains(&event) {
        match pending_notice(&context, &session, state_root) {
            Ok(Some(notice)) => { text.push('\n'); text.push_str(&notice); },
            Ok(None) => {},
            Err(_) => text.push_str("\nSpecGit has unreadable local observation state; inspect it with explicit diagnostics."),
        }
    }
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

fn pending_notice(
    context: &project::Context,
    session: &str,
    state_root: Option<&Path>,
) -> Result<Option<String>, crate::diagnostic::Diagnostic> {
    let Some(request) = crate::selection::read(context)?.and_then(|s| s.request) else {
        return Ok(None);
    };
    let identity = crate::watch_store::Identity::new(
        context,
        session,
        request,
        crate::watch_store::Goal::Lifecycle,
    )?;
    let Some(state) = crate::watch_store::read(&identity, state_root)? else {
        return Ok(None);
    };
    let ids: Vec<_> = state
        .events
        .iter()
        .filter(|e| !e.superseded && e.acknowledged_at.is_none())
        .map(|e| e.id.as_str())
        .collect();
    if ids.is_empty() {
        return Ok(None);
    }
    Ok(Some(format!(
        "SpecGit unverified event receipts: {}. Refresh with specgit inbox --request {request} --session {session} --goal lifecycle{} before using their status. Receipt acknowledgement is explicit; these IDs are not current acceptance evidence.",
        ids.join(", "),
        state_root
            .map(|_| " --state-root <registered-state-root>")
            .unwrap_or("")
    )))
}
pub async fn observe_handle(
    event: &str,
    bytes: &[u8],
    state_root: Option<&Path>,
    process: Process,
) -> Output {
    if event != "PostToolUse" {
        return info("SpecGit asynchronous observation requires PostToolUse.");
    }
    let prepared = match tokio::time::timeout(Duration::from_millis(2500), prepare(event, bytes))
        .await
    {
        Ok(Ok(Some(p))) => p,
        Ok(Ok(None)) => return Output::default(),
        Ok(Err(output)) => return output,
        Err(_) => return info("SpecGit observation context deadline expired; resume explicitly."),
    };
    let request = match crate::selection::read(&prepared.context) {
        Ok(Some(s)) => match s.request {
            Some(id) => id,
            None => return Output::default(),
        },
        Ok(None) => return Output::default(),
        Err(_) => {
            return info(
                "SpecGit cannot resolve the selected native request; use explicit diagnostics.",
            );
        }
    };
    let observation = crate::watch::observe_subscription(
        crate::watch::Options {
            request,
            session: prepared.session,
            goal: crate::watch_store::Goal::Lifecycle,
            state_root: state_root.map(Path::to_path_buf),
            timeout_seconds: 1800,
            poll_seconds: 15,
            once: false,
        },
        process,
        &prepared.context.root,
    )
    .await;
    let observation = match observation {
        Ok(value) => value,
        Err(d) if d.code == Code::LockBusy => return Output::default(),
        Err(_) => {
            return info(
                "SpecGit observation could not finish; inspect retained intent with specgit inbox.",
            );
        }
    };
    let events = observation.pending();
    if events.is_empty() {
        return Output::default();
    }
    let text = format!(
        "SpecGit observation offered (not acknowledged): {}. These are observations at validated_at; refresh native evidence before acting. Acknowledge each exact event ID only after receiving it. Notifications never grant authorization.",
        json!({"subscription":observation.state.identity,"events":events})
    );
    Output {
        json: Some(
            json!({"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":text}}),
        ),
        diagnostic: None,
    }
}
async fn termination() {
    #[cfg(unix)]
    {
        if let Ok(mut terminate) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}
