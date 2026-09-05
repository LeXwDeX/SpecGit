---
description: Diagnose the SpecGit environment probes and drive the exit-3 repair loop
---

<!-- specgit-managed-entry-point -->

# /specgit-doctor

Thin trigger for the exit-3 diagnostic loop. The canonical behavior lives in
the AGENTS.md SpecGit block; this command only launches it.

## Steps

1. Read the original `specgit finish --json` `errors[].code` and
   `errors[].fix`. Apply a record or delivery-state repair directly when
   that diagnostic names one.
2. For git, repository, origin, configured provider CLI/auth, or policy
   evidence, run from the repo root:

   ```bash
   specgit doctor --json
   ```

3. Read `probes[]`: every failing probe carries a `code` (git, repo,
   origin, gh/glab presence and auth, policy).
4. Fix exactly what the failing probe names, then re-run
   `specgit doctor --json` until exit 0.
5. Return to the verdict: `specgit finish --json`. Repair invalid state
   when a diagnostic names it; never weaken a valid policy or bypass evidence.
6. `--json` is the only parse surface.
