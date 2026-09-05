# FAQ

Quick answers to the questions people ask most. If something is actually failing, [Troubleshooting](troubleshooting.md) maps codes to fixes. For definitions, see the [Glossary](glossary.md).

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

## The basics

**What is SpecGit?**
A CLI that derives delivery acceptance from real evidence: a git branch or worktree, the bound forge issues, one pull request/merge request, and required CI checks. Nothing is declared complete by a file or checklist. `accepted` means every gate was verified live; `completed` additionally means the merge and every bound issue closure were confirmed.

**What does it add on top of branch protection?**
One verdict over the whole delivery aggregate. The forge's required checks gate the merge; SpecGit also verifies the binding itself — that the branch you're on is the record's context, that the PR/MR has a scoped closing reference for every bound issue, and that the checks are green at the request head — in one scriptable, fail-closed answer with exit codes.

**Where do I run it?**
Inside the git repository, in any checkout of it. Root discovery is `git rev-parse --show-toplevel`. Linked worktrees are first-class.

**What files does it create?**
The authoritative pair: `spec_git/policy.yaml` (from `init`) and `.specgit.yaml` (from `issue`, or the `bind` alias) — plus optional `spec_git/providers.yaml` when a GitLab host is declared. Around them, `init` and `setup` generate derived assets (the acceptance workflow, the managed AGENTS/CLAUDE blocks, guard hooks, agent entry points). No caches, no global stores; the full three-tier table is in [Reference](reference.md#state-and-assets).

**After updating the npm package, must I rerun `init` and `setup`?**
The package install and repository refresh are separate. After
`npm install -g specgit@latest`, a human runs plain `specgit init`. With a valid existing policy,
it asks only when the read-only inspector proves required or installed managed
assets stale or missing. A detected ownership conflict returns `asset_conflict`
(exit 3) before any prompt or write. Yes runs the equivalent of
`init --force --no-protect` plus `setup --tool all`, preserving policy and automation choices
and skipping remote protection. When authoritative files are intentionally
tracked without the managed ignore block, the equivalent init adds `--no-ignore`
and setup preserves that proven opt-out. Protection changes require a separate deliberate
`--protect` invocation. Choosing no changes nothing and returns `policy_exists` guidance;
current assets do not prompt. `--json` and non-TTY runs never refresh implicitly,
so automation uses `init --force --no-protect`, `setup --tool all`, then
`status --json`; append `--no-ignore` to init for the intentionally tracked authoritative
model. A deliberately absent setup surface does not trigger the question, but
accepting the guided refresh installs both surfaces.

**Why did `init` stop before creating anything?**
Init must prove a supported forge before it writes. Only `github.com` selects
GitHub automatically; declare or interactively confirm a GitLab endpoint.
GitHub Enterprise cannot be selected. Missing or invalid platform evidence exits
`3` with no mutation. A run that will generate a platform workflow or configure
branch protection also requires a remote default branch proved from
`origin/HEAD`; missing evidence leaves policy, harness, and protection unchanged.
A failed provider-declaration write restores the exact pre-run state. Follow the
named `errors[].fix`, then rerun.

## Model questions

**Why no spec files, task lists, or artifacts at all?**
Because acceptance that comes from artifacts is self-declared: whoever finishes checking boxes gets to make the claim. SpecGit derives acceptance from git and forge facts, then derives completion from confirmed merge and closure. How you plan the work is up to you; SpecGit verifies the delivery.

**Can one delivery close many issues?**
Yes — `issues` is a list, and the PR/MR body must contain a closing reference for each one (`Closes #123`, `Fixes #124`, …). One request may close N issues. One delivery binds at most one PR/MR.

**What if the bound PR/MR was closed without merge?**
`specgit issue` refuses to resume or replace that record with exit `1`
(`pr_closed_unmerged`). Reopen it, or create/find an open draft request from the
recorded branch with all closing references and run `specgit pr <number>`. Only
then start a separate issue for a new WHY.

**Can I bind JIRA (or other tracker) references?**
No. Bind a positive issue number from the routed forge; numeric GitHub and declared-GitLab IDs both work. Full issue URL input is currently a GitHub-only convenience. Acceptance must be able to fetch and verify each issue through the provider seam. The usual bridge is a thin forge issue that links to the external tracker item.

**Branch or worktree — which should the record use?**
`specgit bind` decides from live git: on a normal checkout it records `kind: branch`; inside a linked worktree it records `kind: worktree` plus the checkout's label. All checkouts on the same branch satisfy a branch context; a worktree context additionally requires the worktree identity.

**Why can't I pass `--branch` or `--worktree`?**
Because the verdict must reflect where you *are*, not what you claim. Context comes from live git only; a mismatched flag would just be another way to lie to the tool.

**What happens to my dirty working tree?**
Nothing. Dirtiness is reported as evidence but never gates acceptance — the verdict is about the PR/MR head commit, which already excludes your uncommitted edits.

**My local HEAD is behind the PR. Does that matter?**
You get a `local_head_stale` warning. Checks are evaluated at the PR/MR head SHA (what will merge), so a stale local checkout doesn't block acceptance.

## Acceptance questions

**Can I run `accept` offline?**
You can run it; it cannot answer `accepted`. Verifying issues, the PR/MR, and checks requires the routed forge provider (`gh` or `glab`) — offline, the verdict is `unknown` (exit 3). Fail-closed, by design.

**Why exit 3 instead of exit 1?**
Exit `1` means "we gathered all the evidence and it says no." Exit `3` means "no verdict is possible" — some required evidence is missing or unavailable. Automation should treat them differently: follow `errors[].fix` for 3, and fix the rejected delivery fact for 1. `doctor` helps only with its prerequisite probes.

**The verdict changed between runs. Is that a bug?**
It's derivation. States are computed from live facts on every invocation and never persisted, so they change exactly when the facts change — a check finished, the PR/MR body was edited, you switched branches.

**Which checks does it look at?**
The routed provider's CI/CD runs on the **PR/MR head commit**, matched byte-for-byte against `required_checks`. Not your local commit, not the base branch.

## Adoption questions

**Does it replace our issue tracker or CI?**
No. Issues stay on the repository's forge and checks stay in its CI/CD system (GitHub Actions patterns are in [GitHub Actions](actions.md)). SpecGit reads their evidence and, only under explicit automation, performs the configured merge and issue closure.

**Can we migrate data from another spec tool?**
There is no migration and no compatibility mode by design — the models don't share a surface. Adopt fresh: `specgit init`, then bind your next delivery.

**GitHub Enterprise?**
Unsupported in v1: there is no GitHub Enterprise declaration or provider route, and only `github.com` origins resolve through `gh`. Explicitly declared GitLab origins route through `glab`; this includes capability-probed GitLab.com and version-qualified self-managed GitLab. Other remotes fail closed.

**Does it phone home?**
No. There is no telemetry; the only environment inputs aim the forge CLIs (`SPECGIT_GH*`, `SPECGIT_GLAB*`) or size the local merge guard's verdict budget (`SPECGIT_GUARD_BUDGET_S`, hook-only). Network calls are `gh api` requests for GitHub evidence and `glab api` requests for a declared GitLab origin — issues, the PR/MR, and check/pipeline runs.

**Do AI agents use it?**
Yes — that's a primary audience. The CLI emits one JSON document per command under `--json`, exit codes are contractual, and the [agent contract](agent-contract.md) defines how agents must treat verdicts.
