# 核心概念

每个 Issue 对应一个可独立验证的 WHY，包含 Why、Scope、Approach、Acceptance。多个 Issue 可汇聚到一个原生 PR/MR，保持原生 ID 与关闭引用。

`.specgit.yaml` 是本地偏好；Git 下的 checkpoint 保存当前分支/worktree 的选择与恢复意图。安装 Git guard 时，它要求在 commit/push 前完成；普通编辑不受 checkpoint 限制。它不是 v1 的权威绑定，也不是远端完成证据。切换分支不会重置 checkpoint；独立任务使用独立 worktree。

等待、失败、未知、合并与完成是不同状态。原生保护由平台管理，声明、预览和通知不授予操作权限。声明、预览和通知本身不会扩大任务范围。安装或启用会委托当前任务所需的完整工作流，无需逐步重复确认。只读审计和普通编辑无需 checkpoint；commit/push 前选择完整 Issue。较大目标可用 Milestone，并按结果和依赖拆分 Issue。建议采用 TDD 并跟进 PR CI；项目或平台明确要求的检查仍须完成。

[完整术语表](https://github.com/LeXwDeX/SpecGit/blob/main/CONTEXT.md)。
