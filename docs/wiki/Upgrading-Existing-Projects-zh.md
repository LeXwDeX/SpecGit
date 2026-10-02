# 老项目升级与 Agent 集成

先按[安装指南](https://github.com/LeXwDeX/SpecGit/blob/main/docs/installation.md)验证一个稳定原生版本并更新共享用户二进制；各仓库和 worktree 共用该命令行程序。用 `command -v specgit`（Windows 用 `Get-Command specgit`）和 `specgit --human --version` 确认 PATH，没有固定要求旧 2.1.x。

对于 v2 项目，保留现有声明并在目标仓库预览、应用刷新：

```sh
specgit init --check --json
specgit init --dry-run --json
specgit init --json
specgit status --json
```

若报告需要能力选择，先明确选择手动观察或在已有授权内配置平台，不要忽略诊断。2.2 的 SpecGit 排除区块只包含本地 `.specgit.yaml`；仓库/用户自己的 ignore 规则仍有效，AGENTS/CLAUDE 按仓库规则审阅。旧的 adoption-only checkpoint 在原分支重新选择原生 Issue，不能删除或改写其他分支的 checkpoint。

v1 项目先执行[显式迁移](https://github.com/LeXwDeX/SpecGit/blob/main/docs/migration-v2.md)，不要使用已退役的 `init --force`、`finish`、`bind`。二进制替换不会完成项目迁移。

仅为实际使用的宿主注册集成。自 2.4 起 setup 永久只支持项目级：`--scope project` 是默认值也是唯一的 scope 取值，hooks 直接调用已安装的共享二进制，无需先做全局 setup；已退役的全局选项（`--root`、`--provider`、`--api-host`、`--register-*`、各宿主根路径）会被拒绝。以下为 Codex 示例，Claude 用 `--agent claude`，OpenCode 用 `--agent opencode`，通用 `.agents` 宿主用 `--agent generic`：

```sh
specgit setup --agent codex --dry-run --json
specgit setup --agent codex --json
```

保留原有设置、宿主指导、手工编辑与外部 hooks。Codex/Claude 有受管理的 hooks；官方 OpenCode 构建只安装 Skill/指南——自定义 OpenCode fork 可用 `--opencode-claude-hooks`（须搭配 `--agent opencode`）显式启用 claude-code 格式的项目 hooks；生成的 hooks 没有异步观察者，需要用有界的 `watch` 手动观察。不要把 Claude settings hooks 手工复制成未经当前宿主验证的 OpenCode 集成。写入注册不等于宿主导入、事件触发或通知送达；必要时重载并验证。

从 2.3 升级：已有项目收据会在本地刷新为 2.4 格式（不再包含 `shared_root`），保留外部内容，不读取也不写入已退役的全局根目录。2.3 全局数据保持原样；2.4 不提供全局清理命令——确需清理时先备份，并在升级前用 2.3 CLI 精确清理自己名下的数据，切勿盲目删除。

仓库要求 Git 门禁时用 `specgit guard --install --json`，一次安装两个受管理区块并保留现有 hooks；`guard --uninstall` 只移除这些区块。

`setup --uninstall` 只移除当前 worktree 记录的项目级 agent 资产（2.4 没有可卸载的全局用户级 setup）；`init --rollback <transaction>` 只回滚该项目事务。2.2 没有通用的项目 remove 命令；2.3 引入 `specgit remove`（预览、按摘要应用、离线回滚），用于整体移除一个项目的本地集成。见[移除边界](https://github.com/LeXwDeX/SpecGit/blob/main/docs/installation.md#removal-and-rollback)。
