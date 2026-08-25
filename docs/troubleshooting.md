# Troubleshooting

Concrete fixes for concrete problems. Most entries correspond to a diagnostic code — run with `--json` to see codes directly. If `specgit finish` exited `3`, fix the environment entries first; if it exited `1`, jump to the gate it named.

```text
  specgit init / setup      once per repository: policy + acceptance
        |                   harness + agent entry points
        v
  specgit issue "..."       per delivery: issues + branch +
        |                   draft PR (Closes #n) + record,
        |                   committed and pushed (idempotent resume)
        v
  work, commit, push -----> CI on the PR head
        |                   (the SpecGit Acceptance job runs
        |                    specgit finish --json)
        v
  gh pr ready <n>           a draft PR always fails the verdict
        |
        v
  specgit finish            the verdict: eleven gates, fail-closed
        |-- exit 0 --> merge: done (exit 0 is the only done)
        |-- exit 1 --> fix what the gates named (evidence complete)
        '-- exit 3 --> fix the environment first (specgit doctor)
```

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

`gh` reached GitHub but the call failed (network, rate limit, server error, or the per-call timeout). Retry; if it persists, run the same call by hand to see GitHub's message:

```bash
gh api repos/<owner>/<repo>
```

If calls are timing out on a slow network, raise the per-call budget with `SPECGIT_GH_TIMEOUT_MS` (milliseconds; default `15000`). Rate-limit responses usually self-heal after the window resets.

### `gh_timeout` (exit 3)

A `gh` call exceeded its time budget (default 15 s) and was killed. The fix
attributes the three likely causes in order:

1. **Network** — `curl -sI https://api.github.com` should answer quickly.
2. **A GitHub incident** — check <https://www.githubstatus.com>.
3. **A genuinely slow call** (huge repo, slow link) — raise the budget:
   `SPECGIT_GH_TIMEOUT_MS=60000 specgit issue ...` (milliseconds; applies to
   every `gh` invocation SpecGit spawns).

### `glab_missing` (exit 3)

The origin is a declared self-managed GitLab host, but the `glab` CLI is not installed or not on `PATH`. Install `glab` (**≥ 1.113.0**) and authenticate for that host:

```bash
glab auth login --hostname <host>
glab auth status --hostname <host>
```

### `glab_unauthenticated` (exit 3)

`glab` is installed but has no session for the declared host. Glab authenticates per host — sign in for exactly the host named in `spec_git/providers.yaml`:

```bash
glab auth login --hostname <host>
```

SpecGit never reads or prints tokens — it relies entirely on your `glab` session.

### `glab_transport` (exit 3)

`glab` reached the GitLab instance but the call failed (network, rate limit, server error, or the per-call timeout). Retry; if it persists, run the same call by hand to see the server's message. On a slow network raise the per-call budget with `SPECGIT_GLAB_TIMEOUT_MS` (milliseconds; default `15000`). A call that exceeds the budget is killed and lands here too, carrying an attributed fix that names the three likely causes in order: network reachability of the host, a GitLab incident, a genuinely slow call.

### `no_origin` / `origin_unresolvable`

The repository has no `origin` remote, or it does not parse to a GitHub repository. Only `github.com` remotes resolve on the GitHub route (HTTPS, SCP-style SSH, or `ssh://`), each also with its scheme-default port spelled out (`https://github.com:443/…`, `ssh://git@github.com:22/…`). Any other explicit port fails closed unless the GitLab declaration names it (next entry). Check:

```
git remote get-url origin
```

Fix the remote (`git remote set-url origin https://github.com/<owner>/<repo>.git`); a self-managed GitLab repository becomes resolvable once its host is declared (next entry) and its evidence then flows through `glab`.

### `gitlab_unsupported` (exit 1)

The origin points at a GitLab host that is **not declared** — `gitlab.com`, a
`*gitlab*` host with no entry in `spec_git/providers.yaml`, or a path outside
the declared grammar. The classification is decisive: the origin evidence is
complete and says the platform is GitLab, so the verdict is rejected with exit 1
(the same factual class as `origin_unresolvable` — the dedicated code names the
actual platform gap instead of guessing).

