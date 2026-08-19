---
name: specgit-finish
description: Run the SpecGit evidence verdict — fail-closed acceptance derived from real git, PR, and CI evidence; exit 0 is the only done.
allowed-tools: Bash(specgit:*), Bash(git:*), Bash(gh:*)
license: MIT
metadata:
  author: specgit
---

# specgit-finish

The acceptance verdict. Eleven gates evaluate live evidence: record, policy,
completeness, context, origin, provider, issues, sequence (ordered
deliveries), PR, closing refs, and required checks at the PR head.

## Usage

```bash
specgit finish --json
```

## Exit contract

- `0` accepted — produce the merge brief and ask the human to approve.
- `1` rejected — each failure carries a `fix`; fix what the gates name,
  re-run until 0.
- `3` unknown — fix the environment; never touch the record or policy.

## Rules

- Evidence only: file contents can never change the verdict.
- Never weaken `spec_git/policy.yaml` to make a verdict pass.
- `--json` is the only parse surface.
