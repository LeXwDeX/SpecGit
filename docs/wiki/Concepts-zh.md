# 核心概念

每个 Issue 对应一个可独立验证的 WHY，包含 Why、Scope、Approach、Acceptance。多个 Issue 可汇聚到一个原生 PR/MR，保持原生 ID 与关闭引用。

`.specgit.yaml` 是本地偏好；Git 下的 checkpoint 保存当前分支/worktree 的选择与恢复意图。它不是 v1 的权威绑定，也不是远端完成证据。切换分支不会重置 checkpoint；独立任务使用独立 worktree。

等待、失败、未知、合并与完成是不同状态。原生保护由平台管理，声明、预览和通知不授予操作权限。只读审计无需 Issue checkpoint；产品编辑前选择完整规格，纯文档按仓库规则与已安装 hook 要求处理。

[完整术语表](https://github.com/LeXwDeX/SpecGit/blob/main/CONTEXT.md)。
