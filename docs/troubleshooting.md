# Troubleshooting

Concrete fixes for concrete problems. Most entries correspond to a diagnostic code — run with `--json` to see codes directly. If `specgit finish` exited `3`, follow each `errors[].fix`; use the environment entries only for git, repository, origin, routed forge CLI, authentication, or policy probes. If it exited `1`, jump to the gate it named.

```text
  specgit init / setup      initialize once; rerun after upgrades
        |                   harness + agent entry points
        v
  specgit issue "..."       per delivery: issues + branch +
        |                   draft PR/MR (Closes #n) + record,
        |                   committed and pushed (idempotent resume)
        v
  work, commit, push -----> CI/CD on the request head
        |                   (the platform acceptance job runs
        |                    specgit finish --json)
        v
  mark PR/MR ready          a draft request always fails the verdict
        |
        v
  specgit finish            the verdict: eleven gates, fail-closed
        |-- exit 0 --> accepted -> merge -> confirmed issue closure: completed
        |-- exit 1 --> fix what the gates named (evidence complete)
        '-- exit 3 --> follow errors[].fix; use doctor for its probes
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

The origin is an explicitly declared GitLab host, including GitLab.com, but the `glab` CLI is not installed or not on `PATH`. Install `glab` (**≥ 1.113.0**) and authenticate for that host:

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

### `gitlab_version_unverified` (warning)

The declared self-managed instance is outside the verified
`>= 19.2.4 < 19.4.0` window. This warning does not reject an otherwise valid
delivery. SpecGit continues against the live APIs and still fails closed if any
required response is missing or invalid. Follow the
[rebaseline policy](gitlab-support.md#rebaseline-sop-moving-the-version-window)
when admitting a new version. GitLab.com uses capability probing and does not
emit this version-window warning.

### `evidence_truncated` (exit 3)

A list-shaped provider result could not be proven complete: pagination stopped,
a continuation failed, or a bounded provider window was exhausted. Do not treat
the visible subset as evidence. Restore the provider call or reduce the active
list where the diagnostic recommends it, then retry. This guard applies to
issue history and occupancy, open-issue sequence checks, check runs, and other
paginated forge facts.

### `no_origin` / `origin_unresolvable`

The repository has no `origin` remote, or it does not parse to a GitHub repository. Only `github.com` remotes resolve on the GitHub route (HTTPS, SCP-style SSH, or `ssh://`), each also with its scheme-default port spelled out (`https://github.com:443/…`, `ssh://git@github.com:22/…`). Any other explicit port fails closed unless the GitLab declaration names it (next entry). Check:

```
git remote get-url origin
```

Fix the remote (`git remote set-url origin https://github.com/<owner>/<repo>.git`); a self-managed GitLab repository becomes resolvable once its host is declared (next entry) and its evidence then flows through `glab`.

### `platform_undecided` / `platform_unsupported` (`init`, exit 3)

Init could not select a supported provider before mutation. Only exact
`github.com` origins select GitHub automatically. For any GitLab origin, rerun
with the exact `--gitlab-host <hostname>` (including a non-default port when
used), or use the interactive prompt to confirm that endpoint as GitLab. The
prompt cannot select GitHub Enterprise because v1 has no GHE route. A missing
or unusable origin and an unsupported interactive choice leave every file
unchanged.

### `platform_providers_invalid` / `platform_providers_unreadable` (`init`, exit 3)

`spec_git/providers.yaml` exists but cannot be parsed or read, so init cannot
trust an origin heuristic over it. Repair the file against its strict schema or
restore a known-good version. Even an explicit `--gitlab-host` will not
overwrite these bytes; init stops before policy, workflow, ignore, or hook
writes.

### `providers_write_failed` (`init`, exit 3)

Init selected GitLab but could not persist the provider declaration. It restores
the exact pre-run declaration bytes and mode, or removes a declaration created
by that failed attempt, then stops before later init writes. Fix the reported
path or parent-directory permissions and rerun. If compensation itself fails,
`providers_restore_failed` is reported alongside the original error and the
named path needs manual recovery from version control or backup.

### `workflow_default_branch_unknown` (`init`, exit 3)

