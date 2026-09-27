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

仅为实际使用的宿主注册集成。以下为 Codex 示例，Claude 用 `--register-claude`，OpenCode 用 `--register-opencode`：

```sh
specgit setup --provider github --register-codex --dry-run --json
specgit setup --provider github --register-codex --json
```

保留原有设置与实际宿主根路径。Codex/Claude 有受管理的 hooks；OpenCode 这里只安装 Skill/指南。不要把 Claude settings hooks 手工复制成未经当前宿主验证的 OpenCode 集成。写入注册不等于宿主导入、事件触发或通知送达；必要时重载并验证。

仓库要求 Git 门禁时用 `specgit guard --install --json`，一次安装两个受管理区块并保留现有 hooks；`guard --uninstall` 只移除这些区块。

`setup --uninstall` 清理选定用户级资产，`init --rollback <transaction>` 只回滚该项目事务；2.2 没有通用的项目 remove 命令。见[移除边界](https://github.com/LeXwDeX/SpecGit/blob/main/docs/installation.md#removal-and-rollback)。
