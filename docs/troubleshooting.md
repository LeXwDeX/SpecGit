# Troubleshooting

Concrete fixes for concrete problems. Most entries correspond to a diagnostic code — run with `--json` to see codes directly. If `specgit finish` exited `3`, fix the environment entries first; if it exited `1`, jump to the gate it named.

## Environment and setup

### `not_a_git_repo` (exit 3)

You are not inside a git repository. SpecGit has no fallback mode — `cd` into one (root discovery is `git rev-parse --show-toplevel`; any subdirectory works).

### `git_unavailable`

The `git` binary is missing or failing. Install git, then confirm `git status` works in the same shell.

### `gh_missing` (exit 3)

The GitHub CLI is not installed or not on `PATH`. Install `gh` (`brew install gh`, `gh` on your platform's package manager), then authenticate.

### `gh_unauthenticated` (exit 3)

`gh` is installed but not signed in, or the session expired:

```bash
gh auth login
gh auth status
```

SpecGit never reads or prints tokens — it relies entirely on your `gh` session.

### `gh_transport` (exit 3)

`gh` reached GitHub but the call failed (network, rate limit, server error, or the 15-second timeout). Retry; if it persists, run the same call by hand to see GitHub's message:

```bash
gh api repos/<owner>/<repo>
```

Rate-limit responses usually self-heal after the window resets.

### `no_origin` / `origin_unresolvable`

The repository has no `origin` remote, or it does not parse to a GitHub repository. Only `github.com` remotes resolve (HTTPS, SCP-style SSH, or `ssh://`). Check:

```bash
git remote get-url origin
```

Fix the remote (`git remote set-url origin https://github.com/<owner>/<repo>.git`); non-GitHub hosts are unsupported in this version.

## Record and policy

### `record_missing`

No `.specgit.yaml` at the repository root. Bootstrap first: `specgit issue "<type>: <title>" <n>`.

### `record_invalid`

The record failed validation. Read the message — it names the field. Typical causes: `version` is not `1`; `delivery` is not kebab-case; `context.kind` is neither `branch` nor `worktree`; `issues` contains non-positive numbers; a worktree `label` is a local path. Fix the named field; `specgit bind` rewrites the file safely.

### `policy_missing`

No `spec_git/policy.yaml`. Run `specgit init --required-check "<name>"` and commit the result.

### `policy_invalid`

The policy failed validation. The list of `required_checks` must be non-empty with non-empty names, and the file must not contain unknown keys (the policy schema is strict). Recreate it with `init` if in doubt.

## Completeness

### `issues_empty` (rejected)

The record has no issues. Bind at least one GitHub issue: re-run `specgit issue` with the issue numbers, or `specgit bind --issue <n>`.

### `pr_missing` (rejected)

The record has no PR. Re-run `specgit issue` to resume the bootstrap, or repair with `specgit pr` (auto-discovers the PR by head branch).

### `issue_ref_not_github` (bind fails)

You tried to bind a non-GitHub reference (e.g. `JIRA-123`). Only GitHub issue numbers and issue URLs bind. If the work is tracked elsewhere, open a GitHub issue that links out to it and bind that number.

## Context gates

### `detached_head`

HEAD is detached; there is no live branch to match. `git checkout <context-branch>` and re-run.

### `branch_mismatch`

The live branch differs from `context.branch`. You are in the wrong checkout for this record — switch branches, or if the branch was renamed, update the record's context with a fresh `specgit bind` on the new branch.

### `worktree_mismatch`

The record says `kind: worktree`, but the current checkout is not a linked worktree whose label resolves to the record's branch. Either run from the intended worktree (`git worktree list` shows them) or re-bind from this checkout so the context reflects reality.

### `no_commits`

The repository has no commits yet; there is no HEAD to evaluate. Make the first commit.

## Issues and PR

### `issue_not_found` (rejected)

GitHub has no such issue number in this repository. Check for a typo in `issues` or a wrong repository origin.

### `issue_is_pull_request` (rejected)

A bound "issue" number is actually a pull request. Bind the tracking issue, not the PR number.

### `pr_not_found` (rejected)

The PR number/URL does not exist in the repository the origin resolves to.

### `pr_closed_unmerged` (rejected)

The PR was closed without merging — the delivery is broken. Reopen the PR or bind its replacement.

### `pr_head_mismatch` (rejected)

The PR's head branch is not `context.branch`. The record and the PR must describe the same delivery: fix the PR's branch or re-bind from the correct checkout.

### `pr_repo_mismatch` (rejected)

The PR URL points at a different repository than `origin`. Bind a PR in this repository.

## Closing refs

### `closing_refs_incomplete` (rejected)

The PR body does not close every bound issue; the failure lists exactly which numbers are missing. Add a closing reference per issue to the PR body:

```markdown
Closes #124
```

Keyword variants (`fixes`, `resolves`, tenses) and `owner/repo#N` or full-URL forms all count. Note that `Related to #124` does **not** close anything.

## Checks

### `checks_missing` (rejected)

No check run with the policy's exact name exists at the PR head. Cause is almost always a naming gap between policy and CI. Compare:

```bash
gh api repos/<owner>/<repo>/commits/<pr-head-sha>/check-runs --jq '.check_runs[].name'
```

against `required_checks`. Fix the policy or the workflow's job `name:` — see the aggregator pattern in [GitHub Actions](actions.md).

### `checks_pending`

Check runs exist but haven't all completed. Wait for CI, then re-run `specgit finish`.

### `checks_failed` (rejected)

The named check reported a non-success conclusion at the PR head. Open the run's logs, fix the failure (or the flaky test), push, and re-run acceptance — checks are re-read from the new PR head.

## Verdict behaviors

### Exit 3 with `unknown` but "everything looks fine"

`unknown` means evidence could not be gathered — record/policy problems, provider problems, or not a git repo. `specgit doctor --json` names the first failing probe.

### `local_head_stale` warning

Informational: your checkout is behind or ahead of the PR head. Acceptance still evaluates the PR head. Push your commits (if they belong in the delivery) or ignore the warning.

### Verdict differs from GitHub's merge-requirement UI

SpecGit matches `required_checks` byte-for-byte against check runs; the branch-protection UI may display status contexts differently. Align names per `checks_missing` above, and keep branch protection and the policy listing the same aggregator check.
