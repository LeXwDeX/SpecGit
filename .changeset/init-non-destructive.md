---
'specgit': minor
---

Make `specgit init` non-destructive and governance-preserving (#62).

- All validation — flag checks, `--gitlab-host` validation, `policy_exists`, and a root-writability preflight — now happens before any filesystem or remote mutation. A rejected init leaves the repository byte-identical.
- The harness write is error-atomic: mid-sequence failures roll every target back to its pre-write bytes and modes.
- Existing hooks are merged, never overwritten: `.opencode/hooks.json` user entries and unknown keys are preserved (unparseable files left untouched with a warning), and a user git `pre-push` hook keeps its content with the specgit guard appended inside managed markers. The git hook installs via `git rev-parse --git-path hooks`, so linked worktrees and `core.hooksPath` (husky/lefthook) are respected.
- `--protect` is now read-modify-write: existing required checks, reviews (including dismissal rules), push restrictions, admin enforcement, and rule booleans are read and preserved, with `SpecGit Acceptance` the only addition. The warned-path fix guidance no longer prints a command that would clear reviews/restrictions.
- Re-init contract change: `init` with an existing policy exits 2 having written and probed nothing; `--force` rebuilds the policy and refreshes the harness (managed-block drift repair now happens on `--force`).
