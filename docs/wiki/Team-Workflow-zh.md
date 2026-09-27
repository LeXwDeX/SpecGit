# 团队工作流

先检查重复 WHY，选择完整 Issue，再实现、验证、提交和推送真实变更。下面 ID 都是占位示例，替换为实际原生 ID；每次写入都须已有对应授权，预览不产生授权。

```sh
specgit issue 21 22 --dry-run --json
specgit issue 21 22 --json
# Implement, verify, commit and push actual changes before creating a request.
specgit pr --title 'feat: implement selected specs' --body-file request.md --dry-run --json
specgit pr --title 'feat: implement selected specs' --body-file request.md --json
specgit pr --status --request 42 --json
specgit pr --ready --request 42 --dry-run --json
specgit pr --ready --request 42 --json
specgit watch --request 42 --session task-42 --goal lifecycle --timeout-seconds 300 --json
specgit pr --status --request 42 --json
```

草稿须完成评审准备再标记 ready；平台管理 CI、审批和合并。watch 超时不代表完成，保留同一会话恢复观察。`--goal checks` 只验证观察到的检查，不证明合并或 Issue 关闭；合并后逐一确认关联 Issue 状态。

跨分支只读使用显式 `pr --status --request <id>`；watch 仍绑定当前 worktree。项目实例应采用自己的 CI；[SpecGit 仓库 CI](https://github.com/LeXwDeX/SpecGit/blob/main/docs/ci-scope.md)不是所有使用者的固定检查清单。
