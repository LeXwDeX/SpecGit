# SpecGit on a Team

Everything else in these docs works identically for one person or twenty. What changes on a team is coordination: whose policy is authoritative, how a delivery maps onto branches and PRs, and what review actually reviews.

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

## One delivery = one branch (or worktree) + N issues + one PR + required checks

That aggregate is the team's unit of work and the unit of acceptance:

- **Branch or worktree.** The delivery happens on one branch; parallel checkouts (worktrees) on that branch are equivalent. No delivery ever spans branches.
- **Issues.** Everything the delivery is "for" is an issue number in the record — one or many (GitHub issues, or GitLab issues on a declared GitLab origin). The issues carry intent and scope; SpecGit only verifies they exist and are closed by the PR.
- **One PR.** The delivery merges through exactly one pull request. Its body's closing references are the contractual link back to the issues.
- **Required checks.** The policy is the shared definition of "CI passed" — one list of check names, enforced by branch protection and by SpecGit identically.

## The policy is the team contract

`spec_git/policy.yaml` is committed on the default branch and reviewed like code:

- Adding a required check (say, a new security scan) is a PR that changes the policy **and** the branch-protection settings together. After it merges, every delivery must pass the new check before acceptance.
- Removing the last required check is equally deliberate — an empty list is the no-CI policy, and the generated SpecGit Acceptance job, enforced through branch protection, remains the gate, so nobody can silently turn acceptance into a no-op.
- See [GitHub Actions](actions.md) for the aggregator pattern that keeps this contract stable while CI internals change.

## A delivery's lifecycle

```text
issue(s) filed ──► specgit issue (branch + draft PR + record) ──► commits ──► push
                                                                                        │
        specgit finish ◄── closing refs + green checks ◄────────────────────────────────┘
              │
              ├── accepted ──► merge ──► completed history on the trunk (the
               │                        next specgit issue replaces it, #351)
               ├── rejected ──► fix what the gates named, re-run finish
               └── unknown  ──► fix record/policy/auth, re-run finish
```

The record (`.specgit.yaml`) is committed on the delivery branch, so the binding travels with the work: anyone who checks the branch out — including worktrees on their own machine — can run `specgit status` and `specgit finish` and get the same verdict.

## What review reviews

Acceptance answers "is the delivery complete and verified?" Review answers "should this delivery exist at all?" Reviewers therefore look at:

1. The linked issues (from the record's `issues`) — is this the right scope?
2. The diff — the usual engineering review.
3. The binding itself — does the PR really close those issues? Is the context branch the one being reviewed?

SpecGit removes the bookkeeping from review (no task checklists to audit, no artifact status to trust) and leaves the substance.

## Conventions that work well

- **Branch naming.** Anything works; `<type>/<issue>-<slug>` (e.g. `fix/124-flaky-tests`) keeps the context self-describing and matches worktree labels.
- **Bind early, complete later.** A record with issues but no PR is a valid draft; `status` shows it as such. Binding early makes the delivery discoverable (`git grep` for the issue number finds the branch).
- **Re-run `accept` after every CI run.** The verdict is a fact about *now*; treat it like that in conversation ("accept was green as of the last push").
- **Let merged records ride as history.** After a merge the record on the trunk is completed history (`status`: `historical-candidate`; `finish`: `completed`) — the next `specgit issue` replaces it atomically. `unbind` is only for abandoning a delivery or resetting/uninstalling.
