# 支持的宿主

SpecGit 的新能力先在共享 CLI 和原生 Git guard 中实现，因此项目即使零宿主集成也能
完整工作。宿主 hooks 只提供提示和上下文，不承载业务规则。每个宿主适配都在
`specgit setup --catalog --json` 中声明支持状态与回退方式。完整细节和发现边界见
[支持的编码 Agent](https://github.com/LeXwDeX/SpecGit/blob/main/docs/supported-tools.md#support-matrix)。

## 支持矩阵

| 宿主 | 指导入口 | Skill 发现 | 上下文 hooks | 受管只读白名单 | 回退 |
| --- | --- | --- | --- | --- | --- |
| `generic` | `AGENTS.md` | 宿主读取 `.agents` 时使用 `.agents/skills/specgit-native/SKILL.md` | 无；不支持 | 不支持：宿主没有权限配置 | 直接阅读指导与 Skill |
| Claude Code | `CLAUDE.md` | 规范 `.agents` Skill，另有 `.claude/skills/specgit-native/SKILL.md` | `.claude/settings.json` 的 SessionStart/PreToolUse | 用 `--readonly-permissions` 写入 `.claude/settings.json` 的 `permissions.allow` | 重读指导与 Skill |
| Codex | `AGENTS.md`，或已存在的非空 `AGENTS.override.md` | 规范 `.agents` Skill；Codex 从工作目录向上扫描到仓库根，并读取 `~/.agents/skills` | `.codex/hooks.json`；须在宿主 `/hooks` 中信任项目层 | 不支持：审批与沙箱仍属实验性 | 重读指导与 Skill |
| OpenCode（官方） | `AGENTS.md` | `.agents` Skill；宿主还读取项目 `.opencode/` 与 `.claude/` skills | 无；不支持 | 不支持：默认放行，无可移植白名单 | 重读指导与 Skill；使用有界 `watch`/`inbox` |
| OpenCode 自定义 fork | `AGENTS.md` | 同官方 OpenCode | `.opencode/hooks.json`，`inputFormat: claude-code`；须 `--agent opencode --opencode-claude-hooks` 并显式指定 hook 用途 | 不支持 | 同官方 OpenCode |

`guard` 是原生 Git pre-commit/pre-push 检查，不是宿主回调。它对所有宿主生效，
包括 generic：用 `setup --hook-purpose guard` 或 `specgit guard --install` 安装。
上下文 hooks 是可选项，只负责提示和上下文，不承载业务规则。

## 快速上手

先完成项目初始化（`specgit init`），再查看离线能力清单并预览宿主选择：

```sh
specgit setup --catalog --json
```

下面按宿主给出预览与应用命令。用 `--agent` 新选宿主时只添加该宿主的指导和
Skill；hooks 与受管只读白名单是各自独立的显式选择。

### Generic

```sh
specgit setup --agent generic --dry-run --json
specgit setup --agent generic --json
```

写入根 `AGENTS.md` 入口和规范 `.agents/skills/specgit-native/SKILL.md`。
generic 宿主没有经过验证的上下文回调，`--hook-purpose context` 会被标记为不支持。
原生 Git guard 仍在 commit/push 时生效：用
`specgit setup --agent generic --hook-purpose guard` 或
`specgit guard --install` 安装。回退：直接阅读指导与 Skill；没有宿主回调时，
CLI 和 guard 仍可使用。

### Claude Code

```sh
specgit setup --agent claude --dry-run --json
specgit setup --agent claude --json
specgit setup --agent claude --hook-purpose context --dry-run --json
specgit setup --agent claude --hook-purpose context --json
specgit setup --agent claude --readonly-permissions --dry-run --json
specgit setup --agent claude --readonly-permissions --json
```

Claude Code 获得根 `CLAUDE.md` 入口、规范 `.agents` Skill，以及供宿主发现的
`.claude/skills/specgit-native/SKILL.md` 副本。上下文 hooks 写入
`.claude/settings.json`。可选受管白名单把固定的 `Bash(specgit <argv> *)` 规则
追加到 `permissions.allow`，保留用户规则及其顺序。它只减少提示，不是沙箱或授权
边界：写命令仍会提示，`pr --status`、`doctor`、`watch`、`inbox`、`migrate` 和
`remove --apply` 不在白名单内；写入规则也不证明宿主已加载。回退：hooks 不可用时
直接重读 `CLAUDE.md` 与 Skill；CLI 和 guard 仍然有效。

### Codex

```sh
specgit setup --agent codex --hook-purpose context --dry-run --json
specgit setup --agent codex --hook-purpose context --json
```

Codex 获得规范 `.agents` Skill，指导入口写入 `AGENTS.md`；若已存在非空的
`AGENTS.override.md`，则写入该文件。上下文 hooks 写入 `.codex/hooks.json`；
项目 `.codex/` 层须在宿主 `/hooks` 中信任，setup 会报告
`codex_trust: review_in_host_required`。在宿主实际导入前，注册状态为
`written_not_verified`。回退：hooks 无法信任或不可用时，直接重读指导与 Skill；
Git guard 独立生效。

### OpenCode

```sh
specgit setup --agent opencode --dry-run --json
specgit setup --agent opencode --json
# 仅自定义 fork：
specgit setup --agent opencode --opencode-claude-hooks --hook-purpose context --dry-run --json
specgit setup --agent opencode --opencode-claude-hooks --hook-purpose context --json
```

官方构建获得根 `AGENTS.md` 入口和 `.agents` Skill；上下文 hooks 不支持。支持
Claude 兼容命令 hooks 的自定义 fork 可显式选择 `--opencode-claude-hooks`
（须 `--agent opencode`），获得 `inputFormat: claude-code` 的
`.opencode/hooks.json`。适配结论只针对实际安装的构建。不支持只读白名单。回退：
直接重读指导与 Skill，并使用有界 `watch`/`inbox`；Git guard 独立生效。

## 刷新、移除与验证

普通刷新保留已记录选择；省略用途即可保留：

```sh
specgit setup --dry-run --json
specgit setup --json
specgit setup --agent claude --remove-hook-purpose context --dry-run --json
specgit setup --agent claude --remove-hook-purpose context --json
specgit setup --agent claude --remove-readonly-permissions --dry-run --json
specgit setup --agent claude --remove-readonly-permissions --json
specgit setup --uninstall --dry-run --json
specgit setup --uninstall --json
```

只读白名单的移除只作用于已记录的 Claude 注册；OpenCode、Codex 和 generic 保持
逐次审批。

逐层验证：写入文件不证明宿主已导入，导入不证明上下文已送达，两者也都不能代替
原生 Git guard。在真实宿主中检查上下文和提示行为，在真实 Git 操作中检查 guard。
整体流程见 [CLI 参考](CLI-Reference-zh)、[快速开始](Getting-Started-zh)与
[老项目升级](Upgrading-Existing-Projects-zh)。