---
name: specgit-finish
description: Run the SpecGit evidence verdict — fail-closed acceptance derived from real git, PR, and CI evidence; exit 0 is the only done.
allowed-tools: Bash(specgit:*), Bash(git:*), Bash(gh:*)
license: MIT
metadata:
  author: specgit
  version: "0.1.0"
---

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

- `0` accepted — all gates pass. Produce the merge brief (issues + PR + CI
  links + verdict) and ask the human to approve the merge.
- `1` rejected — factual failures. Each failure carries a `fix`; fix exactly
  what the gates name, then re-run. Loop until 0.
- `3` unknown — evidence could not be gathered (gh auth, network). Fix the
  environment; never touch the record or policy.

## Rules

- Evidence only: file contents (specs, tasks, checklists) can never change
  the verdict.
- Never weaken `spec_git/policy.yaml` to make a verdict pass.
- A non-zero verdict never merges; in CI this job is the required check
  *SpecGit Acceptance*.
- `--json` is the only parse surface: stdout is exactly one JSON document.
