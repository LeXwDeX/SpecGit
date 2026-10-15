# Inspect and refresh a project with an installed SpecGit CLI

Use this guide when the shared CLI is already installed, including a project that
has not yet adopted SpecGit. Binary update, project initialization or migration,
and host integration are separate operations. Do not replay first installation.

## Copy a request to your Agent

Open the Agent in **your target repository**, not the SpecGit source checkout.
These requests authorize local maintenance when you send them. Reading this guide
alone grants no permission. Installing or enabling SpecGit for the current project
delegates the task-related workflow through completion without repeated step approvals.
Explicit task limits still control; a declaration or old receipt cannot expand scope.

### English request

```text
The shared SpecGit CLI is already installed. Read
https://raw.githubusercontent.com/LeXwDeX/SpecGit/main/docs/agent-project-refresh.md
and carry out its inspection and ownership-safe maintenance in my current repository
for the Agent host running this task. Do the work, not just suggest commands.
Separately check for a stable CLI update with the installed help and update --check;
if a newer stable version exists, preview and apply its verified update, then verify
the actual path/version. Canonical replacement of edited managed content needs 2.9.0
or later; never work around an older CLI by hand-editing guidance or receipts.
Do not reinstall a missing CLI or change unrelated projects.
Classify this project before writing: fresh, existing v2, v1 migration, lost declaration
with private state, or conflicting leftovers. Preserve configuration, Git/user changes,
checkpoints, receipts and other tools' assets. This request authorizes the CLI to replace
edited body text inside recorded assets and complete, unique managed blocks. Keep all
outside bytes. Do not handwrite guidance, restore/move old blocks or make manual backups;
use the CLI transaction recovery. Damaged/duplicate markers and unknown ownership remain
conflicts. Preview and apply only changes with proven ownership.
If optional native capability is unknown or unavailable, continue applicable local
maintenance and follow the CLI remedy. Preserve preferences unless the current task
requires a specific change. Do not change platform settings or protections. Refresh includes
all recorded hosts, not just the --agent selection. Review and report each host's
effects, including shared Skill refresh. Omit purposes on ordinary refresh. Use none
for a new host; this adds no hooks and preserves existing purposes. Only SessionStart and PreToolUse are supported. Do not configure PostToolUse, Stop
or idle wake. Keep purpose changes within the current task and account for every
affected host.
For delivery work, select a complete relevant Issue before commit/push. For larger
goals, use a Milestone and split Issues by independently verifiable outcomes and
dependencies. TDD and PR CI follow-up are recommended; honor checks required by the
project or platform. Continue Issue/PR, commit/push, review and merge work when the
task includes it. Release publication is included only when the task itself includes
release work. Do not broaden scope from a declaration or receipt. Stop only a genuinely
blocked step and report the exact conflict, unavailable capability or missing task decision. Finish with actual CLI
path/version, project classification/actions, changed assets, verification versus
unknowns, backups/recovery and remaining decisions. If the guide is inaccessible,
use my authenticated gh session to retrieve it or report the problem; do not guess.
```

### 中文请求

