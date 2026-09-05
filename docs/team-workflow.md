# SpecGit on a Team

Everything else in these docs works identically for one person or twenty. What changes on a team is coordination: whose policy is authoritative, how a delivery maps onto branches and PRs, and what review actually reviews.

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

## One delivery = one branch (or worktree) + N issues + one PR/MR + required checks

That aggregate is the team's unit of work and the unit of acceptance:

- **Branch or worktree.** The delivery happens on one branch; parallel checkouts (worktrees) on that branch are equivalent. No delivery ever spans branches.
- **Issues.** Everything the delivery is "for" is an issue number in the record — one or many (GitHub issues, or GitLab issues on a declared GitLab origin). The issues carry intent and scope; before merge SpecGit verifies they exist, are not occupied by another active delivery, satisfy configured project rules, and have scoped closing references. Completion separately confirms that they are closed.
- **One PR/MR.** The delivery merges through exactly one pull or merge request. Its body's closing references are the contractual link back to the issues.
- **Required checks.** The policy is the shared list SpecGit matches at the request head. Align branch protection with the same aggregator where the forge supports it; the generated SpecGit Acceptance check remains a separate protected gate and is never listed in its own wait policy.

Repository adoption starts only after init proves a supported platform. Before
writing a platform workflow or configuring branch protection, it also proves
the remote default branch. It cannot guess `main` or treat an arbitrary
non-GitHub host as GitHub Enterprise. Missing platform evidence fails before any
mutation; missing branch evidence on an applicable path leaves policy, workflow,
and protection unchanged.

## The policy is the team contract

`spec_git/policy.yaml` is committed on the default branch and reviewed like code:

- Adding a required check (say, a new security scan) is a PR that changes the policy **and** the branch-protection settings together. After it merges, every delivery must pass the new check before acceptance.
- Removing the last required check is equally deliberate — an empty list is the no-CI policy, and the generated SpecGit Acceptance job, enforced through branch protection, remains the gate, so nobody can silently turn acceptance into a no-op.
- See [GitHub Actions](actions.md) for the aggregator pattern that keeps this contract stable while CI internals change.

## A delivery's lifecycle

```text
issue(s) filed ──► specgit issue (branch + draft PR/MR + record) ──► commits ──► push
                                                                                        │
        specgit finish ◄── closing refs + green checks ◄────────────────────────────────┘
              │
              ├── accepted ──► merge ──► issue closure ──► completed history
               │                                         on the trunk (#351)
               ├── rejected ──► fix what the gates named, re-run finish
               └── unknown  ──► follow errors[].fix, re-run finish
```

The record (`.specgit.yaml`) is committed on the delivery branch, so the binding travels with the work: anyone who checks the branch out — including worktrees on their own machine — can run `specgit status` and `specgit finish` and get the same verdict.

## What review reviews

Acceptance answers "does the current delivery satisfy the evidence gates and qualify for merge?" Completion answers whether merge and closure were confirmed. Review answers "should this delivery exist at all?" Reviewers therefore look at:

1. The linked issues (from the record's `issues`) — is this the right scope?
2. The diff — the usual engineering review.
3. The binding itself — does the PR/MR carry closing references for those issues? Is the context branch the one being reviewed?

SpecGit removes the bookkeeping from review (no task checklists to audit, no artifact status to trust) and leaves the substance.

## Conventions that work well

- **Branch naming.** Anything works; `<type>/<issue>-<slug>` (e.g. `fix/124-flaky-tests`) keeps the context self-describing and matches worktree labels.
- **Bind early, complete later.** A record with issues but no PR/MR is a valid draft; `status` shows it as such. Binding early makes the delivery discoverable (`git grep` for the issue number finds the branch).
- **Re-run `finish` after every material head, body, or CI change.** The verdict is a fact about *now*; treat it like that in conversation ("finish was green as of the last push"). Keep `accept` for existing scripts and CI aliases.
- **Let merged records ride as history.** After a merge the record on the trunk is completed history (`status`: `historical-candidate`; `finish`: `completed`) — the next `specgit issue` replaces it atomically. `unbind` is only for abandoning a delivery or resetting/uninstalling.
- **Repair closed requests explicitly.** A bound PR/MR closed without merge is
  failed delivery evidence. `specgit issue` returns `pr_closed_unmerged` (exit
  `1`) and preserves it even when passed new titles. Reopen it or bind an open
  draft request from the recorded branch with `specgit pr <number>` before
  starting a new WHY.

In the SpecGit repository, a metadata-only classification is permission to run
the smaller verifier, not proof that the content is valid. Every admitted input
has a fail-closed parser or byte contract, including legacy/YAML issue templates,
the managed `.gitignore` region, `CODEOWNERS`, delivery configuration,
changesets, documentation, workflows, and mandatory generated files. Missing or
malformed content fails; unknown and mixed paths run the full product checks.
