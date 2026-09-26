# 团队工作流

选择完整的 Issue，通过 `specgit issue` 预览并关联，然后实现、验证、提交和推送。使用 `specgit pr` 预览并创建或接管请求，保留所有关闭引用。

请求已推送后，在已有授权内使用 `specgit pr --ready --request <id> --json` 准备评审。评审与合并由 GitHub 或 GitLab 完成；有界的 `specgit watch` 只观察当前证据。平台报告合并后，用 `specgit pr --status --request <id> --json` 重新读取原生请求和 Issue 状态。退出零只表示读取成功，不代表交付完成。参见[仓库 CI 规则](https://github.com/LeXwDeX/SpecGit/blob/main/docs/ci-scope.md)。
