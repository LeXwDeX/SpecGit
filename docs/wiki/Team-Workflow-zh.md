# 团队工作流

选择完整的 Issue，通过 `specgit issue` 预览并关联，然后实现、验证、提交和推送。使用 `specgit pr` 预览并创建或接管请求，保留所有关闭引用。

通过 `specgit pr --status --json` 与有界的 `specgit watch` 读取当前证据。Agent 修复失败，并在已有授权内执行原生平台操作，最后确认目标分支合并和 Issue 关闭。参见[仓库 CI 规则](https://github.com/LeXwDeX/SpecGit/blob/main/docs/ci-scope.md)。
