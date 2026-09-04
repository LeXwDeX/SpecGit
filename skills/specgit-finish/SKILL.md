---
name: specgit-finish
description: Run the SpecGit evidence verdict — fail-closed acceptance derived from real git, PR, and CI evidence; exit 0 means accepted; completion requires confirmed merge and issue closure.
allowed-tools: Bash(specgit:*), Bash(git:*), Bash(gh:*), Bash(glab:*)
license: MIT
metadata:
  author: specgit
---

<!-- specgit-managed-entry-point -->

# specgit-finish

The acceptance verdict. Eleven gates evaluate live evidence: record, policy,
completeness, context, origin, provider, issues, sequence (ordered
deliveries), PR, closing refs, and required checks at the PR head.

## Usage

```bash
specgit finish --json
```

## Steps

1. Before running the verdict, confirm the bound pull request is not a
   draft — a draft always fails with `pr_draft` (factual, exit 1). If it
   is still a draft, mark it ready for review first:

   ```bash
   gh pr ready <number>              # GitHub deliveries
   glab mr update <number> --ready   # GitLab deliveries
   ```

2. Run the verdict from the delivery branch:

   ```bash
   specgit finish --json
   ```

3. Branch on the exit code using the contract below; on `1` fix exactly
   what the failures name and re-run until `0`.

## Exit contract

- `0` accepted — report the verdict and continue the authorized merge
  through the guidance below.
- `1` rejected — each failure carries a `fix`; fix what the gates name,
  re-run until 0.
- `3` unknown — run `specgit doctor --json`, fix the named evidence
  failure within your permissions, then retry.

## Rules

- Policy defines the requirements; real git, PR, issue, and CI evidence
  decides the verdict. Task lists and specification prose are not acceptance evidence.
- Never weaken `spec_git/policy.yaml` to make a verdict pass.
- `--json` is the only parse surface.

Continue within existing user authorization. With automation enabled, the
trusted remote completion workflow continues after CI without another user
confirmation. `specgit pr --merge --json` is its recovery path. It requires
the approved target policy, `finish` exit 0, and all CI checks passing at the
current PR head. Completion means the merge and every bound issue closure are
confirmed; a partial closure remains recoverable. `finish` is read-only and
exit 0 means accepted, not necessarily completed. A failed delivery is tracked
by a repair issue; retries reuse that cause and preserve the original PR.
Automation defaults to no. Only the user's own yes enables it through
`specgit init --automation yes --merge-target <branch>`; ordinary `init --force`
preserves that choice and target. An agent must not choose yes for the user. When an
action lacks user authorization or platform permission, report the specific
missing permission with the prepared result.
