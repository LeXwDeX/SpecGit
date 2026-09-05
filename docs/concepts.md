# Concepts

This guide explains the core ideas behind SpecGit and how they fit together. For practical usage see [Getting Started](getting-started.md); for the one-screen version see [Overview](overview.md).

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
        |-- exit 0 --> accepted; configured pr --merge confirms merge
        |                         then closes bound issues when enabled
        |-- exit 1 --> fix what the gates named (evidence complete)
        '-- exit 3 --> follow errors[].fix; use doctor for its probes
```

## Philosophy

```text
evidence not assertion   — acceptance is derived from git, request, and CI/CD facts
fail-closed not hopeful  — anything unverifiable is "unknown", never "accepted"
git is the contract      — the branch, the PR/MR, and the checks are the deliverable
```

SpecGit binds a delivery to issues, a branch, and a pull or merge request, then verifies acceptance from real git and CI/CD evidence. A checklist that says "done" is not evidence; a green required check on the request head commit is. `finish` only reads evidence. When the user has enabled automation, `pr --merge` uses fresh acceptance and all CI/CD checks at that head to complete the merge and configured issue closure.

## The delivery binding aggregate

Every delivery is one aggregate, declared in a single record file (`.specgit.yaml`) plus the facts it points at:

| Part | What it is | Where it lives |
| --- | --- | --- |
| Delivery | A kebab-case id for the work (`add-login-flow`) | record |
| Execution context | Where the work happens: a branch, or a linked worktree plus its branch | live git |
| Issues | 1..N issue numbers in the delivery repository | record → forge |
| Pull request | Exactly one PR/MR that merges the delivery | record → forge |
| Required checks | CI/CD check names that must pass at the request head | policy → forge |

The record declares; git and the forge substantiate. Acceptance means every part was verified against the real thing.

### One PR may close N issues

`issues` is a list: a single PR can close any number of issues (`Closes #123`, `Fixes #124`, ...). Every bound issue must be covered by the PR's closing references in the delivery repository — acceptance fails with the missing numbers listed if even one is absent. Issue numbers resolve on the declared forge; opaque tracker references are rejected at bind time. Configured automatic issue closure occurs only after the platform confirms the merge, including when a non-default target branch does not close references automatically.

## Execution context: branch or worktree

The execution context is **resolved from live git at evaluation time** — never passed as a flag, never taken from the record alone.

- `kind: branch` — the record names a branch. Any checkout currently on that branch satisfies it. Work copies are equivalent.
- `kind: worktree` — the record names a portable **label** plus a branch. The current checkout must be a linked worktree whose label resolves (via `git worktree list`) to that branch. Labels are portable identifiers, never local paths.

If HEAD is detached, the live branch disagrees with the record, or the worktree label does not resolve to the record's branch, context gates fail with precise codes. There is no "trust me" mode.

## The authoritative files

```text
repo root/
├── spec_git/
│   ├── policy.yaml       # checks, conventions, templates, automation
│   └── providers.yaml    # optional — an explicitly declared GitLab host
└── .specgit.yaml         # this delivery's binding — committed on the delivery branch
```

- **Policy** (`spec_git/policy.yaml`): the project-level contract — required CI/CD check names plus optional ordering, generated-text language, tags, title/label/body validation, selected templates, and automation. An empty required list is the no-CI policy: the applicable platform acceptance integration remains the gate. Automation defaults to off; only the user's own yes enables `init --automation yes --merge-target <branch>`. Ordinary `init --force` preserves that choice; explicit options change it. Agents cannot answer yes for the user. `automation.target_branch` constrains the merge destination, `automation.repair_labels` selects labels for failure issues, and configured issue closure follows a confirmed merge.
- **Declaration** (`spec_git/providers.yaml`, optional): present only when `init --gitlab-host` or the interactive GitLab-only confirmation declared the origin, including GitLab.com; committed so the team shares it. Only exact `github.com` selects GitHub without a declaration. An undecided or invalid platform exits `3` before mutation; declaration-write failure also exits `3` and restores the pre-run provider state. When init plans workflow generation or branch protection, an unproved remote default branch exits `3` before the local transaction. GitHub Enterprise has no route.
- **Record** (`.specgit.yaml`): the delivery-level binding. Written by `specgit issue` (script alias: `bind`), removed by `specgit unbind`. Unknown keys are preserved on rewrite so other tools can coexist in the file.

