# 快速开始：Agent 安装与项目初始化

先为本机安装一个共享原生 CLI，再分别初始化每个目标仓库或 worktree。
新安装请使用[Agent 安装指南](https://github.com/LeXwDeX/SpecGit/blob/main/docs/agent-install.md)：
它只从 GitHub Releases 下载签名安装包，验证签名和 SHA-256，并核对实际执行文件。
[发行验证参考](https://github.com/LeXwDeX/SpecGit/blob/main/docs/installation.md)
说明签名与校验契约。

**CLI 已安装？** 在目标仓库打开 Agent，复制
[中文维护请求](https://github.com/LeXwDeX/SpecGit/blob/main/docs/agent-project-refresh.md#中文请求)
（[English request](https://github.com/LeXwDeX/SpecGit/blob/main/docs/agent-project-refresh.md#english-request)）。
该指南将共享 CLI 的签名更新与每个项目的刷新分开，并保留配置、checkpoint
和收据。不要重复安装，也不要删除私有状态来修复项目。

## 1. 安装或更新共享 CLI

按 Agent 指南安装并验证 PATH。GitHub Releases 是唯一公开分发渠道，提供
macOS arm64、Linux x64 glibc 和 Windows x64 的签名 ZIP。运行发行版不需要
Node.js、npm 或 Rust 编译器。CLI 已安装时，按维护指南使用签名验证的
`specgit update` 流程；同一可执行文件供本机所有仓库和 worktree 使用。
不要在项目内安装运行用副本，也不要用源码构建代替终端用户的签名发行版。

## 2. 初始化每个目标项目

进入**目标 Git 仓库根目录**，检查工作区、远程仓库和已有声明。仓库操作需要
Git，以及已认证的 `gh`（GitHub）或 `glab`（GitLab）；`--help` 成功不代表
远端访问正常。

```sh
cd /path/to/your-project
git status --short --branch
git remote -v
ls -la .specgit.yaml AGENTS.md CLAUDE.md 2>/dev/null
```

以下示例使用 GitHub 和远程名 `origin`。先检查原生能力并预览项目声明，再应用：

```sh
specgit init --provider github --remote origin --check --json
specgit init --provider github --remote origin --dry-run --json
specgit init --provider github --remote origin --json
```

`--check` 读取项目和原生能力；`--dry-run` 预览本地写入，两者都不会初始化项目。
新项目执行 init 时还会安装原生 Git guard：每次提交都需要选定的 Issue，推送的提交须带
`Issue: #N` trailer，例如 `git commit --trailer "Issue: #12"`。
选择实际的 forge 远程和 provider；GitLab 使用 `--provider gitlab`，仅在自建 API
需要时添加 `--api-host`。不要假设目标分支是 `main`。

原生能力不支持或未知，且必须选择运行方式时，`--manual-observe` 接受手动观察并写入
`agent.native_auto_merge=false`。除非当前任务授权了必要变更，否则保留显式 true 偏好。
检查、预览和应用使用一致的选项与配置。init 维护项目声明和项目指导，
不会安装宿主 hooks。

初始化后回读声明和本地状态：

```sh
cat .specgit.yaml
git status --short
specgit status --remote origin --json
specgit doctor --provider github --remote origin --json
```

已有 v2 项目应保留声明，并按维护指南执行检查、预览和应用。v1 项目先按
[迁移指南](https://github.com/LeXwDeX/SpecGit/blob/main/docs/migration-v2.md)
迁移；替换可执行文件不会迁移项目状态。

## 3. 安装项目指导与可选宿主集成

`specgit setup --catalog --json` 离线列出集成能力，不读取或修改项目。应用前先看计划：

```sh
specgit setup --dry-run --json
specgit setup --json
```

默认 setup 安装或刷新共享项目 Skill 和稳定指导入口；新安装不会加 Agent hooks。
用 `--agent` 新选宿主时，只添加该宿主的指导和 Skill。要启用 hooks，显式传入
`--hook-purpose guard` 和/或 `--hook-purpose context`。普通刷新省略用途以保留已有选择。
setup 会刷新全部已记录宿主及 `--agent` 指定的宿主；显式用途变更只作用于所选宿主，
省略 `--agent` 时才作用于所有已记录宿主。`none` 不添加 hooks，也保留已有选择。

仅支持 SessionStart 与 PreToolUse 上下文 hooks。旧 `observe` 用途会被识别但拒绝；
改用有界 `watch` 或 `inbox`。PostToolUse、Stop 回调和空闲唤醒已退役。`guard` 添加
原生 Git pre-commit/pre-push 检查；依赖宿主集成前先验证实际加载和行为。宿主选择与
卸载见[项目维护指南](https://github.com/LeXwDeX/SpecGit/blob/main/docs/agent-project-refresh.md#5-review-the-full-host-refresh-scope)。

参阅[老项目升级](Upgrading-Existing-Projects-zh)、[团队工作流](Team-Workflow-zh)和[CLI 参考](CLI-Reference-zh)。
