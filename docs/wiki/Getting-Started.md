# Getting Started: Agent Installation and Project Initialization

Install one shared native CLI for this machine, then initialize each target
repository or worktree separately. Use the [Agent installation guide](https://github.com/LeXwDeX/SpecGit/blob/main/docs/agent-install.md)
for a new installation. It downloads only signed packages from GitHub Releases,
verifies the signature and SHA-256, and checks the selected executable. The
[release verification reference](https://github.com/LeXwDeX/SpecGit/blob/main/docs/installation.md)
documents that contract.

**Already installed?** Open the Agent in the target repository and copy the
[English maintenance request](https://github.com/LeXwDeX/SpecGit/blob/main/docs/agent-project-refresh.md#english-request)
([中文请求](https://github.com/LeXwDeX/SpecGit/blob/main/docs/agent-project-refresh.md#中文请求)).
It handles a verified shared-CLI update separately from per-project refresh and
preserves configuration, checkpoints and receipts. Do not repeat installation or
delete private state to repair a project.

## 1. Install or update the shared CLI

Use the Agent guide for install and PATH verification. GitHub Releases are the
only public distribution channel, with signed macOS arm64, Linux x64 glibc and
Windows x64 ZIPs. The release executable needs no Node.js, npm or Rust compiler.
For an installed CLI, use the maintenance guide's signed `specgit update` flow;
the executable is shared across repositories and worktrees. Do not install a
project-local copy or build source as an end-user substitute.

## 2. Initialize each target project

Go to the **target Git repository root** and inspect its worktree, remotes and
existing declaration. Repository operations need Git and authenticated `gh`
(GitHub) or `glab` (GitLab); successful help output does not prove forge access.

```sh
cd /path/to/your-project
git status --short --branch
git remote -v
ls -la .specgit.yaml AGENTS.md CLAUDE.md 2>/dev/null
```

This example uses GitHub and a remote named `origin`. Inspect native capabilities
and preview the project declaration before applying it:

```sh
specgit init --provider github --remote origin --check --json
specgit init --provider github --remote origin --dry-run --json
specgit init --provider github --remote origin --json
```

`--check` reads project and native capabilities; `--dry-run` previews local writes.
Neither initializes the project. Select the actual forge remote and provider; for
GitLab use `--provider gitlab`, adding `--api-host` only for a self-managed API.
Do not assume the target branch is `main`.

If native capability is unsupported or unknown and an operating choice is required,
`--manual-observe` accepts manual operation and writes `agent.native_auto_merge=false`.
Preserve an explicit true preference unless the current task delegates a necessary
change. Keep options and configuration consistent across check, preview and apply. Init maintains the project declaration and
project guidance; it does not install host hooks.

After initialization, read back the declaration and local status:

```sh
cat .specgit.yaml
git status --short
specgit status --remote origin --json
specgit doctor --provider github --remote origin --json
```

For an existing v2 project, retain its declaration and use the maintenance
guide's inspect, preview and apply sequence. For v1, follow the [migration guide](https://github.com/LeXwDeX/SpecGit/blob/main/docs/migration-v2.md)
first; replacing the executable does not migrate project state.

## 3. Install project guidance and optional host integration

`specgit setup --catalog --json` lists offline integration capabilities without
reading or changing the project. Review setup's plan before applying:

```sh
specgit setup --dry-run --json
specgit setup --json
```

The default setup installs or refreshes the shared project Skill and stable
guidance entry; a new setup adds no Agent hooks. Naming a new host with `--agent`
adds its guidance and Skill only. To opt into hooks, explicitly pass
`--hook-purpose guard` and/or `--hook-purpose context`. Omit purposes on ordinary
refresh to preserve recorded choices. Setup refreshes all recorded hosts plus any
named `--agent` host, but explicit purpose changes apply only to named hosts, or
all recorded hosts when `--agent` is omitted. `none` adds no hooks and preserves
recorded choices.

Only SessionStart and PreToolUse context hooks are supported. The legacy
`observe` purpose is recognized but declined; use bounded `watch` or `inbox`
instead. PostToolUse, Stop callbacks and idle wake are retired. `guard` adds native
Git pre-commit/pre-push checks; verify actual loading and behavior before relying
on any host integration. See the [project maintenance guide](https://github.com/LeXwDeX/SpecGit/blob/main/docs/agent-project-refresh.md#5-review-the-full-host-refresh-scope)
for host-specific setup and removal.

See [Upgrading Existing Projects](Upgrading-Existing-Projects), [Team Workflow](Team-Workflow), and [CLI Reference](CLI-Reference).
