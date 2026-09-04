# Overview

**SpecGit is an acceptance gate for deliveries.** One delivery = one execution context (a branch or worktree) + one or more forge issues (GitHub or GitLab) + one pull request + required CI checks. SpecGit derives the verdict from the real evidence and fails closed.

The whole idea in one line: **if git, the PR, and the checks can prove it, it's accepted.**

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

## The model on one screen

```text
.specgit.yaml (record)          spec_git/policy.yaml (policy)
┌────────────────────────┐      ┌──────────────────────────────┐
│ delivery: add-login    │      │ required_checks:             │
│ context:               │      │   - "All checks passed"      │
│   kind: branch         │      └──────────────────────────────┘
│   branch: feat/123     │                 │
│ issues: [123, 124]     │                 │
│ pr: 42                 │                 │
└───────────┬────────────┘                 │
            ▼                              ▼
   live git facts              GitHub via `gh`
   branch/worktree match       issues exist · PR open/merged
   origin → owner/repo         closing refs close every issue
                               checks green at PR head
            │                              │
            └──────────────┬───────────────┘
                           ▼
        accepted (0) · rejected (1) · unknown (3)
```

## The loop

```bash
specgit init                                        # once per repo → policy + harness
specgit issue "feat: add login"                     # → issues, branch, draft PR, .specgit.yaml
# ... work, push; CI runs (including the SpecGit Acceptance job) ...
specgit finish                                      # derived verdict, fail-closed
```

## Why derived, not declared

A delivery is not done because a file says it is done. It is done when the branch is bound, every issue is closed by the PR, and the required checks are green at the PR head commit — all verified live, on every `accept`. States are computed per invocation and never persisted, so nothing can lie about itself. When evidence cannot be gathered (no network, missing `gh`, invalid record), the answer is `unknown`, never `accepted`. See [Concepts](concepts.md).

## Where to go next

- [Getting Started](getting-started.md) — the loop, step by step
- [CLI Reference](cli.md) — `init`, `bind`, `unbind`, `status`, `accept`, `doctor`
- [Reference](reference.md) — record/policy schemas, the eleven gates, all diagnostic codes
- [GitHub Actions](actions.md) — picking check names, wiring required checks, security
- [Examples & Recipes](examples.md) — real deliveries end to end
