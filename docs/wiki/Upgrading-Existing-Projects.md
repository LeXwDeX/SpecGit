# Upgrading Existing Projects and Agent Integrations

**Shared CLI already installed:** use the canonical
[project maintenance guide](https://github.com/LeXwDeX/SpecGit/blob/main/docs/agent-project-refresh.md).
Open your Agent in the target repository and copy its
[English request](https://github.com/LeXwDeX/SpecGit/blob/main/docs/agent-project-refresh.md#english-request)
or [中文请求](https://github.com/LeXwDeX/SpecGit/blob/main/docs/agent-project-refresh.md#中文请求)
to request actual inspection and ownership-safe maintenance, not installation replay.
The request authorizes a separate verified stable update when needed. Unknown optional
capability does not block applicable local maintenance. Init chooses manual observation
only with new/default-false or existing-false `native_auto_merge`. The flag sets it to false; an existing true
preference needs a specific decision before changing it. Installation/enablement delegates the task-related workflow without repeated approvals.
Explicit task limits remain controlling; a declaration or old receipt cannot expand scope.
Release publication is included only when the task itself includes it.
Confirm the actual CLI path/version; do not silently reinstall if missing.

Before the abbreviated v2 sequence below, classify the project using that guide.
A missing declaration with private state is not fresh adoption: restore its original
configuration/backup. Preserve configuration, receipts, checkpoints, outside-block
edits and foreign assets; complete uniquely marked managed content refreshes to the
current template even if edited. Never delete state or hooks to force a refresh. Carry the same selected configuration,
remote and capability options through inspection, preview and apply.

For a v2 project, retain its existing declaration and preview/apply the refresh in the target repository:

```sh
specgit init --check --json
specgit init --dry-run --json
specgit init --json
specgit status --json
```

Resolve reported capability choices explicitly; do not ignore diagnostics. Run
`specgit init` in every clone and worktree: the declaration, common Skill and
private records are local and do not travel with Git. Init installs the common
`.agents/skills/specgit-native/SKILL.md` and stable guidance entry points, but does
not install host hooks. Its Git-local `info/exclude` block covers `.specgit.yaml`
and the generated `.agents/skills/specgit-native/SKILL.md`; it adds
`.claude/skills/specgit-native/SKILL.md` only when Claude is selected. A v1
migration can carry forward legacy exclusion rules, so run init afterward to
reconcile current local assets. Rules retained for another initialized worktree
can keep a selected Claude Skill excluded. Review AGENTS/CLAUDE under repository
policy. Select native Issues again on the original branch for older adoption-only
checkpoints; do not delete or rewrite another branch's checkpoint.

After all updates, run status and doctor, read back generated Skill/guidance, then
repeat dry-runs. An init dry-run lists planned paths, not per-path changed state.
Only SessionStart and PreToolUse are supported: brief starting rules/Skill entry, then relevant context/recovery. Do not configure PostToolUse, Stop or idle wake. Only claim hooks work after a harmless behavior/context probe.

For v1 use the [explicit migration guide](https://github.com/LeXwDeX/SpecGit/blob/main/docs/migration-v2.md), not retired `init --force`, `finish` or `bind`. Replacing the binary does not migrate the project.

Add only the active host when needed. Initialization installs the common project
Skill and stable guidance entries; it does not install host hooks. Setup selects
host-specific assets and also refreshes all recorded hosts; `--agent` does not
restrict refresh to that host. Review/report every affected host's asset changes.
Since 2.4 setup is permanently project-only:
`--scope project` is the default and the only scope value, hooks invoke the
installed shared executable directly with no global setup prerequisite, and the
retired global options (`--root`, `--provider`, `--api-host`, `--register-*`,
per-host roots) are rejected. This Codex example uses `--agent codex`; Claude
uses `--agent claude`, OpenCode `--agent opencode`, generic `.agents` hosts
`--agent generic`:

```sh
specgit setup --agent codex --dry-run --json
specgit setup --agent codex --json
```

Stable guidance entry points are root `AGENTS.md` for generic and official
OpenCode, root `CLAUDE.md` for Claude, and root `AGENTS.md` or an existing
nonempty `AGENTS.override.md` for Codex. Each points to the canonical
`.agents/skills/specgit-native/SKILL.md`; Claude also gets
`.claude/skills/specgit-native/SKILL.md` for host discovery.

Preserve existing settings, manual guidance outside managed blocks and foreign
hooks. Refresh replaces edited body text only inside a proven, complete managed
range. Managed hooks provide only SessionStart and PreToolUse. Do not register PostToolUse,
Stop callbacks or idle wake. Use bounded watch/inbox or manual continuation when
automatic observation is unavailable. Do not copy Claude settings hooks into an unverified OpenCode
integration. Written registration is not proof of import, event triggering or
notification delivery; reload and verify where needed.

Use only supported SessionStart and PreToolUse hooks; `guard` configures native
commit/push checks, while `context` supplies relevant context/recovery. Omit purposes on ordinary refresh to preserve exact recorded modes.
Explicit purposes apply to all recorded and newly selected hosts within the current
task. `none` adds no purposes and preserves valid purposes/native Git guard, while
refresh removes owned retired PostToolUse/Stop registrations. Hosts remain additive.
Choose only purposes supported by the host and needed in the current task. See the guide for selective-receipt downgrade limits and checks.

Upgrading from 2.3: existing project receipts are refreshed into the 2.4
format (which omits `shared_root`) locally, preserving foreign content and
without reading or writing the retired global root. 2.3 global data stays
preserved; 2.4 ships no global cleanup command — back up first and use the 2.3
CLI's exact owned cleanup before upgrading if it must go, never a blind delete.

When repository policy requires Git enforcement, `specgit guard --install --json` installs both owned blocks while preserving existing hooks. `guard --uninstall` removes only those blocks.

`setup --uninstall` removes only the current worktree's recorded project agent
assets (2.4 has no global user-level setup to uninstall); `init --rollback
<transaction>` undoes only that project transaction. 2.2 had no general project
remove command; 2.3 introduces `specgit remove` (preview, digest-bound apply,
offline rollback) to retire one project's whole local integration. See
[removal boundaries](https://github.com/LeXwDeX/SpecGit/blob/main/docs/installation.md#removal-and-rollback).