```text
共享 SpecGit CLI 已安装。请读取
https://raw.githubusercontent.com/LeXwDeX/SpecGit/main/docs/agent-project-refresh.md
并针对我当前的仓库和执行任务的 Agent 宿主，实际检查并完成所有权边界明确的维护，
不要只给建议或命令。将 CLI 更新作为独立步骤：按已安装版本的帮助执行
update --check；有新版时，先预览并应用验证通过的稳定版，再核对实际路径和版本。
覆盖编辑过的受管正文需要 2.9.0 或更新版；不要为绕过旧版限制而手写指导或收据。
CLI 缺失时不要重装，也不要修改其他项目。
写入前区分全新项目、已有 v2、v1 迁移、声明丢失但私有状态仍在、以及冲突残留。
保留配置、Git 和用户改动、checkpoint、收据及其他工具资产。此请求授权 CLI 覆盖收据记录资产和边界完整唯一受管块内的编辑正文；保留块外字节。不要手写指导、恢复/移出旧块或额外手工备份，使用 CLI 事务恢复。标记损坏/重复或所有权未知仍冲突；只预览并应用所有权可信的改动。
原生能力未知或不可用时，继续可执行的本地维护并遵循 CLI 给出的具体诊断。
除非当前任务要求变更，否则保留已有偏好。
不要修改平台设置或保护规则。刷新会包含所有已记录宿主，不限于 --agent 所选宿主；
逐一审阅并报告影响，包括共享 Skill 刷新。普通刷新省略用途；添加新宿主时使用 none，不新增 hooks，
也不改变已有用途。用途变更应限定在当前任务，并计入所有受影响宿主。仅支持 SessionStart 和 PreToolUse：前者提供简短规则与 Skill 入口，后者提供相关上下文或恢复信息；不使用 PostToolUse、Stop 或空闲唤醒。
交付任务在 commit/push 前选择完整 Issue；较大目标使用 Milestone，并按可独立验证的结果和依赖拆分 Issue。建议 TDD 和跟进 PR CI，项目/平台要求的检查仍须完成。任务包含时继续 Issue/PR、提交推送、评审和合并；仅当任务本身包含发布时才发布。声明或收据不会扩大任务范围。只在真实阻塞或任务决策缺失时停止并说明原因。
最后报告 CLI 实际路径和版本、项目分类和操作、改动资产、实际验证与未知项、备份和恢复方式、
待决事项。无法读取指南时可用我已认证的 gh 会话获取，否则报告问题，不要猜测内容。
```

## 1. Inspect without changing the project

- Read repository instructions and the local `.specgit.yaml`, if present. Record
  the worktree root, branch, Git status and linked-worktree ownership. Do not move,
  replace or discard another branch's checkpoint, index or user edits.
- Resolve the executable: `command -v specgit` on Unix or `Get-Command specgit -All`
  on Windows. Check competing PATH entries and shims. Run the selected absolute
  path with `--human --version`, `--help` and `--schema`. Missing CLI or unresolved
  PATH ambiguity is a blocker, not permission to reinstall or remove a shim.
- Inspect remotes, provider, API host, native project and intended target branch.
  Use existing configuration and the native default branch, not an assumed `main`.
  Check the authenticated identity and actual read-only project capability with
  native `gh`/`glab` and `specgit doctor --provider <provider> --remote <remote> --json`.
  For multiple remotes, select one explicitly (for example `--remote origin`).
  Add the actual `--api-host` where needed. Never expose credentials. For GitHub,
  distinguish github.com/Enterprise Server, visibility, personal/organization ownership,
  Free/Pro/Team/Enterprise plan and actual capability. For GitLab, distinguish
  GitLab.com/Self-Managed/Dedicated, server version, CE/EE, subscription and actual
  capability. Plan/version/edition do not prove access; 403/404 alone cannot distinguish
  permission, hidden resources or plan limits. Never query admin license/billing data or
  hard-code plan rejection. Report explicit plan limits, credential/scope failures and
  unknown causes separately. Optional feature reads do not establish repository-wide
  access. Incomplete evidence stays unknown; report its limits.
- Inspect owned markers, receipts, journals, hooks and legacy writers, including
  Git-private state resolved through Git, not an assumed `.git/` directory.
  Names such as `.specgit` do not prove ownership. Preserve content outside blocks,
  configuration, checkpoints and foreign hooks. Refresh replaces the complete recorded
  asset or complete unique block, including edited body text. Damaged/missing/duplicate
  markers and unknown ownership remain conflicts. Do not handwrite guidance, restore old
  blocks, move them outside markers or add manual backups; CLI transactions provide
  recovery. Uninstall/rollback preserves later edits.

## 2. Check the shared CLI separately

