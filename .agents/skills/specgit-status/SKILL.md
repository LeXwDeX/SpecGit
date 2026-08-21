---
name: specgit-status
description: Show local SpecGit evidence — record, delivery state, drift, origin — without contacting the platform.
allowed-tools: Bash(specgit:*), Bash(git:*)
license: MIT
metadata:
  author: specgit
---

# specgit-status

Local evidence only: the record, the delivery state, drift, and the origin.
Platform evidence (issues, PR, checks) belongs to `specgit finish`.

## Usage

```bash
specgit status --json
```

## Steps

1. Run from the repository root.
2. Read `state` and `record` from the envelope: use them to see what is
   bound and what drifted before touching anything.
3. No record → bootstrap with `specgit issue`. On `exit 3` read
   `errors[].fix`.

## Rules

- Never hand-edit `.specgit.yaml`; repairs go through the commands.
- `--json` is the only parse surface.
