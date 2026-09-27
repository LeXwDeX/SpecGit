# 2.2.1 文档纠偏记录

日期：2026-09-27。规格：[Issue #644](https://github.com/LeXwDeX/SpecGit/issues/644)。
基线：`v2.2.0` / `ce54ea6f6c047f5a422225312bc132283866cb17`。

## 审阅范围与依据

盘点仓库全部 Markdown、LICENSE、两份版本化 guidance 文本夹具、内嵌指导与 CLI
help/schema，以及真实 GitHub Wiki 的全部 17 页。Wiki 初始提交为
`8c393a1ef5407641bf6c777c7c662588f12d0b5e`；其中两份升级指南原来没有仓库副本，
现纳入 `docs/wiki`。本轮没有删除 Wiki 页面。

当前行为依据已发布 2.2.0 二进制的离线 help/schema、当前源代码与 CI/Release
工作流。图索引指向另一旧 checkout，虽无记录缺口，不能为当前 main 提供完整性
保证；相关文档、生成指导和验证脚本均直接读取核对。

历史设计、318 项 Issue 映射及旧运行报告审查的是适用边界、编号、内部链接与追溯
完整性；不把历史承诺改成当前契约，不重新声称所有历史 Issue 已在本轮复验。
`guidance-2.0.0-*.txt` 是迁移兼容夹具，保留字节不变；更改它们会破坏旧版识别。

## 已纠正的问题

1. AGENTS/README 的自有 Linux/Windows runner 说法与当前托管矩阵冲突。
2. CONTEXT 仍将 v1 绑定、批准策略、验收引擎和 registry 描述为当前模型。
3. 安装说明和内嵌 skill 要求隐藏/排除生成指导，与 2.2 跨 worktree 行为冲突；同时说明仓库/用户原有 ignore 规则仍有效，不能因此擅自取消用户排除规则。
4. Wiki 快速开始只有 check/dry-run，缺少实际 init；升级页停留在 2.1.x 并要求手工移植未经验证的 OpenCode hooks。
5. ready 示例缺少写入预览，当前正文修改、Actions 读取和 GitLab merged-results 限制未在 Wiki 说明。
6. 工程 schema 生成物被描述为公共包内容；CI phase 恢复与独立 Release 构建混淆；npm 恢复退役与 GitHub 中断恢复相互矛盾。
7. 历史设计包装了仍然有效的旧 runner/npm/授权要求，F43 编号重复；现明确归档并将后加 Git guard 行标为 F43a。
8. CHANGELOG 缺少 2.0.1 和 2.2.0，Issue 模板没有统一的 Why / Scope / Approach / Acceptance。
9. 文档检查原来只有部分页面且不检查锚点和 Wiki，现覆盖仓库全部 Markdown、main 链接、Wiki 导航和版本引用。

## 逐文件处置

共 49 个文档/文本文件（含新增文档与 Wiki 源文件）。

| 文件 | 处置 |
| --- | --- |
| [.devcontainer/README.md](../.devcontainer/README.md) | 核对容器配置与工具链，保留三平台验收限制。 |
| [.github/ISSUE_TEMPLATE/bug_report.md](../.github/ISSUE_TEMPLATE/bug_report.md) | 补齐四段规格并保留诊断/复现要求。 |
| [.github/ISSUE_TEMPLATE/feature_request.md](../.github/ISSUE_TEMPLATE/feature_request.md) | 补齐四段规格，独立 WHY 与验收要求。 |
| [.github/PULL_REQUEST_TEMPLATE.md](../.github/PULL_REQUEST_TEMPLATE.md) | 核对关闭引用、当前 head 与安装证据；保留。 |
| [.github/workflows/README.md](../.github/workflows/README.md) | 核对实际工作流；费用与 CodeQL 配置边界明确。 |
| [AGENTS.md](../AGENTS.md) | 纠正 runner、共享 CLI、checkpoint、授权与生成指导；版本对齐。 |
| [CHANGELOG.md](../CHANGELOG.md) | 按原生 Release/PR 补齐 2.0.1、2.2.0 与本轮 2.2.1；历史条目按版本保留。 |
| [CONTEXT.md](../CONTEXT.md) | 移除 v1 binding/policy/acceptance 术语，重写为 v2 术语。 |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | 核对规格、文档短路径、当前 head 与发布授权；保留。 |
| [LICENSE](../LICENSE) | MIT 原文与 Cargo 元数据一致；保留，不改变许可。 |
| [README.md](../README.md) | runner、ready 预览、当前文档入口对齐。 |
| [docs/agent-install.md](agent-install.md) | 共享用户级二进制、指导可见性、安装证据边界。 |
| [docs/ci-scope.md](ci-scope.md) | 对齐当前 Rust 主版本；去除固定费用承诺。 |
| [docs/design/specgit-2-acceptance.md](design/specgit-2-acceptance.md) | 历史档案；增加当前入口与时点边界，保留历史需求和追溯。 |
| [docs/design/specgit-2-contract.md](design/specgit-2-contract.md) | 历史档案；增加当前入口与时点边界，保留历史需求和追溯。 |
| [docs/design/specgit-2-rust-design.md](design/specgit-2-rust-design.md) | 历史档案；增加当前入口与时点边界，保留历史需求和追溯。 |
| [docs/design/specgit-2-rust-history.md](design/specgit-2-rust-history.md) | 历史档案；增加当前入口与时点边界，保留历史需求和追溯。 |
| [docs/design/specgit-2.md](design/specgit-2.md) | 历史档案；增加当前入口与时点边界，保留历史需求和追溯。 |
| [docs/documentation-audit-2.2.1.md](documentation-audit-2.2.1.md) | 本轮逐文件清单、纠偏依据与验收范围。 |
| [docs/installation.md](installation.md) | 补全项目刷新 apply、说明排除与移除/回滚范围。 |
| [docs/migration-v2.md](migration-v2.md) | 区分 Agent 偏好与 manual-observe；范围改为 2.x。 |
| [docs/release-2.2.md](release-2.2.md) | 保留九项修复和限制，补充已发布版本的实际来源。 |
| [docs/supported-tools.md](supported-tools.md) | 明确宿主支持范围、注册证据与 ready 预览。 |
| [docs/wiki/CLI-Reference-zh.md](wiki/CLI-Reference-zh.md) | 中英当前指南/导航；完整纳入 17 页同步与逐页回读。 |
| [docs/wiki/CLI-Reference.md](wiki/CLI-Reference.md) | 中英当前指南/导航；完整纳入 17 页同步与逐页回读。 |
| [docs/wiki/Concepts-zh.md](wiki/Concepts-zh.md) | 中英当前指南/导航；完整纳入 17 页同步与逐页回读。 |
| [docs/wiki/Concepts.md](wiki/Concepts.md) | 中英当前指南/导航；完整纳入 17 页同步与逐页回读。 |
| [docs/wiki/Getting-Started-zh.md](wiki/Getting-Started-zh.md) | 中英当前指南/导航；完整纳入 17 页同步与逐页回读。 |
| [docs/wiki/Getting-Started.md](wiki/Getting-Started.md) | 中英当前指南/导航；完整纳入 17 页同步与逐页回读。 |
| [docs/wiki/GitLab-Support-zh.md](wiki/GitLab-Support-zh.md) | 中英当前指南/导航；完整纳入 17 页同步与逐页回读。 |
| [docs/wiki/GitLab-Support.md](wiki/GitLab-Support.md) | 中英当前指南/导航；完整纳入 17 页同步与逐页回读。 |
| [docs/wiki/Home-zh.md](wiki/Home-zh.md) | 中英当前指南/导航；完整纳入 17 页同步与逐页回读。 |
| [docs/wiki/Home.md](wiki/Home.md) | 中英当前指南/导航；完整纳入 17 页同步与逐页回读。 |
| [docs/wiki/Provider-Architecture-zh.md](wiki/Provider-Architecture-zh.md) | 中英当前指南/导航；完整纳入 17 页同步与逐页回读。 |
| [docs/wiki/Provider-Architecture.md](wiki/Provider-Architecture.md) | 中英当前指南/导航；完整纳入 17 页同步与逐页回读。 |
| [docs/wiki/Team-Workflow-zh.md](wiki/Team-Workflow-zh.md) | 中英当前指南/导航；完整纳入 17 页同步与逐页回读。 |
| [docs/wiki/Team-Workflow.md](wiki/Team-Workflow.md) | 中英当前指南/导航；完整纳入 17 页同步与逐页回读。 |
| [docs/wiki/Upgrading-Existing-Projects-zh.md](wiki/Upgrading-Existing-Projects-zh.md) | 中英当前指南/导航；完整纳入 17 页同步与逐页回读。 |
| [docs/wiki/Upgrading-Existing-Projects.md](wiki/Upgrading-Existing-Projects.md) | 中英当前指南/导航；完整纳入 17 页同步与逐页回读。 |
| [docs/wiki/_Sidebar.md](wiki/_Sidebar.md) | 中英当前指南/导航；完整纳入 17 页同步与逐页回读。 |
| [runtime/LIGHTWEIGHT-EVIDENCE.md](../runtime/LIGHTWEIGHT-EVIDENCE.md) | 冻结 2026-09-10 实测，不作为当前发布/授权/阻塞结论。 |
| [runtime/README.md](../runtime/README.md) | 补 ready 预览；区分 CI phase 恢复与 Release 构建。 |
| [runtime/REFERENCE.md](../runtime/REFERENCE.md) | 区分嵌入 schema 与内部生成文件；修正指导提交策略、预览例子。 |
| [runtime/RETIRED-TESTS.md](../runtime/RETIRED-TESTS.md) | 标明历史映射，补 2.2 原生 execution identity 的边界。 |
| [runtime/assets/SKILL.md](../runtime/assets/SKILL.md) | 指导按仓库政策评审，不再一概排除生成部分。 |
| [runtime/distribution/README.md](../runtime/distribution/README.md) | 区分 npm 退役与 GitHub 恢复；版本、安装入口对齐。 |
| [runtime/tests/fixtures/guidance-2.0.0-en.txt](../runtime/tests/fixtures/guidance-2.0.0-en.txt) | 2.0.0 迁移兼容原文；核对后保留字节不变。 |
| [runtime/tests/fixtures/guidance-2.0.0-zh.txt](../runtime/tests/fixtures/guidance-2.0.0-zh.txt) | 2.0.0 迁移兼容原文；核对后保留字节不变。 |
| [scripts/README.md](../scripts/README.md) | 说明全部 Markdown/Wiki 链接检查范围。 |

## 可重复验证与发布

`node scripts/ci-metadata-check.mjs` 扫描全部仓库 Markdown 的本地和 main 分支链接、
锚点、Wiki 页面导航，并检查当前版本及 Issue 模板结构；`pnpm test` 覆盖链接丢失、
锚点丢失、Unicode、重复标题和代码围栏。该离线检查不声称所有外部历史 URL 永久可用。

82 条当前命令示例已用已发布二进制追加 `--schema` 做离线解析，未执行远端写入。
历史台账 318 个 ID 唯一，分类数 139 / 85 / 47 / 45 / 2 与原记录一致。
本地 Rust 1.97.0 fmt/clippy 通过；源测试 264 通过、0 失败、1 项真实宿主用例
按原条件忽略；仓库测试 17 通过，分发测试 17 通过。

本轮修改内嵌 skill、reference 和版本输入，按产品路径验证：Rust fmt、clippy、
全部源测试、分发测试及隔离安装后的完整回归，随后等待当前 head 的三平台 CI。
主分支合并、Wiki 发布、签名 ZIP 发布和下载包验证分别记录原生证据，不能互相替代。
Wiki 发布后以远端再次 fetch 的文件集合和逐页 SHA-256 对照 `docs/wiki`，不能只凭 push 成功。

宿主注册文件/CLI hook 回归不证明真实宿主消费；GitLab merged-results 的协议夹具
不证明任意实际 GitLab 实例通过。文档纠偏不扩大这些能力声明。
