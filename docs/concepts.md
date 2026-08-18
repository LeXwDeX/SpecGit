# Concepts

This guide explains the core ideas behind SpecGit and how they fit together. For practical usage see [Getting Started](getting-started.md); for the one-screen version see [Overview](overview.md).

## Philosophy

```text
evidence not assertion   — acceptance is derived from git, PR, and CI facts
fail-closed not hopeful  — anything unverifiable is "unknown", never "accepted"
git is the contract      — the branch, the PR, and the checks are the deliverable
```

SpecGit does not manage plans, specs, or task lists. By the time SpecGit looks at your work, the work already exists as a branch, issues, a pull request, and CI checks. SpecGit's only job is to verify — from real evidence — that the delivery is complete. A checklist that says "done" is not evidence; a green required check on the PR head commit is.

## The delivery binding aggregate

Every delivery is one aggregate, declared in a single record file (`.specgit.yaml`) plus the facts it points at:

| Part | What it is | Where it lives |
| --- | --- | --- |
| Delivery | A kebab-case id for the work (`add-login-flow`) | record |
| Execution context | Where the work happens: a branch, or a linked worktree plus its branch | live git |
| Issues | 1..N GitHub issue numbers the delivery closes | record → GitHub |
| Pull request | Exactly one PR that merges the delivery | record → GitHub |
| Required checks | CI check names that must pass at the PR head | policy → GitHub |

The record declares; git and GitHub substantiate. Acceptance means every part was verified against the real thing.

### One PR may close N issues

`issues` is a list: a single PR can close any number of issues (`Closes #123`, `Fixes #124`, ...). Every bound issue must be closed by the PR's closing references — acceptance fails with the missing numbers listed if even one is absent. Only GitHub issue numbers are accepted; opaque tracker references are rejected at bind time.

## Execution context: branch or worktree

The execution context is **resolved from live git at evaluation time** — never passed as a flag, never taken from the record alone.

- `kind: branch` — the record names a branch. Any checkout currently on that branch satisfies it. Work copies are equivalent.
- `kind: worktree` — the record names a portable **label** plus a branch. The current checkout must be a linked worktree whose label resolves (via `git worktree list`) to that branch. Labels are portable identifiers, never local paths.

If HEAD is detached, the live branch disagrees with the record, or the worktree label does not resolve to the record's branch, context gates fail with precise codes. There is no "trust me" mode.

## The two files

```text
repo root/
├── spec_git/
│   └── policy.yaml      # required_checks — shared by every delivery
└── .specgit.yaml        # this delivery's binding — committed on the delivery branch
```

- **Policy** (`spec_git/policy.yaml`): the project-level contract — the non-empty list of CI check names every delivery must pass. Created by `specgit init`, versioned like code.
- **Record** (`.specgit.yaml`): the delivery-level binding. Written by `specgit bind`, removed by `specgit unbind`. Unknown keys are preserved on rewrite so other tools can coexist in the file.

No other state exists. No artifact directories, no caches, no global stores. Root discovery is `git rev-parse --show-toplevel` — SpecGit runs only inside a git repository, at its root.

## Acceptance is derived, never stored

Delivery states — `unbound`, `draft`, `bound`, `accepted`, `rejected`, `unknown` — are **computed on every invocation**. Nothing is persisted, so a state can never drift from reality.

Evaluation runs ten gates in order, from cheapest local facts to live GitHub evidence:

1. Record present and valid
2. Policy present and valid
3. Completeness (≥1 issue, exactly 1 PR)
4. Context matches live git
5. Origin resolves to a GitHub repository
6. GitHub provider reachable and authenticated
7. Issues exist (and are issues, not PRs)
8. PR exists, open or merged, head matches the context branch, same repository
9. PR body closes every bound issue
10. Every required check is green at the PR head commit

Gates short-circuit across gates; within a gate, every failure is collected and reported. Full table and codes: [Reference](reference.md).

## Fail-closed

Every piece of evidence is either gathered successfully or it is a failure — there is no silent skip. If all evidence was gathered and at least one gate failed, the verdict is **rejected** (exit 1) with complete evidence. If evidence could not be gathered at all (missing or invalid record/policy, no `gh`, no auth, transport error, not a git repo), the verdict is **unknown** (exit 3). A delivery is **accepted** (exit 0) only when every gate passed with evidence.

Consequences worth knowing:

- `specgit accept` offline can return `unknown`, never `accepted`. Acceptance requires the provider by design.
- A dirty working tree is reported as evidence but never fails acceptance — acceptance is about the PR head, not your local edits.
- If your local HEAD differs from the PR head, you get an informational `local_head_stale` warning; checks are evaluated at the **PR head commit**, because that is what will be merged.

## What SpecGit deliberately is not

- Not a spec framework: there are no proposal, spec, design, or task artifacts.
- Not a git wrapper: it reads git facts; it never rewrites history or touches your branches.
- Not an issue tracker or CI system: it verifies against GitHub and your existing Actions.
- Not a plugin platform: `init` creates only the policy. No slash commands, instructions, or tool configuration are generated.
