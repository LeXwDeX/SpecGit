# Installation

```text
  specgit init / setup      once per repository: policy + acceptance
        |                   harness + agent entry points
        v
  specgit issue "..."       per delivery: issues + branch +
        |                   draft PR (Closes #n) + record,
        |                   committed and pushed (idempotent resume)
        v
  work, commit, push -----> CI on the PR head
        |                   (the SpecGit Acceptance job runs
        |                    specgit finish --json)
        v
  gh pr ready <n>           a draft PR always fails the verdict
        |
        v
  specgit finish            the verdict: eleven gates, fail-closed
        |-- exit 0 --> accepted -> merge -> confirmed issue closure: completed
        |-- exit 1 --> fix what the gates named (evidence complete)
        '-- exit 3 --> fix the environment first (specgit doctor)
```

## Prerequisites

- **Node.js 20.19.0 or higher** — check with `node --version`
- **git** — SpecGit verifies deliveries against a real repository; it will not run outside one
- **GitHub CLI (`gh`)** — required for GitHub acceptance. Install and authenticate:

```bash
gh auth login
gh auth status        # should report you signed in to github.com
```

- **GitLab CLI (`glab`)** — required only when the repository lives on a declared
  self-managed GitLab host (>= 1.113.0; per-host auth):

```bash
glab auth login --hostname git.example.com
glab auth status --hostname git.example.com
```

The forge CLI is the provider seam: SpecGit reads issues, pull requests, and check runs through `gh` (GitHub) or `glab` (GitLab). No tokens are read, echoed, or persisted by SpecGit itself — it relies on your existing authentication.

## Install

```bash
npm install -g specgit
specgit --version
```

## Verify your environment

```bash
specgit doctor --json
```

`doctor` probes, in order: git is available, you are inside a git repository, `origin` parses to a forge repository (or a declared GitLab host), the matching forge CLI is present and authenticated, and `spec_git/policy.yaml` exists. Exit `0` means every probe passed; exit `3` reports which probe failed and how to fix it. This is the fastest way to diagnose a new setup.

## Initialize a project

In the repository root, on the default branch:

```bash
specgit init
```

Creates `spec_git/policy.yaml` and the delivery harness. Required-check names are auto-detected from CI files — only names static reading can prove; matrix fan-out and reusable-workflow calls are reported as ambiguous, never guessed (#310). A no-CI repository gets the empty list (the acceptance job itself is the gate). Choose check names with care; [GitHub Actions](actions.md) explains the naming model and the recommended aggregator pattern.

Local initialization does not itself require an issue, PR, product build or
release. Review the tracked changes before deciding to share the SpecGit
workflow or project rules; [CI scope](ci-scope.md) distinguishes shared adoption
from local maintenance. Init/setup preserve the project's business workflows,
build commands and dependencies, but can update shared agent files and hooks.

## Upgrade to a newer CLI version

After `npm install -g specgit` brings in a new version, refresh the installed
surfaces and inspect the result. `status` and `setup` are local; `init` can make
forge probes or protection changes, so `--no-protect` skips the protection step.
Preserve the user's automation choice when supplying `--automation` in scripts.

```bash
specgit status --json          # 1. see the drift: assets.generated names every
                               #    stale / missing / conflict state and the
                               #    exact per-surface fix command
specgit init --force --no-protect # 2. converge the init-owned tier (workflow,
                               #    managed AGENTS.md block, guard hooks,
                               #    managed .gitignore region) — the policy's
                               #    required checks and language are PRESERVED;
                               #    pass explicit --required-check to replace them
specgit setup --tool generic   # 3. use the exact installed surface status named;
                               #    opencode or all when those are intended
specgit status --json          # 4. assets.generated.clean must be true
                               #    (clean implies complete — an incomplete
                               #    report never claims current; resolve any
                               #    uninspected code first)
git diff                      # 5. inspect tracked changes before choosing to share
```

Review any `conflict` before removing a file: retirement removes only proven
SpecGit-owned assets. Current canonical generated files are refreshed by their
writers, so review local customizations before running the upgrade. Commit only
the shared changes the user intends, using a delivery when required; local
maintenance alone stops after verification and does not require CI or release.
See [State and assets](reference.md#state-and-assets) and [CI scope](ci-scope.md).

## Uninstall

To remove only the globally installed CLI:

```bash
npm uninstall -g specgit
```

This leaves project integration assets in place. For full project removal,
first retire the shared acceptance/protection requirements deliberately, then
run `specgit unbind --yes` while the CLI is still installed if abandoning the
current binding. Remove SpecGit-owned workflow, policy/provider files, managed
AGENTS/CLAUDE blocks, agent entry points and hook entries while preserving user
content. Inspect the effective Git hooks directory (`git rev-parse --git-path
hooks`), which may be shared through `core.hooksPath` or linked worktrees.
Uninstall the CLI last. There is currently no automatic project-uninstall command.

Removing the CLI or policy does not disable the installed Git pre-push guard.
An agent host that invokes the merge guard can also remain blocked when the CLI
or policy is missing. Review those integrations as part of removal; deleting
only `spec_git/policy.yaml` does not uninstall SpecGit from the project.
