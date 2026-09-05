# 快速开始

## 安装与初始化

需要 Node.js `>=20.19`、Git 和已认证的平台 CLI。仓库命令应在准备接入的项目中执行。

```bash
npm install -g specgit@latest
specgit --version
gh auth status
specgit init
specgit setup
```

GitLab 用户先按主机认证 `glab`，再执行
`specgit init --gitlab-host gitlab.example.com`。详见 [GitLab 支持](GitLab-Support-zh)。
核对检测出的 check 名称；显式指定时可重复 `--required-check`。有意为空的列表表示
不要求业务 CI，平台验收仍是门禁。验收 job 不能把自己作为等待条件。

Init 会写入共享集成资产和本地钩子，提交前先检查改动。自动合并默认选择**否**，
只有用户明确同意才能开启。`setup` 安装的 Agent 入口属于本地辅助工具。

默认分支可能叫 `master`、`trunk` 或其他名称，SpecGit 不会猜成 `main`。
如果提示缺少默认分支证据，先运行 `git fetch origin` 和
`git remote set-head origin -a`，再重试。自动化目标用于选择 PR/MR 的合并位置，
不能代替初始化所需的默认分支证据。

## 开始交付

```bash
specgit issue "feat: add login flow"
# 实现，运行适用检查，提交并推送。
gh pr ready <number>                 # GitLab: glab mr update <number> --ready
specgit finish
```

一个 Issue 对应一个可独立验证的 WHY。标题用于新建，编号用于复用；多个参数可以
把多个 Issue 绑定到唯一 PR/MR。新标题需要支持的 `<type>:` 前缀，语言和校验由项目
策略决定。中文标题可显式指定 ASCII 交付名：
`specgit issue "docs: 更新简介" --delivery refresh-introduction`。

选定的正文规则要求创建时内容完整时，每个新 Issue 提供一个 `--body-file`，PR/MR
提供 `--pr-body-file`。保留每个 `Closes #n`。中断后重跑原命令以恢复，避免重复创建。

退出 `0` 表示验收通过，`finish` 不会合并或关闭 Issue。已启用的完成自动化在 CI 后
继续，`specgit pr --merge` 用于恢复；未启用时，按团队已授权的流程合并。
只有确认合并且所有 Issue 已关闭，才能报告交付完成。

纯说明修改只核对相关内容并做轻量检查，无需产品构建或反复代码评审。
见[团队工作流](Team-Workflow-zh)。

## 升级与刷新

更新软件包和刷新仓库是两步：

```bash
npm install -g specgit@latest
specgit --version
specgit init --force --no-protect
specgit setup --tool all
specgit status --json
```

提交共享资产前检查 diff。所有权冲突、以及有意跟踪权威文件并使用 `--no-ignore`
的配置，见[安装指南](https://github.com/LeXwDeX/SpecGit/blob/main/docs/installation.md)。
只有诊断指向环境前置条件或平台问题时才使用 `doctor`。
软件包升级后，使用上述显式步骤刷新仓库即可。

[CLI 参考](CLI-Reference-zh) · [English](Getting-Started)
