# GitLab 支持

通过已认证的 `glab` 访问实际项目；自建实例明确选择 provider/API host，SSH 与 API 端口分别处理。初始化读取默认分支，不猜测 main。原生自动合并能力未知时，明确选择 `--manual-observe` 或在授权内配置平台再检查。

判断能力时，分别记录部署方式（GitLab.com、Self-Managed、Dedicated）、服务端版本、CE/EE 版别、订阅层级（Free/Premium/Ultimate）及当前身份的项目权限。未启用付费订阅的 EE 可提供 Free 层功能；层级名称本身不能证明功能已启用或当前身份可用。不要访问管理员许可或计费数据。单独的 403/404 不能区分权限不足、资源不可见或套餐限制；证据不可得时保持 unknown。参见[GitLab 订阅说明](https://docs.gitlab.com/subscriptions/manage_subscription/)和[EE 许可说明](https://docs.gitlab.com/administration/license/)。

观察 merged-results pipeline 时保留 source `head` 和 `tested_head`：必须是该 MR 的 head pipeline、merge ref，且测试提交只有当前 source/target 两个父提交。过时结果、未知 ancestry 或无法满足该证明的 merge train 保持不可用，不直接跳过 SHA 校验。CI 资格和实际合并仍由 GitLab 决定。

创建描述回读允许平台 CRLF→LF 与末尾 ASCII 空白规范化；不因此容许覆盖并发正文。已有 MR 正文差异只支持预览后原生编辑。

[完整契约及限制](https://github.com/LeXwDeX/SpecGit/blob/main/runtime/REFERENCE.md)。
