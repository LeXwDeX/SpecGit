---
description: Show local SpecGit evidence — record, delivery state, drift, origin
---

# /specgit-status

Thin trigger for local evidence. The canonical behavior lives in the
AGENTS.md SpecGit block; this command only launches it.

## Steps

1. Run from the repo root:

   ```bash
   specgit status --json
   ```

2. Read `state` and `record` from the envelope: local evidence only —
   record, drift, origin. Platform evidence (issues, PR, checks) belongs
   to `specgit finish`.
3. No record → bootstrap with `specgit issue`. On `exit 3` read
   `errors[].fix`. Never hand-edit `.specgit.yaml`.
