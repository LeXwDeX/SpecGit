# Inspect and refresh a project with an installed SpecGit CLI

Use this guide when the shared CLI is already installed, including a project that
has not yet adopted SpecGit. Binary update, project initialization or migration,
and host integration are separate operations. Do not replay first installation.

## Copy a request to your Agent

Open the Agent in **your target repository**, not the SpecGit source checkout.
These requests authorize bounded maintenance when you send them. Reading this
guide alone grants no permission. Existing session authorization still applies
within its scope; do not ask for the same generic confirmation again.

### English request

```text
The shared SpecGit CLI is already installed. Read
https://raw.githubusercontent.com/LeXwDeX/SpecGit/main/docs/agent-project-refresh.md
and carry out its inspection and conflict-free maintenance in my current repository
for the Agent host running this task. Do the work, not just suggest commands.
Separately check for a stable CLI update with the installed help and update --check;
if needed, preview and apply the verified update, then verify the actual path/version.
Do not reinstall a missing CLI or change unrelated projects.
Classify this project before writing: fresh, existing v2, v1 migration, lost declaration
with private state, or conflicting leftovers. Preserve configuration, Git/user changes,
checkpoints, receipts and other tools' assets. Preview and apply only safe owned changes.
If native capability is unknown or unavailable, I choose manual observation only when
native_auto_merge is already false or this is new adoption with that default.
--manual-observe sets it to false; if the existing preference is true, ask for that specific change
before applying it. Do not change platform settings or protections. Refresh includes
all recorded hosts, not just the --agent selection. Review and report each host's
effects, including shared Skill refresh. Omit purposes on ordinary refresh. Use none
for a new host; this adds no hooks and preserves existing purposes. Any purpose change
needs my authorization for every affected host. Do not newly enable custom
OpenCode idle wake without my explicit authorization and confirmation of real capability.
This request does not authorize Issue/PR writes, commits, pushes, merges, releases,
foreign cleanup, global hooks or new merge/closure automation. Stop only the blocked
steps and report the exact conflict or missing decision. Finish with actual CLI
path/version, project classification/actions, changed assets, verification versus
unknowns, backups/recovery and remaining decisions. If the guide is inaccessible,
use my authenticated gh session to retrieve it or report the problem; do not guess.
```

### 中文请求

