# Getting Started: Agent Installation and Project Initialization

SpecGit is installed through the coding agent. The agent reads the
[installation guide](https://github.com/LeXwDeX/SpecGit/blob/main/docs/agent-install.md),
verifies the signed release and selects capabilities for the target project. The
supported release channel and signature/SHA-256 evidence are documented in the
[agent reference](https://github.com/LeXwDeX/SpecGit/blob/main/docs/installation.md).

**Already installed?** Open the Agent in the target repository and copy the
[English maintenance request](https://github.com/LeXwDeX/SpecGit/blob/main/docs/agent-project-refresh.md#english-request)
([中文请求](https://github.com/LeXwDeX/SpecGit/blob/main/docs/agent-project-refresh.md#中文请求)).
It asks the Agent to inspect and perform safe project maintenance, including fresh
adoption, rather than repeat installation. It covers stable CLI updates separately
and preserves configuration, checkpoints and receipts. Missing declaration plus
private state is not a fresh project; restore the original configuration, never delete state.

## 1. Install through the coding agent

Use the current [agent installation guide](https://github.com/LeXwDeX/SpecGit/blob/main/docs/agent-install.md)
for the target machine and repository. It covers signed Release verification,
shared CLI setup, project initialization and optional host integration. A source
build is a maintainer/development workflow and is not the end-user installation path.

## 2. Initialize the target project

Go to the **target Git repository root** and inspect its worktree, remotes, and existing declaration. Repository operations need Git and authenticated `gh` (GitHub) or `glab` (GitLab); successful help output does not prove forge access.

```sh
cd /path/to/your-project
git status --short --branch
git remote -v
ls -la .specgit.yaml AGENTS.md CLAUDE.md 2>/dev/null
```

This example uses GitHub and a remote named `origin`. Inspect capabilities and preview the plan first. Run the final write command only after the preview is applicable and has no unresolved conflicts:

```sh
specgit init --provider github --remote origin --check --json
specgit init --provider github --remote origin --dry-run --json
specgit init --provider github --remote origin --json
```

`--check` inspects the project and native capabilities; `--dry-run` previews proposed writes. Neither initializes the project. With multiple Git remotes, use `--remote` to select the intended forge remote; omit it when a single remote is unambiguous. Do not assume the target branch is `main` from this example: let the command read the actual default branch, or pass `--target` when the project's selected target requires it. For GitLab use `--provider gitlab`; add `--api-host` when an actual self-hosted API requires it.

If native support is unknown or unavailable, manual observation is one operating
choice. `--manual-observe` writes `agent.native_auto_merge=false`. For new/default-false
or existing-false configuration, the copied request already selects it. Preserve configured preferences unless a specific change is required by the current
task. Use consistent options/configuration in check, preview and apply, then read back
the preference. Do not alter
platform settings under this maintenance request or ignore conflicts. Initialization
maintains `.specgit.yaml`, managed guidance and Git's local exclusion record; preserve
content outside managed blocks in `AGENTS.md` and `CLAUDE.md`.

Read back the configuration and status afterward:

```sh
cat .specgit.yaml
git status --short
specgit status --remote origin --json
specgit doctor --provider github --remote origin --json
```

For an existing **v2** project, retain its declaration and use the same inspect, preview, and apply sequence to refresh it; do not overwrite manual configuration. Migrate an existing **v1** project using the [explicit migration guide](https://github.com/LeXwDeX/SpecGit/blob/main/docs/migration-v2.md) first. Replacing the executable does not migrate a project. The old `init --force`, `finish`, and `bind` commands are retired.

## 3. Register a host only when needed

For hook selection and actual host verification, follow the
[maintenance guide](https://github.com/LeXwDeX/SpecGit/blob/main/docs/agent-project-refresh.md#5-review-the-full-host-refresh-scope).
Only SessionStart and PreToolUse are supported: SessionStart gives brief rules and
the Skill entry; PreToolUse provides relevant context or recovery. Do not configure
PostToolUse, Stop or idle wake. `guard` configures native Git commit/push hooks. If
automatic observation is unavailable through supported events, use bounded watch/inbox
or continue manually. Setup includes all recorded hosts plus the `--agent` selection;
review/report every host's effects, including shared Skill refresh.

Project initialization **does not register any host**. When you select a host with `setup --agent`, a new host receives project guidance and the Skill only. To opt into hooks, add `--hook-purpose guard` and/or `--hook-purpose context`; use `none` to keep the host hook-free. Since the 2.4 release, setup has been project-only: `--scope project` is the default and the only scope value, assets live in the checkout with a worktree-private receipt, hooks invoke the installed shared executable directly (no global setup prerequisite), and the retired global options (`--root`, `--provider`, `--api-host`, `--register-*`, per-host roots) are rejected. Installing the executable and initializing a project does not require `setup`.

See [Upgrading Existing Projects](Upgrading-Existing-Projects), [Team Workflow](Team-Workflow), and [CLI Reference](CLI-Reference).