The acceptance workflow and branch-protection target require a remotely proved
default branch. Fetch origin and establish a valid `origin/HEAD`, then rerun
init. SpecGit does not guess `main`; `--merge-target` configures the automation
destination but cannot replace default-branch identity. This refusal happens
before any policy, workflow, or protection mutation.

### `gitlab_unsupported` (exit 1)

The origin points at a GitLab host that is **not declared** — `gitlab.com`, a
`*gitlab*` host with no entry in `spec_git/providers.yaml`, or a path outside
the declared grammar. The classification is decisive: the origin evidence is
complete and says the platform is GitLab, so the verdict is rejected with exit 1
(the same factual class as `origin_unresolvable` — the dedicated code names the
actual platform gap instead of guessing).

A **declared** GitLab origin needs no workaround — full support
shipped with the glab adapter (#114) and per-platform routing (#117): every gate
evaluates through the authenticated `glab` CLI. To adopt one:

1. Declare the host: `specgit init --force --gitlab-host <hostname> --no-protect` (or
   `<hostname>:<port>` for a non-default port; the upgrade run preserves your
   existing checks, #310). Append `--no-ignore` for the intentionally tracked
   authoritative model.
2. Install `glab` ≥ 1.113.0 and authenticate for that host (entries above).
3. Mind the verified window: self-managed **GitLab CE/Free
   `>= 19.2.4 < 19.4.0`**; a version outside it warns
   (`gitlab_version_unverified`) while evaluation proceeds against the live
   APIs, and real API failures still fail closed (exit 3). Every claim is
   pinned in the [evidence ledger](evidence/gitlab-19.2.md) — see
   [GitLab support](gitlab-support.md).

Alternatively point origin at a github.com repository. Nested-group paths
(`group/subgroup/project`, total project-path depth 2–5) resolve on declared hosts (#112);
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

The record failed validation. Read the message — it names the field. Typical causes: `version` is not `1`; `delivery` is not kebab-case; `context.kind` is neither `branch` nor `worktree`; `issues` contains non-positive numbers; a worktree `label` is a local path. Restore it from Git or a known-good copy, or fix the named field against the schema. `bind`, `issue`, and `pr` all refuse invalid record bytes. If you deliberately abandon the old binding, move the invalid `.specgit.yaml` to a backup path, then start a fresh delivery with `specgit issue`.

### `policy_missing`

No `spec_git/policy.yaml`. Run `specgit init --required-check "<name>"` and commit the result.

### `policy_exists` (`init`, exit 2)

The repository already has a policy and no explicit force refresh ran. After a
package upgrade, interactive human `specgit init` first uses the shared read-only
inspector. It asks to upgrade only when a required init asset or an already
installed setup surface is proven stale or missing. A detected ownership
conflict returns `asset_conflict` (exit 3) before the question or any write and
names the path to move or remove. Answering no
leaves all files untouched and returns this guidance. A current installation
does not prompt and returns the same guidance; a deliberately absent setup
surface alone does not count as drift. An incomplete or failed inspection cannot
authorize the prompt or a write and also returns this guidance.

`--json` and non-TTY runs never ask or mutate implicitly. Use the deterministic
repair sequence instead:

```bash
specgit init --force --no-protect
specgit setup --tool all
specgit status --json
```

Append `--no-ignore` to init when authoritative delivery files are intentionally
tracked without the managed ignore block; setup detects and preserves that
proven model.

This preserves omitted policy and automation choices and skips remote protection.
If setup fails after init succeeded, the init-owned changes remain applied. Fix
the reported setup conflict or filesystem problem, run
`specgit setup --tool all`, and verify with `specgit status --json`. Re-run the full explicit sequence
only when restarting automation from its first step. The tools preserve unowned
files at conflicting managed paths; resolve their ownership deliberately rather
than overwriting them. Guided `init` reports that conflict before it starts
either writer. Explicit init/setup also re-read each whole-file target at commit
time and re-prove ownership before replacement or removal. If bytes changed
after planning, they are preserved and earlier mutations in that transaction
roll back; inspect the reported path instead of retrying over the user edit.

### `upgrade_answer_invalid` (`init`, exit 2)

The guided-upgrade question received something other than yes/y or no/n. No
managed file was written. Run plain `specgit init` again and answer one of those
choices, or use the deterministic `init --force --no-protect`,
`setup --tool all`, `status --json` sequence above. Add `--no-ignore` to init for the
intentionally tracked authoritative model.

### `policy_invalid`

The policy failed validation. Each `required_checks` name must be a non-empty string — the list itself may be empty (the no-CI policy) — and the file must not contain unknown keys (the policy schema is strict). Restore it from Git or a known-good copy, or repair the named field against the schema. `init`, including `init --force`, refuses invalid policy bytes. If you deliberately replace the policy, move the invalid `spec_git/policy.yaml` to a backup path, then run fresh `init`.

### `harness_stale` (exit 2)

`specgit issue` refused because an acceptance-critical remote harness surface is stale, conflicting, or only partially present for the running CLI version. Today that means the managed `specgit-accept` or trusted `specgit-complete` workflow family, not local AGENTS guidance, guard hooks, or setup entry points. Local integration drift produces the non-blocking `local_assets_stale` warning instead. Run `specgit status --json`, then apply its init repair; append `--no-ignore` for the intentionally tracked authoritative model. A conflict is preserved until a human resolves ownership. A repository with every remote harness asset absent is a fresh adoption and bootstrap proceeds.

## Completeness

### `issues_empty` (rejected)

The record has no issues. Bind at least one positive issue number from the routed forge: re-run `specgit issue` with the issue numbers, or `specgit bind --issue <n>`.

### `pr_missing` (rejected)

The record has no PR. Re-run `specgit issue` to resume the bootstrap, or repair with `specgit pr` (auto-discovers the PR by head branch).

### `issue_ref_not_github` (bind fails)

You tried to bind an unsupported reference such as `JIRA-123`. The diagnostic
keeps its compatibility name, but positive numeric issue IDs work on GitHub and
declared GitLab because they are interpreted in the routed forge. Full issue URL
input is currently GitHub-only. If work lives elsewhere, create a thin issue on
the repository's forge that links to it and bind that number.

## Context gates

### `detached_head`

HEAD is detached; there is no live branch to match. `git checkout <context-branch>` and re-run.

### `branch_mismatch`

The live branch differs from `context.branch`. You are in the wrong checkout for this record — switch branches, or if the branch was renamed, update the record's context with a fresh `specgit bind` on the new branch.

### `merged_delivery_not_contained` (exit 1)

The forge confirms that the bound PR/MR merged, but local HEAD is known not to
contain its validated merge anchor. Fetch and check out the actual target branch
that received the merge, then pull and re-run `specgit finish`. A rewritten
local history cannot prove completion.

### `merged_lineage_unavailable` (exit 3)

The provider or local git could not supply a usable merge anchor or containment
answer. Fetch the remote and pull the target branch so the provider-reported
merge object is available locally, then retry. Missing lineage is unknown
evidence; it cannot be treated as either a completed delivery or a factual
branch mismatch.

### `worktree_mismatch`

The record says `kind: worktree`, but the current checkout is not a linked worktree whose label resolves to the record's branch. Either run from the intended worktree (`git worktree list` shows them) or re-bind from this checkout so the context reflects reality.

### `no_commits`

The repository has no commits yet; there is no HEAD to evaluate. Make the first commit.

## Issues and PR/MR

### `issue_not_found` (rejected)

The routed forge has no such issue number in this repository. Check for a typo in `issues` or a wrong repository origin.

### `issue_is_pull_request` (rejected)

A bound "issue" number identifies a pull request or merge request. Bind the tracking issue, not the request number.

### `issue_already_claimed` (exit 1)

Another active PR/MR already has a scoped closing reference for a bound issue.
Continue that delivery, or resolve its binding and request state before accepting
a second request for the same WHY. Draft requests count as active occupancy.

### `issue_occupancy_unknown` (exit 3)

SpecGit could not exhaust or validate all active PR/MR relationships for a bound
issue. Restore provider evidence and retry; a partial list cannot prove that the
issue is free.

### `title_language_mismatch` (exit 1)

An issue or PR/MR title violates the policy's enabled character rule. For
`language: en`, remove Han characters. For `language: zh`, include at least one
Han character; English technical names may remain. Edit the remote title and
re-run `specgit finish`.

### `title_evidence_missing` (exit 3)

The provider did not return the nonempty title required by enabled validation.
Restore the forge response or permissions and retry. During bootstrap the same
missing evidence fails closed before mutation.

### `issue_labels_invalid` (exit 1)

The live issue labels violate the configured `kind` or `project` vocabulary or
contain more than one label on a scoped axis. Select labels declared by policy,
remove conflicts, and retry. Never weaken policy just to admit an accidental
label.

### `issue_labels_unavailable` (exit 3)

The provider could not return a complete label set while label validation was
enabled. Restore permissions or pagination evidence and retry.

### `body_content_incomplete` (exit 1)

An enabled issue or PR/MR body rule found an empty required H2 section or a known
TODO/TBD/scaffold placeholder. Fill the selected template with actual delivery
content. During creation this is a usage refusal (exit 2) before remote mutation;
during `finish` it is a factual rejection.

### `body_evidence_missing` (exit 3)

The provider did not return the complete body required by policy. Restore remote
evidence and retry; SpecGit cannot infer compliant content from the local
scaffold or record.

### `pr_not_found` (rejected)

The bound PR/MR does not exist on the configured forge. If the intended
request already exists for the recorded delivery branch, bind its number with
`specgit pr <number>`. Otherwise create a draft request from that branch,
preserve the required body and every `Closes #n` reference, then bind it.

### `pr_closed_unmerged` (rejected)

The PR/MR was closed without merging, so its delivery record is failed evidence,
not resumable or replaceable history. `specgit issue`, with or without new
titles, exits `1` and preserves the record. Reopen the request, or create/find
an open draft PR/MR from the recorded delivery branch whose body preserves every
`Closes #n`, then run `specgit pr <number>`. Handle a new WHY in a new issue only
after the failed binding has been repaired.

### `pr_draft` (exit 1)

The bound PR/MR is still a draft. Mark it ready, then rerun the verdict:

```bash
gh pr ready <number>
# GitLab
glab mr update <number> --ready
```

A draft with green checks and complete closing references is still rejected.

### `pr_head_mismatch` (rejected)

The PR/MR head is not `context.branch`. Before binding a replacement, close the
obsolete open request or remove its closing references so it no longer claims
the bound issues. Then create or find the request whose head is the recorded
delivery branch and run `specgit pr <number>` from that branch.

### `pr_repo_mismatch` (rejected)

The bound PR/MR reference points at a different repository than `origin`. Bind a request in this repository.

### `issue_out_of_order` (exit 1)

`ordered_issues: true` is enabled and a smaller-numbered issue remains open
before this delivery's smallest bound issue. Deliver or close the earlier issue,
then retry. Turning off ordering is a reviewed policy change, not a shortcut for
one delivery.

## Closing refs

### `closing_refs_incomplete` (rejected)

The PR/MR body lacks a scoped closing reference for one or more bound issues; the failure lists exactly which numbers are missing. Add a closing reference per issue to the request body:

```markdown
Closes #124
```

Keyword variants (`fixes`, `resolves`, tenses) and `owner/repo#N` or full-URL forms all count. Note that `Related to #124` does **not** close anything.

## Checks

### `checks_missing` (rejected)

No check run with the policy's exact name exists at the PR head. Cause is almost always a naming gap between policy and CI. Compare:

```bash
gh api repos/<owner>/<repo>/commits/<pr-head-sha>/check-runs --jq '.check_runs[].name'
# For GitLab, compare policy names with the bound MR head pipeline's job names.
```

against `required_checks`. Fix the policy or the workflow's job `name:` — see the aggregator pattern in [GitHub Actions](actions.md).

One structural cause needs the **policy** repaired: a name from a workflow that
never produces a check on PR heads (push-only, branch-filtered, scheduled, or a
target-only workflow excluded by init's trust boundary). Bare `init --force`
preserves the existing list and therefore cannot repair the name. Replace it
explicitly with repeatable `--required-check <verified-name>`, or make a reviewed
policy edit. GitHub auto-detection accepts explicit `pull_request` workflows and
reports other triggers as `checks_not_pr_visible`; it does not arm
`pull_request_target` jobs automatically. Correcting a policy that was wrong at
birth is required, not a verdict bypass.

### `checks_pending` (exit 1 — transient)

Check runs exist but haven't all completed, or the provider's truth run predates
the delivery's reviewable-transition anchor. This is a **transient, retryable**
non-acceptance, not a defect: the evidence is complete and says "not yet".
Wait for the fresh check generation to finish, then re-run `specgit finish` —
checks and the anchor are re-read from the PR head, so no repair work is needed
unless a check then *fails*.

### `checks_failed` (rejected)

The named check reported a non-success conclusion at the PR head. Open the run's logs, fix the failure (or the flaky test), push, and re-run acceptance — checks are re-read from the new PR head.

## Agent merge guard (tool-level, never a gate)

`specgit init` installs an opencode PreToolUse hook that intercepts
`gh pr merge`, `glab mr merge`, and direct push-to-main tool calls and runs
the verdict before letting them through. The hook is a local agent
convenience on both platforms — it is never an acceptance input, and CI
acceptance runs `specgit finish` itself.

### The guard blocked a merge and reported "no verdict" (budget exhausted)

The guard grants the verdict a time budget: by default
`max(60, 8 × provider timeout in seconds)` (120 s at the 15 s default), using
`SPECGIT_GH_TIMEOUT_MS` for GitHub or `SPECGIT_GLAB_TIMEOUT_MS` for declared
GitLab. Expiry is reported as "no verdict" — the fail-closed
unknown, never a rejection — so nothing is wrong with the delivery; the
evidence simply was not gathered in time. Recovery, in order:

1. Retry once the network settles (the underlying `gh`/`glab` calls were
   probably slow, not broken).
2. Raise the matching provider's per-call budget:
   `SPECGIT_GH_TIMEOUT_MS=60000` or `SPECGIT_GLAB_TIMEOUT_MS=60000`
   (milliseconds) lifts the default guard budget to 480 s too.
3. Or size the guard budget directly: `SPECGIT_GUARD_BUDGET_S` (seconds;
   hook-only — the CLI never reads it). It never applies below the routed
   provider's per-call timeout.

If the guard prints a budget/runner mismatch instead, the computed budget
exceeds the hook runner's own timeout in `.opencode/hooks.json` (checked
with a 10 s margin): raise the runner `timeout` there, or lower
`SPECGIT_GUARD_BUDGET_S` to fit.

## Verdict behaviors

### Exit 130 after Ctrl-C

Interrupting an interactive prompt with Ctrl-C exits `130` after printing
`Interrupted.` to stderr. This is the one documented interruption exception to
the exit-code contract: no JSON envelope is emitted and no verdict was reached.
Upgrade and configuration questions happen before their writes. The optional
remote-protection question happens after the local init transaction, so an
interruption there leaves the complete policy/harness/ignore refresh applied
while remote protection remains unchanged. Inspect `git diff` and
`specgit status`, then re-run the intended command.

### Exit 3 with `unknown` but "everything looks fine"

`unknown` means required evidence could not be gathered. Follow each emitted
`errors[].fix`. `specgit doctor --json` reports every failed prerequisite probe
when the cause is git, repository discovery, origin parsing, the routed forge
CLI, authentication, or policy presence. It does not diagnose the record,
PR/MR, checks, or managed-file drift.

### `local_head_stale` warning

Informational: your checkout is behind or ahead of the PR/MR head. Acceptance still evaluates the request head. Push your commits (if they belong in the delivery) or ignore the warning.

### `record_historical_candidate` warning (`specgit status`, exit 0)

The record names branch `A` as its context but is tracked on the live
branch `B` — the local signature of a delivery whose PR/MR already merged
into this trunk. Nothing is broken; status just refuses to call the state
`bound`. Confirm the merged lineage with `specgit finish` (it reads the
PR/MR and reports `completed`), or start the next delivery —
`specgit issue "<type>: <title>"` atomically replaces the completed
record. If a bound issue remains open, `finish` reports `closure_pending`
instead. Offline status never claims either state outright; that proof belongs
to `finish`.

### Verdict differs from the forge's merge-requirement UI

SpecGit matches `required_checks` byte-for-byte against current head CI/CD facts;
the forge UI may group or label those facts differently. On GitHub, align the
policy and branch protection to the same aggregator name. On GitLab, compare the
policy with the verified MR head pipeline job names and pipeline-success setting.
