# SpecGit Wiki

SpecGit 是供团队和编码 Agent 使用的轻量交付绑定与验收工具。它把分支或
worktree、一个或多个 Issue、唯一一个 PR/MR 和项目要求的检查连接起来，再用
真实 Git 和平台证据验证这次交付。

**验收通过和交付完成是两个事实。** `specgit finish` 退出 `0` 表示验收通过；
只有确认合并、所有绑定 Issue 均已关闭，交付才算完成。证据不足时返回
`unknown`，不能当成通过。该命令本身只读，不会合并或关闭 Issue。

## 验证与改动相称

README 简介、普通文档和项目指导的修改，只需要核对相关内容并做轻量检查。
无需产品构建、全量测试、变异测试、反复 Agent 评审或发布新版本。程序源码和
可执行输入使用适用的产品检查；混有程序改动的 PR 仍需产品验证。

SpecGit 自身仓库在合并前保留轻量远程文档/元数据验证和验收。接入项目自行决定
检查范围，SpecGit 源仓库的 CI 策略不会替换接入项目的业务流水线。

## 从这里开始

| 指南 | 内容 |
| --- | --- |
| [快速开始](Getting-Started-zh) | 安装、接入、交付与升级 |
| [CLI 参考](CLI-Reference-zh) | 十条命令、参数、退出码与 JSON |
| [核心概念](Concepts-zh) | 绑定、证据、验收与完成 |
| [团队工作流](Team-Workflow-zh) | 策略、适度验证、评审与合并 |
| [GitLab 支持](GitLab-Support-zh) | 主机声明、兼容范围与流水线归属 |
| [Provider 架构](Provider-Architecture-zh) | 本地 Git 与平台能力边界 |

安装命令为 `npm install -g specgit@latest`。需要 Node.js `>=20.19`、Git 和
已认证的 `gh` 或 `glab`；用 `specgit --version` 确认已安装版本。这些页面描述
**v1.14.0（待发布）**，包含该版本的默认分支证据要求。于 **2026-09-05**
核对时，npm 的最新发布版为 **v1.13.1**。

详细契约见[仓库文档](https://github.com/LeXwDeX/SpecGit/tree/main/docs)。Wiki 的
可编辑副本保存在 `docs/wiki/`；修改副本后，还需要单独发布到这个 Wiki。

English: [Home](Home) · [Getting Started](Getting-Started)
