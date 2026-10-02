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

Register only the active host. This Codex example uses `--register-codex`; Claude uses `--register-claude`, OpenCode `--register-opencode`:

```sh
specgit setup --provider github --register-codex --dry-run --json
specgit setup --provider github --register-codex --json
```

Preserve existing settings and actual host roots. Codex/Claude have managed hooks; OpenCode here receives skill/guidance only. Do not copy Claude settings hooks into an unverified OpenCode integration. Written registration is not proof of import, event triggering or notification delivery; reload and verify where needed.

When repository policy requires Git enforcement, `specgit guard --install --json` installs both owned blocks while preserving existing hooks. `guard --uninstall` removes only those blocks.

`setup --uninstall` removes the selected global user-level assets, affecting that user integration across projects; `setup --scope project --uninstall` removes only the current worktree's recorded project agent assets; `init --rollback <transaction>` undoes only that project transaction. 2.2 had no general project remove command; 2.3 introduces `specgit remove` (preview, digest-bound apply, offline rollback) to retire one project's whole local integration. See [removal boundaries](https://github.com/LeXwDeX/SpecGit/blob/main/docs/installation.md#removal-and-rollback).
