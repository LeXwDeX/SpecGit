# Installation

## Prerequisites

- **Node.js 20.19.0 or higher** — check with `node --version`
- **git** — SpecGit verifies deliveries against a real repository; it will not run outside one
- **GitHub CLI (`gh`)** — required for acceptance. Install and authenticate:

```bash
gh auth login
gh auth status        # should report you signed in to github.com
```

`gh` is the provider seam: SpecGit reads issues, pull requests, and check runs through it. No tokens are read, echoed, or persisted by SpecGit itself — it relies on your existing `gh` authentication.

## Install

```bash
npm install -g specgit
specgit --version
```

## Verify your environment

```bash
specgit doctor --json
```

`doctor` probes, in order: git is available, you are inside a git repository, `origin` parses to a GitHub repository, `gh` is present and authenticated, and `spec_git/policy.yaml` exists. Exit `0` means every probe passed; exit `3` reports which probe failed and how to fix it. This is the fastest way to diagnose a new setup.

## Initialize a project

In the repository root, on the default branch:

```bash
specgit init
```

Creates `spec_git/policy.yaml` and the delivery harness. Required-check names are auto-detected from CI files; a no-CI repository gets the empty list (the acceptance job itself is the gate). Choose check names with care; [GitHub Actions](actions.md) explains the naming model and the recommended aggregator pattern.

## Uninstall

Remove the CLI and, if you want the project clean of SpecGit:

```bash
npm uninstall -g specgit
specgit unbind --yes      # removes .specgit.yaml for the current delivery
git rm spec_git/policy.yaml
```

The record and policy are plain committed files; there is no hidden state to clean up.
