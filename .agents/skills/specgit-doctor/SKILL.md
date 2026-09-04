---
name: specgit-doctor
description: Resolve a SpecGit exit 3 — run the doctor probes, apply each fix, re-run until the verdict can run again.
allowed-tools: Bash(specgit:*), Bash(git:*), Bash(gh:*), Bash(glab:*)
license: MIT
metadata:
  author: specgit
---

<!-- specgit-managed-entry-point -->

# specgit-doctor

The exit-3 diagnostic loop. Exit code 3 means no verdict was possible — the
environment, not the delivery, is broken. Retrying `finish` blindly will
never pass; the probes tell you what to fix.

## When to use

`specgit finish --json` exited `3` (unknown). The `errors[].code` names
the failing gate; the loop below resolves it.

## Steps

1. Run the probes from the repository root:

   ```bash
   specgit doctor --json
   ```

2. Read `probes[]`: each failing probe carries a `code` — git binary,
   repository, origin, gh/glab presence and auth, policy.
3. Apply the fix the failing probe names:
   - `git` missing → install the git binary or fix PATH.
   - `repo` → run from the repository root.
   - `no_origin` / origin parse → configure a parseable origin remote.
   - `gh_missing` / `glab_missing` → install the platform CLI.
   - gh/glab auth → `gh auth login` (or `glab auth login`).
   - `policy` missing → run `specgit init`.
4. Re-run `specgit doctor --json` until exit 0.
5. Return to the verdict: `specgit finish --json`.

## Rules

- Exit 3 is environment, never delivery: never edit the record or the
  policy to work around a probe.
- `--json` is the only parse surface — parse the envelope, never
  human-readable lines.
- Do not loop on `finish` itself; always go through the probes first.
