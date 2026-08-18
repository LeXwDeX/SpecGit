# SpecGit on a Team

Everything else in these docs works identically for one person or twenty. What changes on a team is coordination: whose policy is authoritative, how a delivery maps onto branches and PRs, and what review actually reviews.

## One delivery = one branch (or worktree) + N issues + one PR + required checks

That aggregate is the team's unit of work and the unit of acceptance:

- **Branch or worktree.** The delivery happens on one branch; parallel checkouts (worktrees) on that branch are equivalent. No delivery ever spans branches.
- **Issues.** Everything the delivery is "for" is a GitHub issue number in the record — one or many. The issues carry intent and scope; SpecGit only verifies they exist and are closed by the PR.
- **One PR.** The delivery merges through exactly one pull request. Its body's closing references are the contractual link back to the issues.
- **Required checks.** The policy is the shared definition of "CI passed" — one list of check names, enforced by branch protection and by SpecGit identically.

## The policy is the team contract

`spec_git/policy.yaml` is committed on the default branch and reviewed like code:

- Adding a required check (say, a new security scan) is a PR that changes the policy **and** the branch-protection settings together. After it merges, every delivery must pass the new check before acceptance.
- Removing a required check is equally deliberate — SpecGit fails closed on an empty list, so nobody can silently turn acceptance into a no-op.
- See [GitHub Actions](actions.md) for the aggregator pattern that keeps this contract stable while CI internals change.

## A delivery's lifecycle

```text
issue(s) filed ──► specgit issue (branch + draft PR + record) ──► commits ──► push
                                                                                        │
        specgit finish ◄── closing refs + green checks ◄────────────────────────────────┘
              │
              ├── accepted ──► merge ──► specgit unbind (or delete .specgit.yaml)
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
- **Delete the record after merge.** `specgit unbind --yes` keeps merged branches clean if they linger; the binding has already done its job at merge time.
