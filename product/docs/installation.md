# Installation

```text
  specgit init / setup      initialize once; rerun after upgrades
        |                   harness + agent entry points
        v
  specgit issue "..."       per delivery: issues + branch +
        |                   draft PR/MR (Closes #n) + record,
        |                   committed and pushed (idempotent resume)
        v
  work, commit, push -----> CI/CD on the request head
        |                   (the platform acceptance job runs
        |                    specgit finish --json)
        v
  mark PR/MR ready          a draft request always fails the verdict
        |
        v
  specgit finish            the verdict: eleven gates, fail-closed
        |-- exit 0 --> accepted -> merge -> confirmed issue closure: completed
        |-- exit 1 --> fix what the gates named (evidence complete)
        '-- exit 3 --> follow errors[].fix; use doctor for its probes
```

## Prerequisites

- **Node.js 20.19.0 or higher** — check with `node --version`
- **git** — SpecGit verifies deliveries against a real repository; it will not run outside one
- **GitHub CLI (`gh`)** — required for GitHub acceptance. Install and authenticate:

```bash
gh auth login
gh auth status        # should report you signed in to github.com
```

- **GitLab CLI (`glab`)** — required when the repository lives on an explicitly
  declared GitLab origin (>= 1.113.0; per-host auth). Self-managed instances use
  the verified version window; GitLab.com uses capability probing:

```bash
glab auth login --hostname git.example.com
glab auth status --hostname git.example.com
```

The forge CLI is the provider seam: SpecGit reads issues, PRs/MRs, and CI/CD facts through `gh` (GitHub) or `glab` (GitLab). No tokens are read, echoed, or persisted by SpecGit itself — it relies on your existing authentication.

## Install

```bash
npm install -g specgit
specgit --version
```

## Verify your environment

```bash
specgit doctor
```

`doctor` probes, in order: git is available, you are inside a git repository, `origin` parses to a forge repository (or a declared GitLab host), the matching forge CLI is present and authenticated, and `spec_git/policy.yaml` exists. Exit `0` means every probe passed; exit `3` reports which probe failed and how to fix it. This is the fastest way to diagnose a new setup. Humans normally omit `--json`; scripts and agents add it when they need the one-document machine envelope.

## Initialize a project

In the repository root, on the default branch:

```bash
specgit init
```

Creates `spec_git/policy.yaml` and the delivery harness. Required-check names are auto-detected from CI files — only names static reading can prove; matrix fan-out and reusable-workflow calls are reported as ambiguous, never guessed (#310). A no-product-CI repository gets the empty list. GitHub uses the generated acceptance workflow as the protected gate; GitLab requires the project's reviewed pipeline to run `specgit finish --json`. Choose check names with care; [GitHub Actions](actions.md) explains the GitHub naming model and recommended aggregator pattern.

Init first requires a forge platform it can prove. Exact `github.com` origins
use GitHub; GitLab origins use an explicit, persisted host declaration (an
interactive terminal may confirm another endpoint only as GitLab). Missing or
invalid platform evidence returns exit `3` before any mutation. Any init path
that will generate a platform workflow or configure branch protection must also
prove the remote default branch from `origin/HEAD` before starting its local
transaction; missing branch evidence leaves the policy, harness, and protection
unchanged. GitHub Enterprise is unsupported and cannot be selected through the
prompt. If a GitLab declaration cannot be persisted, init reports
`providers_write_failed`, restores its exact pre-run state, and stops.

Local initialization does not itself require an issue, PR, product build or
release. Review the tracked changes before deciding to share the SpecGit
workflow or project rules; [CI scope](ci-scope.md) distinguishes shared adoption
from local maintenance. Init/setup preserve the project's business workflows,
build commands and dependencies, but can update shared agent files and hooks.

## Upgrade to a newer CLI version

Installing the npm package updates the CLI executable; it does not silently
rewrite any repository. Refresh each repository separately after the install.

For a human at an interactive terminal, run the existing `init` command:

```bash
npm install -g specgit@latest  # 1. install the requested release
specgit --version              #    verify which CLI will generate the assets
specgit init                   # 2. inspect and offer the repository refresh
specgit status                 # 3. verify the resulting managed-asset state
specgit doctor                 # 4. confirm git, forge auth, and policy health
git diff                       # 5. inspect tracked changes before choosing to share
```

With an existing **valid** policy, plain `init` invokes the same read-only asset
inspector as `status`. It prompts only when a required init asset or an already
installed setup surface is proven `stale` or `missing`. A detected `conflict`
returns `asset_conflict` (exit 3) before any prompt or write, naming the path a
human must move or remove. A setup
surface that was deliberately never installed is `absent` and does not trigger
the question. Current assets do not prompt. An incomplete or failed inspection
cannot authorize the prompt or a write and falls back to `policy_exists`.

Choosing yes performs the equivalent of `specgit init --force --no-protect` and
then `specgit setup --tool all`. The forced init preserves required checks, language,
tags, templates, validation, ordering, automation target and closure, and repair
labels unless an explicit option replaces one. The guided path does not
implicitly enable or alter automation and does not probe or change remote branch
protection; protection changes require a separate deliberate `--protect`
invocation. If authoritative delivery files are intentionally tracked without
the managed ignore block, the guided command adds `--no-ignore` to the equivalent
init and setup preserves that proven opt-out. Choosing no leaves the repository byte-identical and returns the
existing `policy_exists` guidance. Any answer other than yes/y or no/n returns
`upgrade_answer_invalid` (exit 2) before writing.

`--json` and non-TTY runs never ask and never refresh implicitly. Automation
must use the explicit, deterministic sequence:

```bash
npm install -g specgit@latest
specgit init --force --no-protect
specgit setup --tool all
specgit status --json
```

Append `--no-ignore` to the init command when authoritative delivery files are
intentionally tracked without the managed ignore block; setup detects and
preserves that proven model.

Require `assets.generated.clean: true`; clean also requires a complete
inspection. A conflict is unowned content at a managed path. The guided path
stops before writing; explicit writers preserve content they cannot prove they
own. Before a planned whole-file write or removal, the reconciler re-reads the
current bytes and revalidates ownership; a user edit made after planning is
preserved, and any earlier writes in that transaction roll back. The final
clean-status requirement prevents automation from treating remaining conflict
as completion. If init succeeds but the following setup step fails, the init-owned
refresh remains applied and the command reports the setup failure. Repair the
named conflict or filesystem problem, run `specgit setup --tool all`, then
verify with `specgit status --json`. Re-run the full explicit sequence only when
restarting the automation from its first step; no cross-command rollback is
implied.

Commit only the shared changes the user intends, using a delivery when required.
Local refresh alone does not require product compilation, CI, an issue, a PR/MR,
or a package release. See [State and assets](reference.md#state-and-assets) and
[CI scope](ci-scope.md).

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
content. Inspect the effective Git hooks directory
(`git rev-parse --git-path hooks`), which may be shared through `core.hooksPath` or linked worktrees.
Uninstall the CLI last. There is currently no automatic project-uninstall command.

Removing the CLI or policy does not disable the installed Git pre-push guard.
An agent host that invokes the merge guard can also remain blocked when the CLI
or policy is missing. Review those integrations as part of removal; deleting
only `spec_git/policy.yaml` does not uninstall SpecGit from the project.
