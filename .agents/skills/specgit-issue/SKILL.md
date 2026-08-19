---
name: specgit-issue
description: Start a SpecGit delivery — create or reuse GitHub issues, branch, draft PR that closes them, and record the binding, in one command.
allowed-tools: Bash(specgit:*), Bash(git:*), Bash(gh:*)
license: MIT
metadata:
  author: specgit
---

# specgit-issue

The delivery bootstrap. One command binds the whole aggregate: N issues, one
branch, one draft pull request, one record (`.specgit.yaml`).

## Usage

```bash
specgit issue "<title>"                 # create one issue and start
specgit issue "<title A>" "<title B>"   # N issues, one delivery
specgit issue 42                        # reuse an existing issue
```

## What it does (idempotent; re-run resumes)

1. Creates (or reuses) the issues — one issue = one independently verifiable
   WHY.
2. Creates and checks out the delivery branch.
3. Opens a draft PR whose body closes every bound issue (`Closes #n`).
4. Writes `.specgit.yaml` and commits it.
5. Pushes the branch.

## Rules

- Run it from the repository root; context comes from live git.
- If it fails mid-chain, re-run the same command — completed steps are
  detected and resumed; never hand-edit `.specgit.yaml`.
