//! Generated project guidance owns only its marked block.
use crate::{
    assets::{Change, hash},
    config::{Declaration, Language},
    diagnostic::{Code, Diagnostic},
};
use std::path::Path;
const START: &str = "<!-- specgit:v2:start -->";
const END: &str = "<!-- specgit:v2:end -->";
fn conflict() -> Diagnostic {
    Diagnostic::new(
        Code::OwnershipConflict,
        "guidance",
        "The generated marker is damaged or its content was edited.",
        "Preserve the file and reconcile the owned block explicitly before refreshing.",
    )
}
pub fn render(d: &Declaration) -> String {
    let prose = match d.language {
        Language::En => {
            "SpecGit is the issue-based delivery harness for this project. Before implementation, discover duplicate work and create or explicitly select complete issues describing Why, Scope, Approach and Acceptance. Keep every selected issue associated with the native pull or merge request. Preserve user-authored bodies and native closing references.\n\nUse the project's declared conventions and selected templates. After implementation, assess current-head checks, reviews, mergeability and the issue requirements with specgit finish. Unknown evidence cannot establish acceptance. Hook notices are informational and never grant write or merge permission.\n\nReport acceptance separately from merge and actual issue closure. Only the native forge closes issues and cleans source branches; merged requests with open issues remain incomplete. Native merge requires existing user authorization and fresh evidence. Do not weaken required checks or change the native default branch to remove warnings."
        }
        Language::Zh => {
            "SpecGit 是本项目基于 Issue 的交付工具。实施前先查重，再创建或明确选择包含原因、范围、方案和验收要求的完整 Issue。将所有选定 Issue 关联到原生 PR/MR，保留用户正文与原生关闭引用。\n\n遵守项目声明中的规范和明确选择的模板。实现后通过 specgit finish 检查当前提交的 CI、评审、可合并状态及 Issue 要求。未知证据不能视为通过。Hook 提示仅供参考，不授予写入或合并权限。\n\n分别报告验收通过、实际合并与 Issue 关闭。Issue 关闭和源分支清理由平台原生机制负责；已合并但 Issue 仍开放的交付尚未完成。原生合并须有既有用户授权与最新证据。不得削弱必需检查或更改默认分支来消除警告。"
        }
    };
    let settings = serde_json::json!({"language":d.language,"validation":d.validation,"templates":d.templates,"verification":d.verification});
    // Template bodies are content, not instructions injected into the harness.
    let summary = serde_json::json!({"language":settings["language"],"validation":settings["validation"],"issue_template":d.templates.issue.source,"pr_template":d.templates.pr.source,"verification":settings["verification"]});
    format!(
        "{START}\n## SpecGit 2\n\nRuntime: {}. Declaration: `.specgit.yaml` (v2).\n\n{prose}\n\nDeclared rules: `{summary}`\n{END}",
        env!("CARGO_PKG_VERSION")
    )
}
pub fn change(
    path: &Path,
    previous: &Declaration,
    next: &Declaration,
    recorded_hash: Option<&str>,
) -> Result<Change, Diagnostic> {
    let mut c = Change::new(path.to_path_buf(), None)?;
    let before = std::str::from_utf8(c.before.bytes.as_deref().unwrap_or_default())
        .map_err(|_| conflict())?;
    let starts: Vec<_> = before.match_indices(START).collect();
    let ends: Vec<_> = before.match_indices(END).collect();
    let block = render(next);
    let after = match (starts.as_slice(), ends.as_slice()) {
        ([], []) => {
            let separator = if before.is_empty() || before.ends_with("\n\n") {
                ""
            } else if before.ends_with('\n') {
                "\n"
            } else {
                "\n\n"
            };
            format!("{before}{separator}{block}\n")
        }
        ([(start, _)], [(end, _)]) if start < end => {
            let end = end + END.len();
            let current = &before[*start..end];
            if current != render(previous)
                && recorded_hash != Some(hash(current.as_bytes()).as_str())
            {
                return Err(conflict());
            }
            format!("{}{}{}", &before[..*start], block, &before[end..])
        }
        _ => return Err(conflict()),
    };
    c.after = Some(after.into_bytes());
    Ok(c)
}

pub fn has_block(path: &Path) -> Result<bool, Diagnostic> {
    let snapshot = crate::assets::Snapshot::read(path)?;
    let bytes = snapshot.bytes.unwrap_or_default();
    let text = std::str::from_utf8(&bytes).map_err(|_| conflict())?;
    Ok(text.contains(START) || text.contains(END))
}
