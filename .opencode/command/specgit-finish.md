---
description: Run the SpecGit evidence verdict and drive the fix loop to exit 0
---

<!-- specgit-managed-entry-point -->

# /specgit-finish

Thin trigger for the acceptance verdict. The canonical behavior lives in the
AGENTS.md SpecGit block; this command only launches it.

For a declared programme, also run `specgit finish --scope <name> --json`.
Its `scope` result is independent of the current delivery verdict; report
programme completion only when that scope is completed.

## Steps

1. Complete the authorized PR/MR body and mark the request ready for review, then
   run from the delivery branch:

   ```bash
   specgit finish --json
   ```

2. Branch on the exit code:
   - `exit 0` → report issues, PR/MR, CI run links, and the verdict; continue
     the authorized merge through the guidance below.
   - `exit 1` → read `errors[].fix` / gate failures, fix exactly what they
     name, re-run. Loop until exit 0.
   - `exit 3` → read `errors[].fix` first and repair the named evidence.
     Use `specgit doctor --json` for git, repository, origin, configured
     provider CLI/auth, or policy probes, then retry the verdict.
3. Iron rules: never weaken `spec_git/policy.yaml` to pass; `--json` is the
   only parse surface; a non-zero verdict never merges.

Continue within existing user authorization. With automation enabled, the
trusted remote completion workflow continues after CI without another user
confirmation. `specgit pr --merge --json` is its recovery path. It requires
the approved target policy, `finish` exit 0, and all CI checks passing at the
current PR/MR head. Completion confirms the merge and closure of every bound
issue and verified derived repair; a partial closure remains recoverable. Independent issue closure uses
`specgit pr --close-issues --json` after a confirmed manual merge into the approved
`automation.target_branch`; it never merges an open request. `finish` is read-only and
exit 0 means accepted, not necessarily completed. A failed delivery is tracked
by a repair issue; retries reuse that cause and preserve the original PR/MR.
Pending repair intents are reconciled by the trusted remote runner. When original
repair evidence cannot be restored, preserve its Closes reference and explicitly
adopt it with `specgit bind --issue <number>` before reviewing the delivery.
Automation defaults to no. Only the user's own yes enables it. A fresh policy
uses `specgit init --automation yes --merge-target <branch>`; an existing policy
uses `specgit init --force --automation yes --merge-target <branch>`. Ordinary
`init --force` preserves that choice and target. Independent closure uses `init --force --automation no --close-issues yes --close-target <branch>`.
An agent must not choose yes for the user. When an
action lacks user authorization or platform permission, report the specific
missing permission with the prepared result.
