# Reference

Exact schemas, gates, codes, and behavioral rules. Everything here is normative. Templates for both files live in [`schemas/specgit/templates/`](../schemas/specgit/templates), and the schema-facing description of the record and policy lives in [`schemas/specgit/schema.yaml`](../schemas/specgit/schema.yaml).

## `.specgit.yaml` — delivery binding record

Located at the repository root, committed on the delivery branch.

```yaml
version: 1
delivery: add-login-flow          # required, kebab-case id
context:                          # required, discriminated by `kind`
  kind: branch
  branch: feat/123-login
# — or —
context:
  kind: worktree
  label: 123-login                # portable label; local paths rejected
  branch: feat/123-login
issues: [123, 124]                # GitHub issue numbers; may be empty in a draft
pr: 42                            # number or URL verbatim; at most one
```

Field rules:

| Field | Type | Rule |
| --- | --- | --- |
| `version` | `1` | Only `1` is accepted. |
| `delivery` | string | kebab-case: lowercase alphanumerics, single `-` separators, no leading/trailing `-`. Set on first bind only. |
| `context.kind` | `branch` \| `worktree` | Required discriminant. Unknown kinds are invalid. |
| `context.branch` | string | Non-empty. Must equal the live branch at evaluation. |
| `context.label` | string | Worktree only. Non-empty, and **no local paths** (no leading `/`, `\`, or `X:/`) — labels must be portable across machines. |
| `issues` | number[] | Positive GitHub issue numbers. Record cardinality 0..N; acceptance requires ≥1. |
| `pr` | number \| string | Positive integer or non-empty URL string. Record cardinality 0..1; acceptance requires exactly 1. |

Unknown keys are parsed-but-ignored and **preserved on rewrite** — other tools may keep data in the same file.

## `spec_git/policy.yaml` — project policy

Located under `spec_git/` at the repository root; the directory is the project marker.

```yaml
version: 1
required_checks:
  - "All checks passed"
ordered_issues: true
```

| Field | Type | Rule |
| --- | --- | --- |
| `version` | `1` | Only `1` is accepted. |
| `required_checks` | string[] | List of non-empty check names, matched exactly. May be empty — the **no-CI policy** (`init`'s fallback when the repository has no CI files): the generated acceptance job itself, enforced through branch protection, is then the gate. |
| `ordered_issues` | boolean | Optional, default `false`. When `true`, deliveries must merge in ascending issue order: `specgit finish` rejects (`issue_out_of_order`, exit 1) if any open issue has a number smaller than the smallest bound issue of this delivery. Close or deliver the earlier issue first. |

The policy is strict: unknown keys make it invalid. Required checks are **declared locally** and matched against check runs reported to the PR head commit — they are not read from GitHub rulesets.

## `spec_git/providers.yaml` — platform declarations

Optional; created by `specgit init --gitlab-host <hostname>` (or the interactive platform question). Committed to the repository so the team shares one declaration.

```yaml
gitlab:
  host: git.ycgame.com
  insecure_ssl: false
```

| Field | Type | Rule |
| --- | --- | --- |
| `gitlab.host` | string | Bare hostname (no scheme/path); must match the origin host when declared from `init`. |
| `gitlab.insecure_ssl` | boolean | Default `false`. Reserved for the glab roadmap (self-signed certificates). |

A declared host changes origin classification: matching origins report `gitlab_unsupported` (dedicated diagnostic) instead of `origin_unresolvable`. Strict schema: unknown keys are rejected.

## Root discovery

SpecGit runs only inside a git repository. Root = `git rev-parse --show-toplevel`; record and policy live at that root. No ancestor walking, no global stores. Outside a repository: `not_a_git_repo`, exit 3. Linked-worktree checkouts are first-class (a `.git` file, not directory, is fine).

## Gates

Evaluation runs **eleven gates** in order. Gates short-circuit **across** gates (a failed gate stops later ones) and collect all failures **within** a gate.

| Gate | Concern | Source | Failure codes |
| --- | --- | --- | --- |
| G1 record | record exists and parses | local | `record_missing`, `record_invalid` |
| G2 policy | policy exists and parses | local | `policy_missing`, `policy_invalid` |
| G3 completeness | ≥1 issue, exactly 1 PR | local | `issues_empty`, `pr_missing` |
| G4 context | record context matches live git | local git | `not_a_git_repo`, `git_unavailable`, `no_commits`, `detached_head`, `branch_mismatch`, `merged_delivery_not_contained`, `merged_lineage_unavailable`, `worktree_mismatch` |
| G5 origin | `origin` resolves to `owner/repo` | local git | `no_origin`, `origin_unresolvable`, `gitlab_unsupported` |
| G6 provider | `gh` present and authenticated | gh preflight | `gh_missing`, `gh_unauthenticated`, `gh_transport` |
| G7 issues | every bound issue exists and is an issue | gh | `issue_not_found`, `issue_is_pull_request` |
| G8 sequence | issue merge order (when `ordered_issues: true`) | gh | `issue_out_of_order` |
| G9 pr | PR exists, not closed-unmerged, head branch matches context, same repo | gh | `pr_not_found`, `pr_closed_unmerged`, `pr_head_mismatch`, `pr_repo_mismatch` |
| G10 closing refs | PR body closes every bound issue | parsed PR body | `closing_refs_incomplete` |
| G11 checks | every required check green at PR head | gh | `checks_missing`, `checks_pending`, `checks_failed` (per check name) |

Context matching (G4): the live branch must equal `context.branch`; a detached HEAD fails outright. For `kind: worktree`, the live checkout must additionally be a linked worktree whose label resolves (in `git worktree list`) to `context.branch`.

Merged-delivery lineage (G4): `branch_mismatch` has one exculpation — the bound PR is verified **merged** via `gh`, so running `finish` on the base branch afterwards is completed history, not a mismatch. Historical acceptance then requires lineage proof that local HEAD contains the PR's `merge_commit_sha` (GitHub anchors it on the base branch under every merge method — merge commit, squash, or rebase). Containment proven ⇒ the record is merged history and the context gate passes. Git's decisive *no* (both commits locally known, not an ancestor) ⇒ `merged_delivery_not_contained` (factual, exit 1 — fetch and check out the base branch that received the merge; a rewritten local history cannot prove lineage). No anchor reported, or git cannot answer (e.g. the merge commit is not a local object) ⇒ `merged_lineage_unavailable` (fail-closed, exit 3 — `git fetch` and pull the base branch, then re-run). A provider failure keeps the mismatch; unresolved lineage never turns green.

Non-gate repair diagnostics: `pr_ambiguous` — `specgit pr` (auto-discovery) and `specgit issue` (PR idempotency probe) refuse when several open pull requests share the head branch, listing the candidates with the fix `specgit pr <number>` (exit 3). See the [CLI reference](cli.md) for the full command surface.

Sequence (G8): evaluated only when `policy.ordered_issues` is `true`; otherwise the gate passes vacuously. When on, a delivery whose smallest bound issue has a smaller-numbered **open** issue ahead of it fails with `issue_out_of_order` (exit 1) — deliver or close the earlier issue first.

Closing refs (G10) and the draft scaffold: `specgit issue` writes the PR body once, at draft creation — a deterministic scaffold whose `Closes #n` lines for the bound issues come first, followed by advisory Why / What changed / Evidence / Checklist sections. The placeholders are never gates: G10 parses closing references only, so any body that closes every bound issue passes, scaffold or hand-written. No SpecGit command edits an existing PR body (resume and `specgit pr` repair bind or adopt as-is), and the adopting repository's own pull-request templates are never read.

Origin parsing (G5): only `github.com` remotes resolve — `https://github.com/owner/repo(.git)`, `git@github.com:owner/repo(.git)`, and `ssh://git@github.com/owner/repo(.git)`. A GitLab host declared in `spec_git/providers.yaml` (see above) reports `gitlab_unsupported`; anything else ⇒ `origin_unresolvable`. Owner/repo comparison is case-insensitive.

Checks (G11): evaluated at the **PR head SHA**, never the local HEAD. Per name: no check run with that name ⇒ `checks_missing`; runs exist but not all completed ⇒ `checks_pending`; any completed run conclusion is not success ⇒ `checks_failed`. All failing names are enumerated in one verdict. `checks_pending` is classified `factual` (exit 1): the evidence is complete and says "not yet" — it is a **transient, retryable** non-acceptance, not a defect. Wait for CI to finish and re-run `specgit finish`.

Additional evidence rules:

- Local HEAD ≠ PR head SHA ⇒ informational `local_head_stale` warning only. Acceptance is about the PR.
- A dirty working tree is reported in evidence; it is never a gate.
- Any evidence failure or unknown ⇒ verdict `unknown`, exit 3 — unless all evidence was gathered and ≥1 gate failed ⇒ `rejected`, exit 1.

## Closing references (G10)

The PR body must close every bound issue. Recognized grammar: a closing keyword followed by a reference —

- Keywords (case-insensitive): `close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`, `resolved`
- Reference forms: `#123`, `owner/repo#123`, or the full issue URL (`https://github.com/owner/repo/issues/123`)

Examples that count: `Closes #123`, `fixed owner/repo#123`, `Resolved: https://github.com/owner/repo/issues/123`.

Not closing refs: `Related to #5`, a bare `#5`, plain SHA mentions. References are deduplicated; numbers not covered by any closing ref produce `closing_refs_incomplete` listing exactly which issues are missing.

## Delivery states

States are **derived per invocation, never persisted**:

| State | Meaning |
| --- | --- |
| `unbound` | No record at the root. |
| `draft` | Record exists but is incomplete (no issues, or no PR). |
| `bound` | Record complete (≥1 issue, PR set) — acceptance not yet evaluated or not passing. |
| `accepted` | This invocation: all gates passed. |
| `rejected` | This invocation: evidence complete, ≥1 gate failed. |
| `unknown` | This invocation: evidence could not be fully gathered. |

## GitHub provider seam

All remote evidence flows through the `gh` CLI — no other endpoint selection exists.

- `gh` not found ⇒ `gh_missing`; `gh auth status` failing ⇒ `gh_unauthenticated` (remediation text is shown; tokens are never read or printed).
- The `gh` executable is resolved per invocation: an explicit internal override, then `SPECGIT_GH`, then `gh` on `PATH`. Each call gets a hard timeout — `SPECGIT_GH_TIMEOUT_MS` when set, `15000` ms by default — plus response-size caps, array-form arguments, and JSON-only handling. Strings returned by the API are sanitized (control characters stripped, values truncated) before any terminal rendering.
- HTTP 404 ⇒ `issue_not_found` / `pr_not_found`; other transport failures and timeouts ⇒ `gh_transport`. Every failure is evidence; none of them pass acceptance, and there is no silent fallback.
- The seam is injectable: tests run against a mock provider (and `SPECGIT_GH` can point at a scripted `gh`), so acceptance logic is verifiable offline.

## State and assets

Everything SpecGit writes falls into exactly three tiers:

| Tier | Contents | Owner |
| --- | --- | --- |
| **Authoritative committed files** | `spec_git/policy.yaml` (required-checks policy), `.specgit.yaml` (the delivery record), `spec_git/providers.yaml` (optional platform declaration) | You. Hand-editable, reviewed in PRs like code; the CLI validates but never invents content. |
| **Derived committed harness** | `.github/workflows/specgit-accept.yml`, the managed `<!-- specgit:block:start/end -->` region in `AGENTS.md` (and `CLAUDE.md` when present) | Generated by `specgit init`. Safe to regenerate; re-running `init --force` repairs drift. Content outside the managed markers is yours. |
| **Local integration assets** | `.opencode/hooks.json` guard entry + `.opencode/hooks/specgit-merge-guard.sh`, the managed region of `.git/hooks/pre-push`, agent entry points installed by `specgit setup` (`.opencode/command/`, portable skills) | Machine-local wiring. Merged non-destructively (existing user hooks and entries are preserved); commit them only if your team wants shared wiring. |

Verdicts are never part of state: they are computed per invocation from git and GitHub and never persisted.

## Exit codes and JSON

Stable contract: `0` success/accepted · `1` rejected with complete evidence · `2` usage error · `3` fail-closed unknown · `130` the Ctrl-C interruption exception (stderr `Interrupted.`, no envelope — see the [CLI reference](cli.md)). `--json` output is a single JSON envelope on stdout — shape documented in the [CLI reference](cli.md). Telemetry does not exist; the only environment inputs are `SPECGIT_GH`, `SPECGIT_GH_TIMEOUT_MS`, and standard `NO_COLOR`/`CI` detection.
