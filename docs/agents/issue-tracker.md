# Issue Tracker

The tracker for this repository is **GitHub Issues on `LeXwDeX/SpecGit`**:
https://github.com/LeXwDeX/SpecGit/issues

There is no external board. If it is not a GitHub issue, it is not work.

```text
  specgit issue "<type>: <title>"   the delivery starts here: issues +
        |                           branch + draft PR (Closes #n) + record
        v
  TDD slices -> push -> CI (SpecGit Acceptance = finish --json)
        |
        v
  gh pr ready <n> -> specgit finish --(exit 0)--> merge (issues auto-close)
        '-- exit 1/3 -> fix what the verdict names; never bypass the gate
```

## gh CLI workflow

All tracker operations go through the authenticated `gh` CLI — the same
provider seam SpecGit itself uses for GitHub evidence. No tokens, no direct
REST calls.

```bash
# triage
gh issue list --repo LeXwDeX/SpecGit --state open
gh issue view <n> --repo LeXwDeX/SpecGit

# create/reuse the issue and establish the delivery binding before edits
specgit issue "fix: describe the verified defect" --body-file <prepared-body.md>
# fill the issue body from the agreed Why / Scope / Approach / Acceptance
gh issue edit <n> --repo LeXwDeX/SpecGit --body-file <prepared-body.md>

# deliver — SpecGit deliveries bootstrap their own PR
# (specgit issue uses the selected policy template or built-in scaffold,
#  preserves every Closes #n reference, and never overwrites an existing PR body)
gh pr view <n> --repo LeXwDeX/SpecGit --json state,headRefName
gh pr checks <n> --repo LeXwDeX/SpecGit
```

Closing references follow the CLI contract: `Closes #N`, `Fixes #N`,
`Resolves #N` in the PR body, one per bound issue.

## Duplicate check before creation

Before creating a new issue, search for similar open and closed work (`gh issue list`,
`gh search issues` with title keywords), read every plausible candidate
(`gh issue view <n>`), and compare the WHY — not the wording. Same WHY:
continue the existing issue. Close but different: say how they differ.
Unsure: let the requester decide. One line of work per WHY, never two.

## Label vocabulary

Bootstrap infers one catalog label from each new title's type:

| Label | Meaning | Title/branch type |
| --- | --- | --- |
| `kind::feat` | New capability | `feat` |
| `kind::fix` | Defect in shipped behavior | `fix` |
| `kind::docs` | Documentation-only change | `docs` |
| `kind::refactor` | Structure change without a behavior change | `refactor` |
| `kind::chore` | Routine tooling or maintenance | `chore` |

The complete type catalog and pool-first selection rules live in
[the CLI reference](../cli.md#specgit-issue). Use `--tags` for an explicit set;
project extras belong in the policy's `tags` declarations. At most one member
per scoped axis is allowed. When project label validation is enabled, every
applied label must also satisfy [the configured rule](../cli.md#project-title-and-label-rules).

The binding created by `specgit issue` establishes delivery work; no separate
`delivery` label is required. One issue is one independently verifiable WHY.
One PR may close N issues; every bound issue needs its own closing reference
or `specgit finish` rejects with `closing_refs_incomplete`. Follow
[the development loop](../../workflows/specgit-dev-loop.md) for execution and
[the quality loop](../../workflows/quality-loop.md) for review and acceptance.

Closed history is evidence for regressions, not an issue to silently reopen.
Link relevant history when starting a new regression. An issue already claimed
by another open PR/MR cannot be bound to a competing delivery. Terminal failed
ready PRs create repair issues by cause; reuse an unresolved repair issue and
keep the original business issues open until delivery.