A **declared** self-managed GitLab origin needs no workaround — full support
shipped with the glab adapter (#114) and per-platform routing (#117): every gate
evaluates through the authenticated `glab` CLI. To adopt one:

1. Declare the host: `specgit init --force --gitlab-host <hostname>` (or
   `<hostname>:<port>` for a non-default port; the upgrade run preserves your
   existing checks, #310).
2. Install `glab` ≥ 1.113.0 and authenticate for that host (entries above).
3. Mind the verified window: self-managed **GitLab CE/Free
   `>= 19.2.4 < 19.4.0`**; a version outside it warns
   (`gitlab_version_unverified`) while evaluation proceeds against the live
   APIs, and real API failures still fail closed (exit 3). Every claim is
   pinned in the [evidence ledger](evidence/gitlab-19.2.md) — see
   [GitLab support](gitlab-support.md).

Alternatively point origin at a github.com repository. Nested-group paths
(`group/subgroup/project`, any depth ≥ 2) resolve on declared hosts (#112);
an undeclared `*gitlab*` host never resolves — the substring heuristic is
deliberately not a guess.

## Record and policy

### `record_missing`

No `.specgit.yaml` at the repository root. Bootstrap first: `specgit issue "<type>: <title>" <n>`.

Since #175, `specgit status` treats this as the normal pre-binding state:
exit `0` with state `unbound` and a warning carrying the fix — not the
fail-closed exit `3`. Every other command (`finish`, `accept`, `pr`, …)
still fails closed on it, because they cannot evaluate a delivery that has
not been bound.

### `record_invalid`

The record failed validation. Read the message — it names the field. Typical causes: `version` is not `1`; `delivery` is not kebab-case; `context.kind` is neither `branch` nor `worktree`; `issues` contains non-positive numbers; a worktree `label` is a local path. Fix the named field; `specgit bind` rewrites the file safely.

### `policy_missing`

No `spec_git/policy.yaml`. Run `specgit init --required-check "<name>"` and commit the result.

### `policy_invalid`

The policy failed validation. Each `required_checks` name must be a non-empty string — the list itself may be empty (the no-CI policy) — and the file must not contain unknown keys (the policy schema is strict). Recreate it with `init` if in doubt.

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

One structural cause needs the **policy** repaired, not the workflow: a check from a workflow that never runs on PR heads (push-only, branch-filtered, or scheduled). Only workflows whose triggers include `pull_request` or `pull_request_target` report check runs on a PR head, so such a name can never go green — every delivery would fail `checks_missing` forever. Fix it with `specgit init --force` (re-detects under the PR-trigger trust boundary; `init` warns `checks_not_pr_visible` when such workflows exist) or a reviewed policy edit. Correcting a policy that was wrong at birth is the required repair, not a weakening — see [Reference](reference.md).

### `checks_pending` (exit 1 — transient)

Check runs exist but haven't all completed, or the provider's truth run predates
the delivery's reviewable-transition anchor. This is a **transient, retryable**
non-acceptance, not a defect: the evidence is complete and says "not yet".
Wait for the fresh check generation to finish, then re-run `specgit finish` —
checks and the anchor are re-read from the PR head, so no repair work is needed
unless a check then *fails*.

### `checks_failed` (rejected)

The named check reported a non-success conclusion at the PR head. Open the run's logs, fix the failure (or the flaky test), push, and re-run acceptance — checks are re-read from the new PR head.

## Verdict behaviors

### Exit 130 after Ctrl-C

Interrupting an interactive prompt (e.g. `init`'s protection confirmation) with
Ctrl-C exits `130` after printing `Interrupted.` to stderr. This is the one
documented interruption exception to the exit-code contract: no JSON envelope
is emitted — stdout stays empty — and no verdict was reached. Re-run the
command; nothing was half-applied (interactive confirmations happen before
mutations).

### Exit 3 with `unknown` but "everything looks fine"

`unknown` means evidence could not be gathered — record/policy problems, provider problems, or not a git repo. `specgit doctor --json` names the first failing probe.

### `local_head_stale` warning

Informational: your checkout is behind or ahead of the PR head. Acceptance still evaluates the PR head. Push your commits (if they belong in the delivery) or ignore the warning.

### Verdict differs from GitHub's merge-requirement UI

SpecGit matches `required_checks` byte-for-byte against check runs; the branch-protection UI may display status contexts differently. Align names per `checks_missing` above, and keep branch protection and the policy listing the same aggregator check.
