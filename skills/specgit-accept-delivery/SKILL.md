---
name: specgit-accept-delivery
description: Drive a SpecGit delivery to an accepted verdict — verify the record, PR closing refs, and required checks; fix exactly what the gates name.
allowed-tools: Bash(specgit:*), Bash(git:*), Bash(gh:*)
license: MIT
compatibility: Requires the specgit CLI, git, and an authenticated gh session.
metadata:
  author: specgit
  version: "1.0"
---

Take the current delivery to acceptance. `specgit accept` derives the verdict
from real evidence — live git, the bound issues, the PR, and the required
checks at the PR head commit. Your job is to run it, interpret it honestly,
and fix exactly what it names.

## Preflight

```bash
specgit doctor --json
```

Fix any failing probe before evaluating (missing record/policy, `gh` not
authenticated, unresolvable origin). Then snapshot local state:

```bash
specgit status --json
```

Confirm: record complete (issues non-empty, `pr` set), branch matches
`context.branch`. A `draft` state means the delivery is not ready for
acceptance yet — finish binding first (skill `specgit-bind-delivery`).

## Closing references

Before running acceptance, verify the PR body closes **every** bound issue.
Fetch the body and compare against the record's `issues`:

```bash
gh pr view <number> --json body --jq .body
```

Every issue number needs a closing reference: keyword
(`Closes|Closed|Close|Fixes|Fixed|Fix|Resolves|Resolved|Resolve`,
case-insensitive) followed by `#N`, `owner/repo#N`, or the full issue URL.
`Related to #N` does not count.

If references are missing, edit the PR body (with the user's consent):

```bash
gh pr edit <number> --body-file <updated-body>
```

## Evaluate

```bash
specgit accept --json
```

Interpret strictly by exit code:

| Exit | Verdict | Your action |
| --- | --- | --- |
| `0` | accepted | Report accepted with the evidence summary from `verdict.evidence`. Done. |
| `1` | rejected | Read `verdict.gates[]` failures; fix each named cause, then re-run. |
| `3` | unknown | Evidence missing. Run `specgit doctor --json`, fix the environment, re-run. Never present this as success. |

## Fixing rejected gates

- `closing_refs_incomplete` — the failure lists the missing issue numbers; add
  closing references to the PR body.
- `checks_pending` — CI is not finished; wait and re-run.
- `checks_failed` — read the failing run's logs, fix the code, push; checks are
  re-read from the new PR head.
- `checks_missing` — the policy name is not a check GitHub reports for the PR
  head. Compare names:

```bash
gh api "repos/{owner}/{repo}/commits/{pr-head-sha}/check-runs" --jq '.check_runs[].name'
```

  and reconcile policy vs workflow job names per the GitHub Actions guidance.
- `branch_mismatch` / `worktree_mismatch` — check out the record's branch (or
  the right worktree); if the branch was genuinely renamed, re-bind there.
- `pr_head_mismatch` — the PR's head branch is not the record's branch; fix
  whichever side is wrong (never force the record to match a wrong PR without
  the user's explicit decision).
- `pr_closed_unmerged` — reopen the PR or bind its replacement.
- `issue_not_found` / `issue_is_pull_request` — correct the bound issue numbers.

Re-run `specgit accept --json` after every fix; verdicts are derived per
invocation and stale verdicts must not be reused.

## Hard rules

- Never edit `.specgit.yaml` or `spec_git/policy.yaml` to force a passing
  verdict. The gates verify against git and GitHub; editing the inputs is
  fabricating evidence.
- Never bypass, disable, or rename-around a required check to pass acceptance
  without the user's explicit decision.
- Never present exit `3` (`unknown`) as accepted.
- Local dirtiness and `local_head_stale` warnings do not block acceptance —
  checks are evaluated at the PR head; do not commit the user's unrelated
  changes to change the verdict.

See: [Reference](../../docs/reference.md), [Troubleshooting](../../docs/troubleshooting.md).