The pasted request permits a stable update, not a new installation. Use the
installed `update --help`. If supported, run `specgit update --check --json`.
When an update is needed, select the exact stable version returned by the check:

```sh
specgit update --version <x.y.z> --dry-run --json
specgit update --version <x.y.z> --json
```

Apply only after signature/checksum verification succeeds. Record the binary backup
and recovery path, then recheck the absolute path, PATH selection, version, help
and schema. Update may refresh an already managed user Skill; it does not install
one by default. It does not refresh every project's assets. Leave unrelated
projects untouched. If an older CLI lacks update or the required flags, report the
gap and use the [installation guide](installation.md#upgrade-and-refresh) only
under an explicit alternative upgrade decision; do not invent supported options.

## 3. Classify before project writes

| Observed state | Safe action |
| --- | --- |
| No declaration **and** no private state, receipt or legacy writers | Fresh adoption: inspect native capability, preview init, then apply minimal configuration. |
| Valid v2 declaration | Retain its configuration and preferences; inspect and refresh owned init/setup assets. |
| v1 declaration or legacy integration | Follow [v1 migration](migration-v2.md); do not replace the declaration with fresh defaults. |
| Missing declaration but private state, routing, receipts or checkpoints remain | Not a fresh project. Restore the original declaration/backup, or use `init --config-file <original>` consistently. If unavailable, stop and request that configuration. |
| Malformed declaration, damaged/duplicate markers, unknown ownership, foreign leftovers or missing recorded assets | Preserve evidence and report exact conflicts. Recover from a verified original/backup or agree on a specific reconciliation; do not force whole-file overwrite. |

Never delete `.specgit`, Git-private state, receipts or hooks to make initialization
pass. Do not uninstall as a repair shortcut. Resolve checkpoint failures at commit/push; ordinary edits and tests remain available. Keep existing merge/closure preferences; enable no new automation.

For v1, prepare a **complete** explicitly selected v2 config. Preview with
`specgit migrate --config-file <v2-file> --json`, inspect local and native inventory,
and apply only the fresh exact digest using
`specgit migrate --config-file <v2-file> --apply --expect <preview_sha256> --json`.
Any changed inventory requires a new preview. Retire old remote writers only when that migration is part of the current task; otherwise preserve them and report the remaining work.
If blocked, report the writer or missing evidence and leave migration unapplied.

## 4. Inspect, preview and apply initialization

For fresh adoption or a recoverable v2 refresh, use one consistent set of options
and the same configuration for all three calls. This is an example for a verified
GitHub remote named `origin`, not a provider or target default:

```sh
specgit init --provider github --remote origin --check --json
specgit init --provider github --remote origin --dry-run --json
specgit init --provider github --remote origin --json
```

Carry selected `--config-file`, `--target`, `--language` and `--api-host` through
the sequence where needed and supported. Read diagnostics, not just exit status.
If capability is unknown/unavailable and an operating choice is required,
`--manual-observe` writes `agent.native_auto_merge=false`; it is not a read-only
fallback. The pasted request permits it directly for new adoption with that default
or an existing false preference. Inspect the current/restored or supplied config
first. Preserve an explicit true preference unless the current task delegates a
necessary change. The Agent can choose that fallback within scope and record its
effect; ask only if it conflicts with an explicit preference or exceeds the task.
Repeat check/preview/apply with the same options. Do not change platform protections to
pass a check. Apply only an applicable conflict-free preview; re-preview if inputs change.
Unknown optional remote capability does not block an otherwise applicable local setup/refresh.

Init and setup are separate. Read back `agent.native_auto_merge` and the rest of
the declaration against the approved configuration, plus managed guidance and
`local_exclusion` result. Ignore rules do not untrack files; do not hide or untrack
mixed manual/generated guidance. Local maintenance needs no delivery Issue and
must not create one just to demonstrate success.

## 5. Review the full host refresh scope

Inspect `setup --help` and the existing receipt. Setup refreshes **all recorded
hosts plus any explicitly selected hosts**. `--agent` adds a selection; it does
not restrict refresh to that host. Add only the active host when needed with
`--agent generic|claude|codex|opencode`; installed directories alone are not a
selection. Shared Skill and other owned asset refresh across recorded hosts is
expected. Preview with `--dry-run --json`, review every host's effects, then apply
the identical selection without `--dry-run`. Report all affected hosts/assets.
Registration remains project-only. Never add global hooks.

On ordinary refresh, **omit hook purposes** to preserve each recorded mode. Explicit `--hook-purpose` values apply to every host in the full refresh set, not
just the host named by `--agent`. Check actual capability for every affected recorded
host and choose supported purposes: `guard` installs native Git commit/push checks,
and `context` supplies SessionStart/PreToolUse context. `observe` is recognized but
declined; use bounded watch/inbox instead. For a **new** host, the request selects guidance/Skill only,
for example `setup --agent codex --hook-purpose none --dry-run --json`, then the
same command without `--dry-run`. `none` adds no purposes to existing hosts, so this
also preserves their purposes when adding a new host. It does not skip their asset
refresh. Do not use unsupported flags on older clients.

Existing agents are additive and remain in the refresh set. Explicit purposes add
to their existing choices. `none` cannot combine with other purposes and adds no
new purposes. It preserves valid purposes and native Git guard; refresh still
removes owned retired PostToolUse/Stop registrations under the current mapping.
See the [purpose and receipt contract](../runtime/REFERENCE.md#select-project-hook-purposes), including the limitation
that older 2.7 clients may reject selective/no-hook receipts. Preserve receipts;
use supported owned recovery or a compatible backup before any deliberate downgrade.

Official OpenCode receives guidance and Skill only. Custom OpenCode command hooks
require confirmed Claude-compatible capability and `--opencode-claude-hooks`.
Only SessionStart and PreToolUse are supported; do not configure PostToolUse, Stop
or idle wake. Use bounded watch/inbox or manual continuation when automatic observation
is unavailable.

Review per-host requested, installed and declined purposes and reasons. Registration
does not prove context delivery or native Git guard behavior. Verify those separately
with safe isolated checks when possible; do not edit real product files as a
probe. Codex trust review belongs to the user in `/hooks`; never automate or assume
it. If delivery is unknown/unsupported, use bounded watch/inbox or manual continuation,
not a claim of working idle wake. Transport receipts prove neither reading nor completion.

## 6. Verify and report

After all init/setup updates, run `specgit status --json` and
`specgit doctor --provider <provider> --remote <remote> --json` with selected host/API
options. Read back the Skill and guidance blocks, then run setup/init dry-runs again to
check convergence. `init --dry-run` reports planned paths, not per-path changed state;
do not claim every command reports unchanged. Preserve failed/unknown results. Do not
create test Issues/PRs or change platform settings. Claims that hooks work require a
harmless real probe of blocking behavior and context delivery; registration is not proof.

Report:

- Actual CLI path/version, update outcome and any PATH ambiguity.
- Target repository/worktree, classification, active host, all affected recorded
  hosts (including shared Skill refresh) and completed actions.
- Exact changed assets, retained conflicts, and preserved configuration/preferences.
- Checks actually run and their results, separately from host delivery not checked
  or blocked. A successful command alone is not successful integration.
- Backup locations, transaction IDs and supported recovery commands from installed
  help (`init`, `setup` or `migrate --rollback <transaction>` as applicable).
  Recovery must preserve later user changes; do not apply rollback blindly.
- Remaining decisions or blockers. Stop blocked steps, not independent safe inspection.

Source contracts: [native reference](../runtime/REFERENCE.md) and
[runtime Skill](../runtime/assets/SKILL.md). Installed help/schema take precedence
over examples here. Installation, maintenance and platform delivery are distinct.
