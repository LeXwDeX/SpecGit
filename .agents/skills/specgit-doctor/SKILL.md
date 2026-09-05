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

The exit-3 diagnostic loop. Exit code 3 means no verdict was possible because
required evidence is incomplete. Start with the original diagnostic; use the
doctor probes for the environment and provider evidence they cover.

## When to use

`specgit finish --json` exited `3` (unknown). The `errors[].code` names
the failing gate; the loop below resolves it.

## Steps

1. Read the original `specgit finish --json` `errors[].code` and
   `errors[].fix`. If it names an invalid record or delivery state, apply
   that repair directly; doctor does not inspect every acceptance input.
2. For git, repository, origin, configured provider CLI/auth, or policy
   evidence, run the probes from the repository root:

   ```bash
   specgit doctor --json
   ```

3. Read `probes[]`: each failing probe carries a `code` — git binary,
   repository, origin, gh/glab presence and auth, policy.
4. Apply the fix the failing probe names:
   - `git` missing → install the git binary or fix PATH.
   - `repo` → run from the repository root.
   - `no_origin` / origin parse → configure a parseable origin remote.
   - `gh_missing` / `glab_missing` → install the platform CLI.
   - gh/glab auth → follow the failing probe's fix: `gh auth login`, or
     `glab auth login --hostname <host>`.
   - `policy` missing → run `specgit init`.
5. Re-run `specgit doctor --json` until exit 0.
6. Return to the verdict: `specgit finish --json`.

## Rules

- Exit 3 means evidence is incomplete. Repair invalid state only when the
  diagnostic names it; never weaken a valid policy or bypass evidence.
- `--json` is the only parse surface — parse the envelope, never
  human-readable lines.
- Do not loop on `finish` blindly; follow its diagnostic, then use doctor
  for the probe set above.
