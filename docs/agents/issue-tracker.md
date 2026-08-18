# Issue Tracker

The tracker for this repository is **GitHub Issues on `LeXwDeX/SpecGit`**:
https://github.com/LeXwDeX/SpecGit/issues

There is no external board. If it is not a GitHub issue, it is not work.

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

# deliver (body must close every bound issue)
gh pr create --repo LeXwDeX/SpecGit --fill
gh pr view <n> --repo LeXwDeX/SpecGit --json state,headRefName
gh pr checks <n> --repo LeXwDeX/SpecGit
```

Closing references follow the CLI contract: `Closes #N`, `Fixes #N`,
`Resolves #N` in the PR body, one per bound issue.

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
