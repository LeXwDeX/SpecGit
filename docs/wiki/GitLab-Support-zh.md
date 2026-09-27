# GitLab 支持

通过已认证的 `glab` 访问实际项目；自建实例明确选择 provider/API host，SSH 与 API 端口分别处理。初始化读取默认分支，不猜测 main。原生自动合并能力未知时，明确选择 `--manual-observe` 或在授权内配置平台再检查。

2.2 观察 merged-results pipeline 时保留 source `head` 和 `tested_head`：必须是该 MR 的 head pipeline、merge ref，且测试提交只有当前 source/target 两个父提交。过时结果、未知 ancestry 或无法满足该证明的 merge train 保持不可用，不直接跳过 SHA 校验。CI 资格和实际合并仍由 GitLab 决定。

创建描述回读允许平台 CRLF→LF 与末尾 ASCII 空白规范化；不因此容许覆盖并发正文。已有 MR 正文差异只支持预览后原生编辑。

[完整契约及限制](https://github.com/LeXwDeX/SpecGit/blob/main/runtime/REFERENCE.md)。
