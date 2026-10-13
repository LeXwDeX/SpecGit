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
preference needs a specific decision before changing it. It does not authorize
platform settings, Issue/PR writes, commits, pushes, merges or releases.
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

Resolve reported capability choices explicitly; do not ignore diagnostics. Since 2.2 the SpecGit-owned exclusion block contains only `.specgit.yaml`; other repository/user ignore rules still apply. Review AGENTS/CLAUDE under repository policy. Select native Issues again on the original branch for older adoption-only checkpoints; do not delete or rewrite another branch's checkpoint.

After all updates, run status and doctor, read back generated Skill/guidance, then
repeat dry-runs. An init dry-run lists planned paths, not per-path changed state.
Only claim host hooks work after a harmless real behavior/context probe.

For v1 use the [explicit migration guide](https://github.com/LeXwDeX/SpecGit/blob/main/docs/migration-v2.md), not retired `init --force`, `finish` or `bind`. Replacing the binary does not migrate the project.

Add only the active host when needed. Setup also refreshes all recorded hosts;
`--agent` does not restrict refresh to that host. Review/report every host's asset
changes, including shared Skill refresh. Since 2.4 setup is permanently project-only:
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

Preserve existing settings, manual guidance outside managed blocks and foreign
hooks. Refresh replaces edited body text only inside a proven, complete managed
range. Codex/Claude have managed hooks; the official OpenCode build receives
skill/guidance only — a custom OpenCode fork can opt in to claude-code-format
project hooks with `--opencode-claude-hooks` (requires `--agent opencode`). In 2.8,
idle wake also needs explicit `--opencode-async-rewake`, confirmed real capability,
user authorization and observe/context purposes. Compatibility alone enables no
asynchronous observer; use bounded `watch` or manual continuation when delivery
is unavailable. Do not copy Claude settings hooks into an unverified OpenCode
integration. Written registration is not proof of import, event triggering or
notification delivery; reload and verify where needed.

2.8 supports repeatable `--hook-purpose guard|context|observe`, or `none` for no
new hooks. Omit purposes on ordinary refresh to preserve exact recorded modes.
Explicit purposes apply to all recorded and newly selected hosts; changes need
authorization for every affected host. `none` preserves existing purposes and never
uninstalls hooks/Git guard, but their assets can still refresh. Agents remain additive.
Choose only minimal real capability and authorized use; upgrade never silently
enables idle wake. See the guide for selective-receipt downgrade limits and checks.

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