```text
共享 SpecGit CLI 已安装。请读取
https://raw.githubusercontent.com/LeXwDeX/SpecGit/main/docs/agent-project-refresh.md
并针对我当前的仓库和执行任务的 Agent 宿主，实际检查并完成无冲突的维护，
不要只给建议或命令。将 CLI 更新作为独立步骤：按已安装版本的帮助执行
update --check；需要稳定版更新时，先预览并验证，再应用并核对实际路径和版本。
CLI 缺失时不要重装，也不要修改其他项目。
写入前区分全新项目、已有 v2、v1 迁移、声明丢失但私有状态仍在、以及冲突残留。
保留配置、Git 和用户改动、checkpoint、收据及其他工具资产；只预览和应用安全的受管改动。
原生能力未知或不可用时，仅在 native_auto_merge 已为 false 或全新接入采用该默认值时，
我选择手动观察。--manual-observe 会将此值设为 false；原有偏好为 true 时，先询问这项具体变更再应用。
不要修改平台设置或保护规则。刷新会包含所有已记录宿主，不限于 --agent 所选宿主；
逐一审阅并报告影响，包括共享 Skill 刷新。普通刷新省略用途；添加新宿主时使用 none，不新增 hooks，
也不改变已有用途。任何用途变更都需要我授权所有受影响宿主。未经我明确授权且确认真实能力，
不要新增自定义 OpenCode 空闲唤醒。本请求不授权 Issue/PR 写入、提交、推送、合并、发布、
外部资产清理、全局 hooks 或新增合并/关单自动化。只停止受阻步骤，说明具体冲突或缺失决策。
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
  Add the actual `--api-host` where needed. Never expose credentials. For GitLab,
  distinguish deployment, server version, edition/tier and actual capability;
  neither a version nor a subscription proves access. Inaccessible stays unknown.
- Inspect owned markers, receipts, journals, hooks and legacy writers, including
  Git-private state resolved through Git, not an assumed `.git/` directory.
  Names such as `.specgit` do not prove ownership. Preserve manual content outside
  managed blocks, foreign hooks, missing recorded assets and edited managed assets.

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
| Malformed declaration, damaged markers, foreign/edited leftovers or missing recorded assets | Preserve evidence and report exact conflicts. Recover from a verified original/backup or agree on a specific reconciliation; do not force overwrite. |

Never delete `.specgit`, Git-private state, receipts or hooks to make initialization
pass. Do not uninstall as a repair shortcut. Guard failures are not permission to
bypass checkpoints. Keep existing merge/closure preferences; enable no new automation.

For v1, prepare a **complete** explicitly selected v2 config. Preview with
`specgit migrate --config-file <v2-file> --json`, inspect local and native inventory,
and apply only the fresh exact digest using
`specgit migrate --config-file <v2-file> --apply --expect <preview_sha256> --json`.
Any changed inventory requires a new preview. Retirement of old remote writers
needs separate native write authorization; the pasted request does not grant it.
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
first. If its preference is true, explain the true-to-false change and obtain that
specific decision before proceeding with the changed preview/apply sequence.
Continue independent read-only checks while waiting. Once authorized, repeat
check/preview/apply with the same options. Do not change platform protections to
pass a check. Apply only an applicable conflict-free preview; re-preview if inputs change.

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

On ordinary refresh, **omit hook purposes** to preserve each recorded mode. On 2.8,
explicit `--hook-purpose` values apply to every host in the full refresh set, not
just the host named by `--agent`. Purpose changes require capability checks and
authorization for every affected recorded host. When authorized, choose the least
purposes needed: repeat `--hook-purpose guard`, `context` or `observe`. `guard` supplies checks,
`context` supplies session/tool context, and `observe` requests bounded asynchronous
observation. For a **new** host, the pasted request selects guidance/Skill only,
for example `setup --agent codex --hook-purpose none --dry-run --json`, then the
same command without `--dry-run`. `none` adds no purposes to existing hosts, so this
also preserves their purposes when adding a new host. It does not skip their asset
refresh. Do not use unsupported flags on older clients.

Existing agents are additive and remain in the refresh set. Explicit purposes add
to their existing choices. `none` cannot combine with other purposes,
adds no hooks, and **never removes existing hooks or Git guard**. Removing hooks
needs a separate owned-removal decision. See the [2.8 purpose and receipt contract](../runtime/REFERENCE.md#select-project-hook-purposes), including the limitation
that older 2.7 clients may reject selective/no-hook receipts. Preserve receipts;
use supported owned recovery or a compatible backup before any deliberate downgrade.

Official OpenCode receives guidance and Skill only. Custom OpenCode command hooks
require confirmed Claude-compatible capability and `--opencode-claude-hooks`.
That flag alone does not enable asynchronous observation or idle wake. New idle
wake requires explicit real `asyncRewake` capability confirmation, user authorization,
`--opencode-async-rewake`, and requested `observe` plus effective `context` on
`--agent opencode`. Do not enable it merely because the CLI was upgraded. Do not
duplicate managed hooks with a Claude-hook importer.

Review per-host requested, installed and declined purposes and reasons. Registration
does not prove allow/deny, context delivery or idle delivery. Verify those separately
with safe isolated host checks when possible; do not edit real product files as a
probe. Codex trust review belongs to the user in `/hooks`; never automate or assume
it. If delivery is unknown/unsupported, use bounded watch/inbox or manual continuation,
not a claim of working idle wake. Transport receipts prove neither reading nor completion.

## 6. Verify and report

Read back changed assets and Git status. Run `specgit status --remote <remote> --json`
and `specgit doctor --provider <provider> --remote <remote> --json` with the selected
host/API options where applicable. Inspect diagnostics and preserve failed/unknown
results. No test Issue, PR, commit or platform setting change is needed.

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