No other *authoritative* state exists — no artifact directories, no caches, no global stores. Around these files `init`/`setup` generate derived assets (the acceptance workflow, the managed AGENTS/CLAUDE blocks, guard hooks, agent entry points): regenerated to the running version, never hand-configured. Root discovery is `git rev-parse --show-toplevel` — SpecGit runs only inside a git repository, at its root.

Generated-file plans do not grant lasting ownership. The reconciler re-reads
each whole-file target immediately before replacement and requires both current
ownership and the planned merge basis; it re-proves ownership from current
bytes before removal. An intervening user edit is preserved, and any earlier
accepted changes in the same failed transaction are rolled back.

## Acceptance is derived, never stored

Delivery and local-observation states — `unbound`, `draft`, `bound`, `accepted`, `closure_pending`, `completed`, `rejected`, `unknown`, plus status-only `historical-candidate` — are **computed on every invocation**. Nothing is persisted, so a state can never drift from reality.

Evaluation runs eleven gates in order, from cheapest local facts to live forge evidence:

1. Record present and valid
2. Policy present and valid
3. Completeness (≥1 issue, exactly 1 PR)
4. Context matches live git
5. Origin resolves to a repository on the declared platform (`github.com`, or an explicitly declared GitLab origin)
6. Platform provider reachable and authenticated (`gh`, or `glab` on a declared GitLab origin)
7. Issues exist, are not PRs/MRs, are not already claimed by another active delivery, and satisfy configured title, label, and body rules
8. Sequence — when `ordered_issues` is on, no open issue with a smaller number precedes this delivery
9. PR/MR exists, is not closed-unmerged or draft, its head matches the context branch, it belongs to the same repository, and it satisfies configured title and body rules
10. The PR/MR body contains a scoped closing reference for every bound issue
11. Every required check is green at the PR/MR head commit

Gates short-circuit across gates; within a gate, every failure is collected and reported. Full table and codes: [Reference](reference.md).

## Fail-closed

Every piece of evidence is either gathered successfully or it is a failure — there is no silent skip. If all evidence was gathered and at least one gate failed, the verdict is **rejected** (exit 1) with complete evidence. If evidence could not be gathered at all (missing or invalid record/policy, no matching forge CLI, no auth, transport error, not a git repo), the verdict is **unknown** (exit 3). A delivery is **accepted** (exit 0) only when every gate passed with evidence.

Consequences worth knowing:

- `specgit finish` (alias `accept`) offline can return `unknown`, never `accepted`. Acceptance requires the provider by design.
- A dirty working tree is reported as evidence but never fails acceptance — acceptance is about the request head, not your local edits.
- If your local HEAD differs from the PR/MR head, you get an informational `local_head_stale` warning; checks are evaluated at the **request head commit**, because that is what will be merged.
- `specgit pr --merge` additionally requires every executed CI check to pass, including checks outside the required list; GitLab also requires the authoritative MR pipeline to succeed. It submits the expected head SHA so a new push cannot reuse an earlier approval of evidence.

## What SpecGit deliberately is not

- Not a spec framework: there are no proposal, spec, design, or task artifacts.
- Not a general git wrapper: bootstrap creates the delivery branch and carries its record; acceptance reads git facts without rewriting history.
- Not an issue tracker or CI system: it verifies against your forge (GitHub or GitLab) and your existing CI.
- Not a plugin platform: no third-party plugins or extension points. `init` generates the fixed harness (acceptance workflow, managed AGENTS/CLAUDE block, guard hooks) and `setup` installs fixed agent entry points — all of them regenerated artifacts, none configurable surfaces.
