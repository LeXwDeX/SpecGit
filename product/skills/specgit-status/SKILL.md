---
name: specgit-status
description: Show local SpecGit evidence — record, delivery state, drift, origin — without contacting the platform.
allowed-tools: Bash(specgit:*), Bash(git:*)
license: MIT
metadata:
  author: specgit
---

<!-- specgit-managed-entry-point -->

# specgit-status

Local evidence only: the record, the delivery state, drift, and the origin.
Platform evidence (issues, PR/MR, checks) belongs to `specgit finish`.

## Usage

```bash
specgit status --json
```

## Steps

1. Run from the repository root.
2. Read `state`, `recordState`, `localContext`, and `lifecycle` from
   the envelope. Inspect `evidence.delivery`, `evidence.context`,
   `evidence.issues`, `evidence.pr`, and the drift fields to see what is
   bound and what changed before touching anything.
3. No record is not an error: `state: "unbound"` with exit `0` is the
   normal pre-binding state (#175) — bootstrap with `specgit issue`; the
   `record_missing` warning names that next step in `warnings[].fix`.
   Exit `3` is different: a genuine evidence failure (`state: "unknown"`)
   happened; read `errors[].fix`.

## Rules

- Never hand-edit `.specgit.yaml`; repairs go through the commands.
- `--json` is the only parse surface.
