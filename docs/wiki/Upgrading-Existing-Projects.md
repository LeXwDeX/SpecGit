# Update the Shared CLI and Refresh an Existing Project

Use the canonical [project maintenance guide](https://github.com/LeXwDeX/SpecGit/blob/main/docs/agent-project-refresh.md)
in the target repository. It classifies fresh, existing v2, v1 migration and
conflicting states before project writes, and preserves declarations, receipts,
checkpoints, user edits and other tools' assets.

## 1. Update the shared CLI when needed

SpecGit uses one user-level native executable shared by that machine's projects
and worktrees. The supported update checks and applies a signed GitHub Release:

```sh
specgit update --check --json
specgit update --dry-run --json
specgit update --json
```

The check reads release metadata; dry-run downloads and verifies without replacing
the executable; apply replaces only the running executable and keeps a backup.
Verify `command -v specgit` and `specgit --human --version` afterward so an older
PATH entry or shim does not hide the updated binary. For prerequisites, recovery
and platform limits, follow the maintenance guide.

## 2. Refresh each project locally

The shared binary does not carry project declarations, guidance, receipts or
checkpoints between repositories. In every clone or worktree, inspect and refresh
the current project while retaining its declaration and private state:

```sh
specgit init --check --json
specgit init --dry-run --json
specgit init --json
specgit setup --catalog --json
specgit setup --dry-run --json
specgit setup --json
specgit status --json
specgit doctor --offline --json
```

Apply only a current, applicable preview. Init maintains the project declaration,
Skill, guidance and exact local exclusions; it does not install host hooks. The
default setup installs or refreshes the shared project Skill and stable guidance
entry. New setup adds no Agent hooks. Setup refreshes all recorded hosts and any
named `--agent` host, so review every affected asset before applying. A declaration
missing while private state remains is a recovery case, not fresh adoption.

## 3. Add or change a host integration only when needed

Naming a new host with `--agent` adds its guidance and Skill only. Hooks require
explicit `--hook-purpose guard` and/or `--hook-purpose context`; `none` adds no
hooks and preserves current choices. On ordinary refresh, omit purposes to keep
the recorded selection. Explicit purposes apply only to hosts named by `--agent`,
or to all recorded hosts when `--agent` is omitted. `--remove-hook-purpose guard`
or `context` removes only that purpose and follows the same host scope.

Only SessionStart and PreToolUse context hooks are supported. The `observe` purpose
is recognized but declined; use bounded `watch` or `inbox` instead. PostToolUse,
Stop callbacks and idle wake are retired. `guard` installs native Git pre-commit
and pre-push checkpoint checks. Written registration does not prove host loading
or behavior; verify the actual host and Git entry points before relying on them.

When native capability is unsupported or unknown and an operating choice is required,
manual observation is an init choice; `--manual-observe` writes `native_auto_merge=false`.
Keep an explicit true preference unless the current task delegates a necessary change.
Do not change platform settings to make initialization pass.

## 4. Migrate or remove deliberately

For a v1 project, use the [v1-to-v2 migration guide](https://github.com/LeXwDeX/SpecGit/blob/main/docs/migration-v2.md)
before replacing its declaration or lifecycle. To remove one recorded hook purpose,
use `--remove-hook-purpose` with a reviewed preview. `setup --uninstall` removes all
recorded integrations in the current worktree. Full project integration removal uses
`specgit remove`; see the [removal and rollback
reference](https://github.com/LeXwDeX/SpecGit/blob/main/docs/installation.md#removal-and-rollback).

See [Getting Started](Getting-Started), [Team Workflow](Team-Workflow), and [CLI Reference](CLI-Reference).
