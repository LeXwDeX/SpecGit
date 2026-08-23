# Installation

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

Creates `spec_git/policy.yaml` and the delivery harness. Required-check names are auto-detected from CI files; a no-CI repository gets the empty list (the acceptance job itself is the gate). Choose check names with care; [GitHub Actions](actions.md) explains the naming model and the recommended aggregator pattern.

## Upgrade to a newer CLI version

After `npm install -g specgit` brings in a new version, one numbered sequence converges each repository — all local, zero forge calls:

```bash
specgit status --json          # 1. see the drift: assets.generated names every
                               #    stale / missing / conflict state and the
                               #    exact per-surface fix command
specgit init --force           # 2. converge the init-owned tier (workflow,
                               #    managed AGENTS.md block, guard hooks,
                               #    managed .gitignore region)
specgit setup --tool all       # 3. converge both agent surfaces (or the exact
                               #    per-surface command status named)
specgit status --json          # 4. assets.generated.clean must be true
                               #    (clean implies complete — an incomplete
                               #    report never claims current; resolve any
                               #    uninspected code first)
git add -A && git commit       # 5. commit the intended derived assets
```

Between 4 and 5: a `conflict` state is a file at a managed path that does not prove SpecGit ownership (no managed markers) — review it and, if it is a leftover, delete it yourself; the commands never delete unproven files. After the commit, `git status --porcelain` is empty: no generated legacy or ignored residue reappears. What "intended" means is decided by the three asset tiers — see [State and assets](reference.md#state-and-assets) and the [status reference](cli.md#specgit-status).

## Uninstall

Remove the CLI and, if you want the project clean of SpecGit:

```bash
npm uninstall -g specgit
specgit unbind --yes      # removes .specgit.yaml for the current delivery
git rm spec_git/policy.yaml
```

The record and policy are plain committed files; there is no hidden state to clean up.
