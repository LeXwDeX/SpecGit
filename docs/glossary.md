# Glossary

Every SpecGit term in one place. Terms are grouped by topic, then alphabetized.

## The model

**Delivery** — One unit of work, identified by a kebab-case id (`add-login-flow`). A delivery is the aggregate of its execution context, issues, PR, and required checks.

**Delivery binding aggregate** — The whole thing SpecGit verifies: execution context + `issues[]` + one PR + required checks. The word "binding" emphasizes that these parts are tied together, not merely listed.

**Derived state** — A delivery state (`unbound`, `draft`, `bound`, `accepted`, `rejected`, `unknown`) computed from live facts on each invocation. Never stored, so it can never drift.

**Fail-closed** — The rule that missing evidence yields `unknown`, never `accepted`. Any evidence that cannot be gathered blocks acceptance.

**Record** — The `.specgit.yaml` file at the repository root declaring this delivery's binding: delivery id, context, issues, PR. Committed on the delivery branch.

**Policy** — `spec_git/policy.yaml`: the project's `required_checks` list, shared by every delivery and enforced byte-for-byte.

## Execution context

**Execution context** — Where the delivery happens, resolved from live git: `kind: branch` or `kind: worktree`. Never supplied as a CLI flag.

**Worktree label** — The portable identifier of a linked worktree (its checkout basename). Labels must not be local paths; they let a worktree context match across machines.

**Work-copy equivalence** — For `kind: branch`, any checkout on the branch satisfies the context — main clone, linked worktree, or another work copy alike.

**Detached HEAD** — A git state with no current branch. Always fails the context gate (`detached_head`); check out the branch.

## Evidence

**Evidence** — A verified fact or an explicit failure. SpecGit plumbing carries evidence as ok/failure values; there is no silent default.

**Gate** — One of ten ordered verification stages (record, policy, completeness, context, origin, provider, issues, PR, closing refs, checks). Gates short-circuit across stages and collect every failure within one.

**Code** — The stable identifier of a failure (`closing_refs_incomplete`, `checks_failed`, …). Codes are machine-friendly and never change meaning.

**Verdict** — The outcome of `specgit finish` (alias `accept`): `accepted` (exit 0), `rejected` (exit 1, complete evidence), or `unknown` (exit 3, fail-closed).

**Closing reference** — A PR-body phrase that closes an issue: a closing keyword (`closes`, `fixes`, `resolves`, plus tense variants) followed by `#N`, `owner/repo#N`, or a full issue URL. Every bound issue needs one.

**Check name** — The exact string in `required_checks`, matched against check runs reported to the PR head commit. Byte-for-byte matching; see the aggregator pattern in [GitHub Actions](actions.md).

**PR head** — The commit at the tip of the pull request branch. Checks are evaluated here, because this is what merges.

**`local_head_stale`** — Informational warning when your local HEAD differs from the PR head. Never blocks acceptance.

## Tooling

**Provider seam** — The injectable boundary through which SpecGit talks to the forge: GitHub through `gh`, a declared GitLab host through `glab`. Tests use a mock.

**`gh`** — GitHub's official CLI. SpecGit requires it for GitHub acceptance: preflight, then `gh api` for issues, the PR, and check runs. Auth comes from your existing `gh auth login`; GitLab deliveries use `glab` the same way (per-host auth).

**`--json`** — Global flag: stdout becomes exactly one JSON document (the envelope), human text goes to stderr.

**Exit-code contract** — `0` accepted/success · `1` rejected with complete evidence · `2` usage error · `3` fail-closed unknown. Stable across versions.

**Envelope** — The JSON document every `--json` command emits: tool metadata, derived state, verdict with gates and evidence, and errors with fixes.

**`spec_git/`** — The project data root: the folder holding the policy. Its presence marks a SpecGit project.

**`.specgit.yaml`** — The record file. See **Record**.
