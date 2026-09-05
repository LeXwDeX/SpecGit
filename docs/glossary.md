# Glossary

Every SpecGit term in one place. Terms are grouped by topic, then alphabetized.

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

## The model

**Delivery** — One unit of work, identified by a kebab-case id (`add-login-flow`). A delivery is the aggregate of its execution context, issues, PR, and required checks.

**Delivery binding aggregate** — The whole thing SpecGit verifies: execution context + `issues[]` + one PR + required checks. The word "binding" emphasizes that these parts are tied together, not merely listed.

**Derived state** — A delivery or local-observation state computed on each invocation: `unbound`, `draft`, `bound`, `accepted`, `closure_pending`, `completed`, `rejected`, or `unknown`, plus status-only `historical-candidate`. Never stored, so it cannot drift from live evidence.

**Fail-closed** — The rule that missing evidence yields `unknown`, never `accepted`. Any evidence that cannot be gathered blocks acceptance.

**Record** — The `.specgit.yaml` file at the repository root declaring this delivery's binding: delivery id, context, issues, PR. Committed on the delivery branch.

**Policy** — `spec_git/policy.yaml`: the project's strict shared contract. It contains `required_checks` and may select issue ordering, generated-text language, tag vocabulary, issue/PR templates, title/label/body validation, and merge/closure/repair-label automation.

## Execution context

**Execution context** — Where the delivery happens, resolved from live git: `kind: branch` or `kind: worktree`. Never supplied as a CLI flag.

**Worktree label** — The portable identifier of a linked worktree (its checkout basename). Labels must not be local paths; they let a worktree context match across machines.

**Work-copy equivalence** — For `kind: branch`, any checkout on the branch satisfies the context — main clone, linked worktree, or another work copy alike.

**Detached HEAD** — A git state with no current branch. Always fails the context gate (`detached_head`); check out the branch.

## Evidence

**Evidence** — A verified fact or an explicit failure. SpecGit plumbing carries evidence as ok/failure values; there is no silent default.

**Gate** — One of eleven ordered verification stages (record, policy, completeness, context, origin, provider, issues, sequence, PR, closing refs, checks). Gates short-circuit across stages and collect every failure within one.

**Code** — The stable identifier of a failure (`closing_refs_incomplete`, `checks_failed`, …). Codes are machine-friendly and never change meaning.

**Verdict** — The outcome of `specgit finish` (alias `accept`): `accepted` (exit 0), `rejected` (exit 1, complete evidence), or `unknown` (exit 3, fail-closed). A merged delivery can instead surface the lifecycle result `closure_pending` or `completed`.

**Accepted** — Every applicable evidence gate passed for the current request head. A live accepted delivery may be merged under existing authorization; acceptance alone does not prove completion.

**Closure pending** — The PR/MR is confirmed merged, but at least one bound issue is still open. Resume configured closure with `specgit pr --merge`, or repair the tracker state.

**Completed** — Merged lineage is proven and every bound issue is confirmed closed.

**Repair issue** — A separate issue for an independently actionable terminal PR/MR or CI failure. Repeated occurrences of the same unresolved cause reuse the open repair issue; original business issues remain bound until completion.

**Closing reference** — A PR/MR-body phrase that closes an issue: a closing keyword (`closes`, `fixes`, `resolves`, plus tense variants) followed by `#N`, `owner/repo#N`, or a full issue URL. Every bound issue needs one.

**Check name** — The exact string in `required_checks`, matched against CI/CD facts reported to the PR/MR head commit. Byte-for-byte matching; see the GitHub aggregator pattern in [GitHub Actions](actions.md).

**PR/MR head** — The commit at the tip of the request branch. Checks are evaluated here, because this is what merges.

**`local_head_stale`** — Informational warning when your local HEAD differs from the PR/MR head. Never blocks acceptance.

## Tooling

**Provider seam** — The injectable boundary through which SpecGit talks to the forge: GitHub through `gh`, a declared GitLab host through `glab`. Tests use a mock.

**`gh`** — GitHub's official CLI. SpecGit requires it for GitHub acceptance: preflight, then `gh api` for issues, the PR, and check runs. Auth comes from your existing `gh auth login`; GitLab deliveries use `glab` the same way (per-host auth).

**`--json`** — Global flag: stdout becomes exactly one JSON document (the envelope), human text goes to stderr.

**Exit-code contract** — `0` accepted/success · `1` rejected with complete evidence · `2` usage error · `3` fail-closed unknown · `130` the Ctrl-C interruption exception (stderr `Interrupted.`, no envelope). Stable across versions.

**Envelope** — The single JSON document every non-interrupted `--json` command emits. All envelopes carry tool/command/status/exit metadata and diagnostics; commands add their own sections, such as `verdict`, `record`, `assets`, `automation`, `urls`, or `nextActions`. A Ctrl-C exit 130 is the sole no-envelope exception.

**`spec_git/`** — The project data root: the folder holding the policy. Its presence marks a SpecGit project.

**`.specgit.yaml`** — The record file. See **Record**.
