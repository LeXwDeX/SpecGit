# 更新共享 CLI 并刷新已有项目

在目标仓库使用统一的[项目维护指南](https://github.com/LeXwDeX/SpecGit/blob/main/docs/agent-project-refresh.md)。
指南会在项目写入前区分全新项目、已有 v2、v1 迁移与冲突状态，并保留声明、收据、
checkpoint、用户编辑和其他工具资产。

## 1. 按需更新共享 CLI

SpecGit 使用一个用户级原生可执行文件，供本机各项目和 worktree 共用。更新时通过
签名验证的 GitHub Release：

```sh
specgit update --check --json
specgit update --dry-run --json
specgit update --json
```

check 只读取发行信息；dry-run 下载并验证但不替换可执行文件；apply 只替换当前运行文件，
并保留备份。更新后用 `command -v specgit` 和 `specgit --human --version` 回读，确认 PATH
没有继续选中旧入口。前置依赖、恢复方式和平台限制见维护指南。

## 2. 分别刷新每个项目

共享二进制不会在仓库之间传递项目声明、指导、收据或 checkpoint。每个 clone 和 worktree
都应保留当前声明与私有状态，检查并刷新本地项目：

```sh
specgit init --check --json
specgit init --dry-run --json
specgit init --json
specgit setup --catalog --json
specgit setup --dry-run --json
specgit setup --json
specgit status --json
specgit doctor --offline --json
```

只应用当前且适用的预览。init 维护项目声明、Skill、指导和精确本地排除项，不安装宿主
hooks。默认 setup 安装或刷新共享项目 Skill 和稳定指导入口；新 setup 不添加 Agent hooks。
setup 会刷新全部已记录宿主及任何 `--agent` 指定的新宿主，因此应用前要审阅所有受影响资产。
若声明缺失但私有状态仍在，应恢复状态，不要当成全新项目接入。

## 3. 仅在需要时添加或调整宿主集成

用 `--agent` 新选宿主只添加它的指导和 Skill。要安装 hooks，必须显式指定
`--hook-purpose guard` 和/或 `--hook-purpose context`；`none` 不添加 hooks 并保留已有选择。
普通刷新省略用途以保留已记录选择。显式用途只作用于 `--agent` 指定宿主；省略
`--agent` 时才作用于所有已记录宿主。`--remove-hook-purpose guard` 或 `context` 仅移除
指定用途，宿主范围规则相同。

仅支持 SessionStart 和 PreToolUse 上下文 hooks。`observe` 用途会被识别但拒绝；改用有界
`watch` 或 `inbox`。PostToolUse、Stop 回调和空闲唤醒已退役。`guard` 安装原生 Git
pre-commit/pre-push checkpoint 检查。写入注册不代表宿主已加载或行为有效；依赖前要验证
真实宿主和 Git 入口。

原生能力不支持或未知，且必须选择运行方式时，可将手动观察作为 init 选项；
`--manual-observe` 会写入 `native_auto_merge=false`。除非当前任务授权了必要变更，
否则保留显式 true 偏好。不要为了让初始化通过而修改平台设置。

## 4. 谨慎迁移或移除

v1 项目先按[v1 到 v2 迁移指南](https://github.com/LeXwDeX/SpecGit/blob/main/docs/migration-v2.md)
迁移，再替换声明或生命周期。要移除单个已记录用途，使用 `--remove-hook-purpose` 并先审阅预览。
`setup --uninstall` 会移除当前 worktree 中全部已记录集成。整体移除项目集成使用 `specgit remove`，见
[移除与回滚参考](https://github.com/LeXwDeX/SpecGit/blob/main/docs/installation.md#removal-and-rollback)。

参阅[快速开始](Getting-Started-zh)、[团队工作流](Team-Workflow-zh)和[CLI 参考](CLI-Reference-zh)。
