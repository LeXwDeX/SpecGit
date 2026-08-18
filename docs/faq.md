# FAQ

Quick answers to the questions people ask most. If something is actually failing, [Troubleshooting](troubleshooting.md) maps codes to fixes. For definitions, see the [Glossary](glossary.md).

## The basics

**What is SpecGit?**
A CLI that decides whether a delivery is done — by deriving the answer from real evidence: a git branch or worktree, the bound GitHub issues, one pull request, and required CI checks. Nothing is declared complete by a file or a checklist; `accepted` means every gate was verified live.

**What does it add on top of branch protection?**
One verdict over the whole delivery aggregate. GitHub's required checks gate the merge; SpecGit also verifies the binding itself — that the branch you're on is the record's context, that the PR's closing refs actually close every bound issue, and that the checks are green at the PR head — in one scriptable, fail-closed answer with exit codes.

**Where do I run it?**
Inside the git repository, in any checkout of it. Root discovery is `git rev-parse --show-toplevel`. Linked worktrees are first-class.

**What files does it create?**
Two: `spec_git/policy.yaml` (from `init`) and `.specgit.yaml` (from `bind`). Both are plain YAML intended to be committed. Nothing else — no caches, no global stores.

## Model questions

**Why no spec files, task lists, or artifacts at all?**
Because acceptance that comes from artifacts is self-declared: whoever finishes checking boxes gets to say "done." SpecGit defines "done" as a fact about git and GitHub. How you plan the work is up to you; SpecGit only verifies the delivery.

**Can one delivery close many issues?**
Yes — `issues` is a list, and the PR body must close each one (`Closes #123`, `Fixes #124`, …). One PR may close N issues. One delivery binds at most one PR.

**Can I bind JIRA (or other tracker) references?**
No. Only GitHub issue numbers (or full issue URLs) bind — acceptance must be able to fetch and verify each issue. The usual bridge is a thin GitHub issue that links out to the tracker item.

**Branch or worktree — which should the record use?**
`specgit bind` decides from live git: on a normal checkout it records `kind: branch`; inside a linked worktree it records `kind: worktree` plus the checkout's label. All checkouts on the same branch satisfy a branch context; a worktree context additionally requires the worktree identity.

**Why can't I pass `--branch` or `--worktree`?**
Because the verdict must reflect where you *are*, not what you claim. Context comes from live git only; a mismatched flag would just be another way to lie to the tool.

**What happens to my dirty working tree?**
Nothing. Dirtiness is reported as evidence but never gates acceptance — the verdict is about the PR head commit, which already excludes your uncommitted edits.

**My local HEAD is behind the PR. Does that matter?**
You get a `local_head_stale` warning. Checks are evaluated at the PR head SHA (what will merge), so a stale local checkout doesn't block acceptance.

## Acceptance questions

**Can I run `accept` offline?**
You can run it; it cannot answer `accepted`. Verifying issues, PR, and checks requires the GitHub provider — offline, the verdict is `unknown` (exit 3). Fail-closed, by design.

**Why exit 3 instead of exit 1?**
Exit `1` means "we gathered all the evidence and it says no." Exit `3` means "no verdict is possible" — missing record/policy, `gh` absent or unauthenticated, transport failure. Automation should treat them differently: fix the environment for 3, fix the delivery for 1.

**The verdict changed between runs. Is that a bug?**
It's derivation. States are computed from live facts on every invocation and never persisted, so they change exactly when the facts change — a check finished, the PR body was edited, you switched branches.

**Which checks does it look at?**
Check runs GitHub reports on the **PR head commit**, matched byte-for-byte against `required_checks`. Not your local commit, not the base branch.

## Adoption questions

**Does it replace our issue tracker or CI?**
No. Issues stay in GitHub Issues; checks stay in your CI (GitHub Actions patterns in [GitHub Actions](actions.md)). SpecGit only reads them.

**Can we migrate data from another spec tool?**
There is no migration and no compatibility mode by design — the models don't share a surface. Adopt fresh: `specgit init`, then bind your next delivery.

**GitHub Enterprise?**
Not supported in this version: only `github.com` origins resolve; other remotes get `origin_unresolvable` and acceptance fails closed.

**Does it phone home?**
No. There is no telemetry and no product environment variables; the only network calls are `gh api` requests for issues, the PR, and check runs.

**Do AI agents use it?**
Yes — that's a primary audience. The CLI emits one JSON document per command under `--json`, exit codes are contractual, and the [agent contract](agent-contract.md) defines how agents must treat verdicts.
