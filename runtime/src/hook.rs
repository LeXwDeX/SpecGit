//! Host framing and local checkpoint enforcement. Classification is best effort.
mod classification;
mod context;
mod observation;

use crate::{declaration::Language, process::Process};
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
fn info(message: &str) -> Output {
    Output {
        json: Some(json!({"systemMessage":message})),
        diagnostic: None,
    }
}
pub async fn stdin(event: &str, observe: bool) -> Output {
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
            let task = observe_handle(event, &bytes, process);
            tokio::pin!(task);
            tokio::select! {
                output = &mut task => output,
                _ = termination() => { cancel.cancel(); task.await }
            }
        }
        Ok(Ok(bytes)) => tokio::time::timeout(Duration::from_millis(2500), handle(event, &bytes))
            .await
            .unwrap_or_else(|_| {
                info("SpecGit context deadline expired; use explicit diagnostics.")
            }),
        _ => info(
            "SpecGit could not read bounded hook input; ordinary tool execution remains unchanged.",
        ),
    }
}
fn deny(message: &str) -> Output {
    Output {
        json: Some(json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": message
            }
        })),
        diagnostic: None,
    }
}
pub async fn handle(event: &str, bytes: &[u8]) -> Output {
    let Prepared {
        context,
        language,
        session,
        target,
        observation,
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
    let selection = crate::selection::read(&context);
    let checkpoint_valid = selection.as_ref().is_ok_and(|selected| {
        selected
            .as_ref()
            .is_some_and(|selected| selected.checkpoint_valid(target.as_deref()))
    });
    if event == "PreToolUse" && !checkpoint_valid {
        let reason = if language == Language::Zh {
            "SpecGit 已阻止本次受跟踪修改：当前项目和分支没有有效的 Issue checkpoint。先运行 specgit issue --inspect 查重，再选择或创建包含 Why、Scope、Approach、Acceptance 的 Issue。"
        } else {
            "SpecGit blocked this tracked edit because this project and branch have no valid Issue checkpoint. Run specgit issue --inspect first, then select or create Issues with Why, Scope, Approach, and Acceptance."
        };
        return deny(reason);
    }
    let mut text = if language == Language::Zh {
        format!(
            "SpecGit 2 [{context_id}]：当前分支 {branch}，本地{}。远端状态尚未检查；开始受跟踪的修改前先选择原生 issue，完成须确认目标分支已合并、全部选定 issue 已关闭。",
            if context.dirty { "有改动" } else { "干净" }
        )
    } else {
        format!(
            "SpecGit 2 [{context_id}]: branch {branch}; local tree {}. Remote state is not checked. Select native issues before tracked edits; completion requires the intended target merge and every selected issue closed.",
            if context.dirty {
                "has changes"
            } else {
                "is clean"
            }
        )
    };
    if ["SessionStart", "PostToolUse"].contains(&event) {
        match pending_notice(&context, &session, &observation.notify) {
            Ok(Some(notice)) => { text.push('\n'); text.push_str(&notice); },
            Ok(None) => {},
            Err(_) => text.push_str("\nSpecGit has unreadable local observation state; inspect it with explicit diagnostics."),
        }
    }
    if event == "Stop" {
        if context.dirty && !checkpoint_valid {
            Output {
                json: Some(json!({
                    "decision": "block",
                    "reason": if language == Language::Zh {
                        "工作区已有未关联有效 Issue checkpoint 的修改。检查并登记规格，或明确说明这些修改为何不属于本次交付；不要宣称交付完成。"
                    } else {
                        "The worktree has changes without a valid Issue checkpoint. Inspect and record the specification, or explain why the changes are outside this delivery; do not claim completion."
                    }
                })),
                diagnostic: None,
            }
        } else if context.dirty {
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
