//! Generated project guidance owns only its marked block.
use crate::{
    assets::{Change, hash},
    config::{Declaration, Language},
    diagnostic::{Code, Diagnostic},
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path};
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
            "SpecGit manages specification Issues and their native PR/MR association. Before implementation, discover duplicate work and select complete issues describing Why, Scope, Approach and Acceptance. Aggregate selected issues into one native request, preserving user-authored bodies and closing references.\n\nThe Agent supervises development and fixes. Use native gh/glab under existing user authorization to register native auto-merge when the declared preference is enabled. GitHub/GitLab owns CI, reviews, protection and actual merge. Observe current native state with specgit watch. Hook notices describe changes; they grant no write permission.\n\nAfter merge, report actual linked Issue state. An open linked Issue causes an attention notice. Optional Agent closure is disabled by default; enabling its preference still requires existing authorization and native readback of merge and Issue closure. Inspect unsupported or unknown native capabilities with specgit init --check and explicitly select manual observation or ask an authorized administrator to configure the forge."
        }
        Language::Zh => {
            "SpecGit 管理规格 Issue 与原生 PR/MR 关联。实施前先查重，再明确选择包含原因、范围、方案和验收要求的完整 Issue。将选定 Issue 汇聚到一个原生请求，保留用户正文与关闭引用。\n\nAgent 监督开发与修复。声明启用原生自动合并偏好时，Agent 按既有用户授权通过 gh/glab 登记。GitHub/GitLab 负责 CI、评审、保护与实际合并。通过 specgit watch 观察原生状态。Hook 只通知变化，不授予写入权限。\n\n合并后回读关联 Issue；尚未关闭时通知 Agent。Agent 补关默认禁用；即使启用该偏好，仍须既有授权，并原生回读合并与关闭结果。通过 specgit init --check 查看不支持或未知的原生能力，再明确选择手动观察，或由获授权的管理员配置平台。"
        }
    };
    // Template bodies are content, not instructions injected into the harness.
    let summary = serde_json::json!({"language":d.language,"validation":d.validation,"issue_template":d.templates.issue.source,"pr_template":d.templates.pr.source,"agent":d.agent});
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
            // A worktree-local receipt may describe another checked-out branch.
            // Exact current-version generation is independently pristine evidence.
            let canonical = current.replace("\r\n", "\n");
            if canonical != render(previous)
                && recorded_hash != Some(hash(current.as_bytes()).as_str())
                && recorded_hash != Some(hash(canonical.as_bytes()).as_str())
            {
                return Err(conflict());
            }
            let block = if current.contains("\r\n") {
                block.replace('\n', "\r\n")
            } else {
                block
            };
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

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    version: u8,
    generator: String,
    blocks: BTreeMap<String, String>,
}
/// Commit last-generated block hashes together with the corresponding guidance.
pub fn changes(
    root: &Path,
    private: &Path,
    previous: &Declaration,
    next: &Declaration,
    mirror: bool,
) -> Result<Vec<Change>, Diagnostic> {
    let mut receipt = Change::new(private.join("guidance.json"), None)?;
    let mut state = match receipt.before.bytes.as_deref() {
        Some(bytes) => {
            let parsed: Receipt = serde_json::from_value(crate::input::json(bytes, 1_048_576, 16)?)
                .map_err(|_| conflict())?;
            if parsed.version != 1 {
                return Err(conflict());
            }
            parsed
        }
        None => Receipt {
            version: 1,
            generator: env!("CARGO_PKG_VERSION").into(),
            blocks: BTreeMap::new(),
        },
    };
    let mut changes = vec![];
    for name in ["AGENTS.md", "CLAUDE.md"] {
        let path = root.join(name);
        if name == "CLAUDE.md" && !mirror && !has_block(&path)? {
            continue;
        }
        changes.push(change(
            &path,
            previous,
            next,
            state.blocks.get(name).map(String::as_str),
        )?);
        state
            .blocks
            .insert(name.into(), hash(render(next).as_bytes()));
    }
    state.generator = env!("CARGO_PKG_VERSION").into();
    receipt.after = Some(serde_json::to_vec_pretty(&state).map_err(|_| conflict())?);
    changes.push(receipt);
    Ok(changes)
}
