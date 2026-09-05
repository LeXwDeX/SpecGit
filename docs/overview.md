# Overview

**SpecGit is an acceptance gate for deliveries.** One delivery = one execution context (a branch or worktree) + one or more forge issues (GitHub or GitLab) + one pull or merge request + required CI/CD checks. SpecGit derives the verdict from the real evidence and fails closed.

The whole idea in one line: **if git, the forge request, and the checks can prove it, it's accepted.**

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
   live git facts              forge via `gh` or `glab`
   branch/worktree match       issues exist · PR/MR open/merged
   origin → owner/repo         closing refs close every issue
                               checks green at request head
            │                              │
            └──────────────┬───────────────┘
                           ▼
        accepted (0) · rejected (1) · unknown (3)
```

## The loop

```bash
specgit init                                        # initialize → policy + harness
specgit issue "feat: add login"                     # → issues, branch, draft PR/MR, .specgit.yaml
# ... work, push; the platform acceptance integration runs ...
specgit finish                                      # derived verdict, fail-closed
```

## Why derived, not declared

A delivery is not accepted because a file says it is accepted. `finish` verifies the binding, issue and PR/MR facts, closing references, and required checks at the exact PR/MR head. Exit 0 means the delivery is accepted for merge. Completion is a later proven state: the request has merged and every bound issue is closed. States are computed per invocation and never persisted, so nothing can lie about itself. When evidence cannot be gathered (no network, missing forge CLI, invalid record), the answer is `unknown`, never `accepted`. See [Concepts](concepts.md).

## Where to go next

- [Getting Started](getting-started.md) — the loop, step by step
- [CLI Reference](cli.md) — all ten commands, flags, exit codes, and JSON contracts
- [Reference](reference.md) — record/policy schemas, the eleven gates, all diagnostic codes
- [GitHub Actions](actions.md) — picking check names, wiring required checks, security
- [Examples & Recipes](examples.md) — real deliveries end to end
