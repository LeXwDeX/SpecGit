---
name: specgit-pr
description: Repair the SpecGit PR binding — auto-discover the pull request by head branch, or bind an explicit number.
allowed-tools: Bash(specgit:*), Bash(git:*), Bash(gh:*)
license: MIT
metadata:
  author: specgit
  version: "0.1.0"
---

# specgit-pr

Repairs the record's PR binding without touching issues or the branch.

## Usage

```bash
specgit pr              # auto-discover the PR for this head branch
specgit pr 123          # bind an explicit number (no platform round-trip)
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
