# 老项目升级与 Agent 集成

**共享 CLI 已安装：** 使用统一的
[项目维护指南](https://github.com/LeXwDeX/SpecGit/blob/main/docs/agent-project-refresh.md)。
在目标仓库打开 Agent，复制其中的
[中文请求](https://github.com/LeXwDeX/SpecGit/blob/main/docs/agent-project-refresh.md#中文请求)
或 [English request](https://github.com/LeXwDeX/SpecGit/blob/main/docs/agent-project-refresh.md#english-request)，
要求实际检查并完成所有权边界明确的维护，而不是重做安装。请求单独授权必要的稳定版验证升级；
可选能力未知不阻止适用的本地维护，init 仅在新项目默认 false 或已有 false 的 `native_auto_merge` 下选择手动观察。
该参数会设为 false；已有 true 偏好需先取得具体变更决策。安装/启用会委托当前任务所需流程，无需逐步重复确认。明确的任务限制仍然有效；声明或旧收据不会扩大范围。仅当任务本身包含发布时才发布。
核对 CLI 的实际路径和版本；缺失时不要静默重装。

执行下方简写的 v2 流程前，先按指南分类。声明丢失但私有状态仍在时不是全新项目，
应恢复原配置或备份。保留配置、收据、checkpoint、块外改动及外部资产；边界完整且所有权可信的受管内容即使正文被编辑，也会刷新为当前模板。不要删除状态或 hooks 来强行刷新。
检查、预览和执行应使用同一套配置、远程和能力选项。

对于 v2 项目，保留现有声明并在目标仓库预览、应用刷新：

```sh
specgit init --check --json
specgit init --dry-run --json
specgit init --json
specgit status --json
```

若报告需要能力选择，先明确选择手动观察或在已有授权内配置平台，不要忽略诊断。当前 Git 本地排除区块仅覆盖 `.specgit.yaml` 和生成的 SpecGit Skill 文件；仓库/用户自己的 ignore 规则仍有效，手写 AGENTS/CLAUDE 内容按仓库规则审阅。旧的 adoption-only checkpoint 在原分支重新选择原生 Issue，不能删除或改写其他分支的 checkpoint。全部更新后运行 status/doctor，读回生成指导与 Skill，再次 dry-run；init dry-run 只列计划路径，不表示逐项改变状态。仅支持 SessionStart 和 PreToolUse：简短规则/Skill 入口及相关上下文/恢复信息；不配置 PostToolUse、Stop 或空闲唤醒。声称 hook 生效前须做无副作用的实际行为/上下文探针。

v1 项目先执行[显式迁移](https://github.com/LeXwDeX/SpecGit/blob/main/docs/migration-v2.md)，不要使用已退役的 `init --force`、`finish`、`bind`。二进制替换不会完成项目迁移。

仅按需添加实际使用的宿主。setup 仍会刷新所有已记录宿主，`--agent` 不会将影响限于该宿主。
逐一审阅并报告资产变化，包括共享 Skill 刷新。自 2.4 起 setup 永久只支持项目级：`--scope project` 是默认值也是唯一的 scope 取值，hooks 直接调用已安装的共享二进制，无需先做全局 setup；已退役的全局选项（`--root`、`--provider`、`--api-host`、`--register-*`、各宿主根路径）会被拒绝。以下为 Codex 示例，Claude 用 `--agent claude`，OpenCode 用 `--agent opencode`，通用 `.agents` 宿主用 `--agent generic`：

```sh
specgit setup --agent codex --dry-run --json
specgit setup --agent codex --json
```

保留原有配置、受管块外手工指导和外部 hooks；所有权可信且边界完整唯一的 SpecGit 标准正文由 CLI 覆盖更新。受管理 hooks 仅提供 SessionStart 和 PreToolUse。不注册 PostToolUse、Stop 回调或空闲唤醒。若无法自动观察，使用有界 watch/inbox 或手动继续。不要把 Claude settings hooks 复制成未经验证的 OpenCode 集成。写入注册不证明上下文送达，需实际验证。

`guard` 配置原生 commit/push 检查，`context` 提供两个受支持事件的上下文；`observe` 明确报告不支持，改用有界 watch/inbox。
普通刷新省略用途以保留已有选择。显式用途作用于所有已记录及新选宿主，应处于当前任务范围内。
`none` 不新增用途，保留有效用途和原生 Git guard；刷新仍会移除已退役的受管 PostToolUse/Stop 注册。宿主选择是叠加的。
仅选择任务所需、真实能力支持的用途。选择性收据的降级限制与验证步骤见维护指南。

从 2.3 升级：已有项目收据会在本地刷新为 2.4 格式（不再包含 `shared_root`），保留外部内容，不读取也不写入已退役的全局根目录。2.3 全局数据保持原样；2.4 不提供全局清理命令——确需清理时先备份，并在升级前用 2.3 CLI 精确清理自己名下的数据，切勿盲目删除。

仓库要求 Git 门禁时用 `specgit guard --install --json`，一次安装两个受管理区块并保留现有 hooks；`guard --uninstall` 只移除这些区块。

`setup --uninstall` 只移除当前 worktree 记录的项目级 agent 资产（2.4 没有可卸载的全局用户级 setup）；`init --rollback <transaction>` 只回滚该项目事务。2.2 没有通用的项目 remove 命令；2.3 引入 `specgit remove`（预览、按摘要应用、离线回滚），用于整体移除一个项目的本地集成。见[移除边界](https://github.com/LeXwDeX/SpecGit/blob/main/docs/installation.md#removal-and-rollback)。
