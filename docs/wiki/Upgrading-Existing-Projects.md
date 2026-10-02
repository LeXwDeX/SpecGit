# Upgrading Existing Projects and Agent Integrations

Use the [installation guide](https://github.com/LeXwDeX/SpecGit/blob/main/docs/installation.md) to verify a stable native release and update the shared user binary. All repositories/worktrees use that operational CLI. Confirm PATH with `command -v specgit` (`Get-Command specgit` on Windows) and `specgit --human --version`; do not pin an obsolete 2.1.x release.

For a v2 project, retain its existing declaration and preview/apply the refresh in the target repository:

```sh
specgit init --check --json
specgit init --dry-run --json
specgit init --json
specgit status --json
```

Resolve reported capability choices explicitly; do not ignore diagnostics. Since 2.2 the SpecGit-owned exclusion block contains only `.specgit.yaml`; other repository/user ignore rules still apply. Review AGENTS/CLAUDE under repository policy. Select native Issues again on the original branch for older adoption-only checkpoints; do not delete or rewrite another branch's checkpoint.

For v1 use the [explicit migration guide](https://github.com/LeXwDeX/SpecGit/blob/main/docs/migration-v2.md), not retired `init --force`, `finish` or `bind`. Replacing the binary does not migrate the project.

Register only the active host. Since 2.4 setup is permanently project-only:
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

Preserve existing settings, actual host guidance, manual edits and foreign
hooks. Codex/Claude have managed hooks; the official OpenCode build receives
skill/guidance only — a custom OpenCode fork can opt in to claude-code-format
project hooks with `--opencode-claude-hooks` (requires `--agent opencode`); the
generated hooks have no asynchronous observer, so observe manually with bounded
`watch`. Do not copy Claude settings hooks into an unverified OpenCode
integration. Written registration is not proof of import, event triggering or
notification delivery; reload and verify where needed.

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
