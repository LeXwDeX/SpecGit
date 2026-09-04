---
name: specgit-pr
description: Repair the SpecGit PR binding or complete a configured automatic merge.
allowed-tools: Bash(specgit:*), Bash(git:*), Bash(gh:*), Bash(glab:*)
license: MIT
metadata:
  author: specgit
---

<!-- specgit-managed-entry-point -->

# specgit-pr

Repairs the record's PR binding. With `--merge`, completes the configured
merge and issue closure after fresh evidence passes.

## Usage

```bash
specgit pr              # auto-discover the PR for this head branch
specgit pr 123          # bind an explicit number (no platform round-trip)
specgit pr --merge --json  # merge the bound PR when automation is enabled
```

## Steps

1. Run from the delivery branch:

   ```bash
   specgit pr --json
   ```

2. Branch on the result:
   - `exit 0` → the binding is repaired; resume the delivery.
   - `pr_not_found` → push the branch and re-run `specgit issue` to
     resume the bootstrap, then rerun this command.
   - `pr_ambiguous` → several open PRs share the head branch; bind one
     explicitly: `specgit pr <number>`.

## Rules

- `specgit pr` owns the PR binding; never hand-edit `.specgit.yaml`.
- `--json` is the only parse surface.

Continue within existing user authorization. With automation enabled, run
`specgit pr --merge --json`: it requires the configured target branch,
`finish` exit 0, and all CI checks passing at the current PR head; it confirms
the merge before closing bound issues when configured. `finish` is read-only.
Automation defaults to no. Only the user's own yes enables it through
`specgit init --automation yes --merge-target <branch>`; `init --force`
can change that choice. An agent must not choose yes for the user. When an
action lacks user authorization or platform permission, report the specific
missing permission with the prepared result.
