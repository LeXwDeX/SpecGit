---
name: specgit-pr
description: Repair the SpecGit PR/MR binding or complete a configured automatic merge.
allowed-tools: Bash(specgit:*), Bash(git:*), Bash(gh:*), Bash(glab:*)
license: MIT
metadata:
  author: specgit
---

<!-- specgit-managed-entry-point -->

# specgit-pr

Repairs the record's PR/MR binding. With `--merge`, completes the configured
merge and issue closure after fresh evidence passes.

## Usage

```bash
specgit pr              # auto-discover the PR/MR for this head branch
specgit pr 123          # bind an explicit number (no platform round-trip)
specgit pr --merge --json  # merge the bound PR/MR when automation is enabled
```

## Steps

1. Run from the delivery branch:

   ```bash
   specgit pr --json
   ```

2. Branch on the result:
   - `exit 0` → the binding is repaired; resume the delivery.
   - `pr_not_found` → follow `errors[].fix` to create or find the draft
     PR/MR for the recorded head branch, preserve every closing reference,
     then bind it explicitly with `specgit pr <number>`. Only a genuinely
     partial bootstrap with no recorded request resumes through `specgit issue`.
   - `pr_ambiguous` → several open PRs/MRs share the head branch; bind one
     explicitly: `specgit pr <number>`.

## Rules

- `specgit pr` owns the PR/MR binding; never hand-edit `.specgit.yaml`.
- `--json` is the only parse surface.

Continue within existing user authorization. With automation enabled, the
trusted remote completion workflow continues after CI without another user
confirmation. `specgit pr --merge --json` is its recovery path. It requires
the approved target policy, `finish` exit 0, and all CI checks passing at the
current PR/MR head. Completion means the merge and every bound issue closure are
confirmed; a partial closure remains recoverable. `finish` is read-only and
exit 0 means accepted, not necessarily completed. A failed delivery is tracked
by a repair issue; retries reuse that cause and preserve the original PR/MR.
Automation defaults to no. Only the user's own yes enables it. A fresh policy
uses `specgit init --automation yes --merge-target <branch>`; an existing policy
uses `specgit init --force --automation yes --merge-target <branch>`. Ordinary
`init --force` preserves that choice and target. An agent must not choose yes for the user. When an
action lacks user authorization or platform permission, report the specific
missing permission with the prepared result.
