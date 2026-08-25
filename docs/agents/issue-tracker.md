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
  gh pr ready <n> -> specgit finish --exit 0--> merge (issues auto-close)
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

# file and bind
gh issue create --repo LeXwDeX/SpecGit --title "…" --label bug
gh issue edit <n> --repo LeXwDeX/SpecGit --add-label delivery

# deliver — SpecGit deliveries bootstrap their own PR
# (specgit issue writes the deterministic scaffold with Closes #n;
#  never hand-create a delivery PR with `gh pr create --fill`, which
#  would pull in the repository's own PR template)
gh pr view <n> --repo LeXwDeX/SpecGit --json state,headRefName
gh pr checks <n> --repo LeXwDeX/SpecGit
```

Closing references follow the CLI contract: `Closes #N`, `Fixes #N`,
`Resolves #N` in the PR body, one per bound issue.

## Duplicate check before creation

Before creating a new issue, search for similar open work (`gh issue list`,
`gh search issues` with title keywords), read every plausible candidate
(`gh issue view <n>`), and compare the WHY — not the wording. Same WHY:
continue the existing issue. Close but different: say how they differ.
Unsure: let the requester decide. One line of work per WHY, never two.

## Label vocabulary

| Label | Meaning | Branch `<type>` |
| --- | --- | --- |
| `feature` | New capability | `feat` |
| `bug` | Defect in shipped behavior | `fix` |
| `docs` | Documentation-only change | `docs` |
| `chore` | Tooling, dependencies, refactors with no behavior change | `chore` |
| `delivery` | Issue is delivery-bound: assigned for work and enters the dev loop | — |

`delivery` plus an assignee is the trigger defined in
[workflows/specgit-dev-loop.md](../../workflows/specgit-dev-loop.md). One PR
may close N issues; every bound issue needs its own closing reference in the
PR body or `specgit finish` will reject with `closing_refs_incomplete`.
