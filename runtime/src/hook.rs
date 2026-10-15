//! Bounded host context on SessionStart/PreToolUse; native Git owns enforcement.
mod context;
mod observation;

use crate::declaration::Language;
use context::{Prepared, prepare};
pub use observation::observe_handle;
use observation::pending_notice;
use serde_json::{Value, json};
use std::time::Duration;
use tokio::io::AsyncReadExt;
const INPUT_LIMIT: usize = 1_048_576;
#[derive(Default)]
pub struct Output {
    pub json: Option<Value>,
    pub diagnostic: Option<String>,
}
fn notice(diagnostic: impl std::fmt::Display) -> Output {
    Output {
        json: None,
        diagnostic: Some(format!("SpecGit hook: {diagnostic}")),
    }
}
fn allowed(event: &str) -> bool {
    matches!(event, "SessionStart" | "PreToolUse")
}
pub async fn stdin(event: &str, observe: bool) -> Output {
    if !allowed(event) {
        return Output::default();
    }
    if observe {
        return notice(
            "Automatic host observation is unsupported; use bounded specgit watch or inbox tools.",
        );
    }
    let read = async {
        let mut bytes = vec![];
        tokio::io::stdin()
            .take((INPUT_LIMIT + 1) as u64)
            .read_to_end(&mut bytes)
            .await
            .map(|_| bytes)
    };
    match tokio::time::timeout(Duration::from_secs(2), read).await {
        Ok(Ok(bytes)) => tokio::time::timeout(Duration::from_millis(2500), handle(event, &bytes))
            .await
            .unwrap_or_else(|_| notice("The hook context deadline expired; resume explicitly.")),
        _ => notice(
            "The hook could not read bounded input; ordinary tool execution remains unchanged.",
        ),
    }
}
pub async fn handle(event: &str, bytes: &[u8]) -> Output {
    if !allowed(event) {
        return Output::default();
    }
    let Prepared {
        context,
        language,
        session,
        observation,
        ..
    } = match prepare(event, bytes).await {
        Ok(Some(prepared)) => prepared,
        Ok(None) => return Output::default(),
        Err(output) => return output,
    };
    let selected = match crate::selection::classify(&context) {
        Ok(crate::selection::ReadOutcome::Current(selected)) => Some(selected),
        Ok(_) => None,
        Err(diagnostic) => return notice(diagnostic),
    };
    let rules = if event == "SessionStart" {
        let branch = context.branch.as_deref().unwrap_or("detached");
        let issues = selected
            .as_ref()
            .map(|s| s.issues.as_slice())
            .unwrap_or_default();
        if language == Language::Zh {
            format!(
                "读取项目 `.agents/skills/specgit-native/SKILL.md`。在当前任务持续授权内主动处理 Issue/Milestone，先自修复错误；TDD 与 PR 后 CI 强烈推荐，遵守平台必需检查。提交或推送前准备有效 Issue checkpoint。分支 {branch}；选定 Issue {issues:?}。"
            )
        } else {
            format!(
                "Read project `.agents/skills/specgit-native/SKILL.md`. Use standing task authorization to handle Issues/Milestones and repair errors proactively. TDD and post-PR CI are strongly recommended; respect platform-required checks. Prepare an Issue checkpoint before commit/push. Branch {branch}; selected Issues {issues:?}."
            )
        }
    } else {
        String::new()
    };
    let mut offers = vec![];
    if !rules.is_empty() {
        offers.push(("session-rules", rules.as_str()));
    }
    let recovery = selected.as_ref().and_then(write_recovery);
    if let Some(recovery) = &recovery {
        offers.push(("write-recovery", recovery.as_str()));
    }
    // Resolve every fallible context source before committing any offer digest.
    // A failed read must leave all context available to the next host callback.
    let pending = match pending_notice(&context, &session, &observation.notify) {
        Ok(pending) => pending,
        Err(diagnostic) => return notice(diagnostic),
    };
    if let Some(pending) = &pending {
        offers.push(("event-recovery", pending.as_str()));
    }
    let text = match context::offer_all(&context, &session, &offers) {
        Ok(text) => text,
        Err(diagnostic) => return notice(diagnostic),
    };
    if text.is_empty() {
        return Output::default();
    }
    Output {
        json: Some(json!({"hookSpecificOutput":{"hookEventName":event,"additionalContext":text}})),
        diagnostic: None,
    }
}

/// Recovery text for unresolved native writes. The short write identity keeps
/// each distinct uncertain write deliverable in the same host session.
fn write_recovery(selected: &crate::selection::Selection) -> Option<String> {
    let mut pending = selected
        .intents
        .iter()
        .filter(|i| i.write_started && i.issue.is_none())
        .map(|i| json!(["issue", i.title, i.body, i.labels]))
        .collect::<Vec<_>>();
    if selected.request_write_started && selected.request.is_none() {
        pending.push(json!(["request", selected.request_intent]));
    }
    if pending.is_empty() {
        return None;
    }
    let identity = crate::assets::hash(json!(pending).to_string().as_bytes());
    Some(format!(
        "SpecGit retains an uncertain native write ({}). Inspect native candidates and adopt the exact Issue/PR ID before retrying creation; preserve the checkpoint.",
        &identity[..12]
    ))
}
