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

**Wrong at birth vs weakening.** Never weaken a policy that was right at birth: removing or renaming a check to make a failing verdict pass is forbidden. A policy that was **wrong at birth** — most commonly a check name that can never report on a PR head, such as a push-filtered or scheduled workflow armed by an over-broad detection ([#121](https://github.com/LeXwDeX/SpecGit/issues/121)) — must be corrected: re-run `specgit init --force` to re-detect under the PR-trigger trust boundary (only `pull_request` / `pull_request_target` workflows are candidates; `init` warns `checks_not_pr_visible` when others exist), or edit the list in a reviewed PR. Correcting a false policy is the required repair, not a weakening.

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
| `gitlab.port` | string \| number | Optional. Present only when the instance uses a non-default port; origins then classify against `host:port` exactly (a portless origin on the same host is a different effective port and stays `origin_unresolvable`). Absence means the scheme default (443 https, 22 ssh). |
| `gitlab.insecure_ssl` | boolean | Default `false`. Per-host TLS-skip for the declared host only (self-signed certificates), via glab's host-scoped mechanism when the GitLab adapter lands — never global, never logged. The exact glab flag/config key is not yet pinned from gitlab-org/cli, so the setting stays inert until then (see the [evidence ledger](evidence/gitlab-19.2.md)). |

A declared host changes origin classification: matching origins report `gitlab_unsupported` (dedicated diagnostic) instead of `origin_unresolvable` — including **nested-group** paths (`group/subgroup/project`, any depth ≥ 2). The self-managed support policy is version-qualified: CE/Free `>= 19.2.4 < 19.3.0`, fail-closed outside ([GitLab support roadmap](gitlab-support.md)). Strict schema: unknown keys are rejected.

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
| G8 sequence | issue merge order (when `ordered_issues: true`) | gh | `issue_out_of_order`, `evidence_truncated` |
| G9 pr | PR exists, not closed-unmerged, not a draft, head branch matches context, same repo | gh | `pr_not_found`, `pr_closed_unmerged`, `pr_draft`, `pr_head_mismatch`, `pr_repo_mismatch` |
| G10 closing refs | PR body closes every bound issue | parsed PR body | `closing_refs_incomplete` |
| G11 checks | every required check green at PR head | gh | `checks_missing`, `checks_pending`, `checks_failed` (per check name), `evidence_truncated` |

Draft PRs (G9): a draft is a verdict dimension, not an invisible scaffold state — a draft PR with green checks and complete closing refs still fails with `pr_draft` (factual, exit 1: the evidence is complete and says the PR is a draft; a draft never auto-transitions to mergeable, so exit 0 must not be proclaimed over it). `getPr` collects the `draft` flag; a pull-request payload without it is a transport anomaly and fails closed (`gh_transport`). The accept workflow re-verdicts on the draft→ready transition (its `pull_request` trigger lists `ready_for_review`), so marking the PR ready for review is the repair.

Context matching (G4): the live branch must equal `context.branch`; a detached HEAD fails outright. For `kind: worktree`, the live checkout must additionally be a linked worktree whose label resolves (in `git worktree list`) to `context.branch`.

Merged-delivery lineage (G4): `branch_mismatch` has one exculpation — the bound PR is verified **merged** via `gh`, so running `finish` on the base branch afterwards is completed history, not a mismatch. Historical acceptance then requires lineage proof that local HEAD contains the PR's `merge_commit_sha` (GitHub anchors it on the base branch under every merge method — merge commit, squash, or rebase). Containment proven ⇒ the record is merged history and the context gate passes. Git's decisive *no* (both commits locally known, not an ancestor) ⇒ `merged_delivery_not_contained` (factual, exit 1 — fetch and check out the base branch that received the merge; a rewritten local history cannot prove lineage). No anchor reported, or git cannot answer (e.g. the merge commit is not a local object) ⇒ `merged_lineage_unavailable` (fail-closed, exit 3 — `git fetch` and pull the base branch, then re-run). A provider failure keeps the mismatch; unresolved lineage never turns green.

Non-gate repair diagnostics: `pr_ambiguous` — `specgit pr` (auto-discovery) and `specgit issue` (PR idempotency probe) refuse when several open pull requests share the head branch, listing the candidates with the fix `specgit pr <number>` (exit 3). See the [CLI reference](cli.md) for the full command surface.

Sequence (G8): evaluated only when `policy.ordered_issues` is `true`; otherwise the gate passes vacuously. When on, a delivery whose smallest bound issue has a smaller-numbered **open** issue ahead of it fails with `issue_out_of_order` (exit 1) — deliver or close the earlier issue first. The gate consumes the **complete** open-issue list (#120): the provider pages the issue search to exhaustion, and a truncation signal fails `evidence_truncated` (exit 3) instead of letting an earlier issue hide beyond page 1.

Closing refs (G10) and the draft scaffold: `specgit issue` writes the PR body once, at draft creation — a deterministic scaffold whose `Closes #n` lines for the bound issues come first, followed by advisory Why / What changed / Evidence / Checklist sections. The placeholders are never gates: G10 parses closing references only, so any body that closes every bound issue passes, scaffold or hand-written. No SpecGit command edits an existing PR body (resume and `specgit pr` repair bind or adopt as-is), and the adopting repository's own pull-request templates are never read.

Origin parsing (G5): `github.com` remotes resolve — `https://github.com/owner/repo(.git)`, `git@github.com:owner/repo(.git)`, and `ssh://git@github.com/owner/repo(.git)`, each also with its scheme-default port spelled out (`https://github.com:443/…`, `ssh://git@github.com:22/…`; the URL parser normalizes both to the portless form, leading zeros included) — this three-form GitHub truth table is pinned unchanged (#112). Any other explicit port fails closed to `origin_unresolvable` unless the host is a GitLab declaration that names it: `specgit init --gitlab-host <host>:<port>` (or `gitlab.port` in `spec_git/providers.yaml`) accepts exactly that `host:port` — a portless declaration still rejects non-default ports. A GitLab host **declared** in `spec_git/providers.yaml` (see above) resolves through the GitLab origin grammar (#112): `group[/subgroup…]/project` paths at depth 2–5 — URL-encoded `%2F` separators included — on all three forms (https, ssh URL, scp-like); the resolved ref carries the full group path as its owner plus a `gitlab` platform marker. Platform routing for evaluation keys on that declaration only: the marker is reachable solely through `providers.yaml`, the `*gitlab*` substring heuristic never resolves a ref, so no substring match grants capability (the adversarial corpus pins this). A well-formed path deeper than 5 segments fails closed as `gitlab_unsupported` naming the bound. Because evaluation evidence flows through `gh` only today, the GitLab route itself still fails the origin gate `gitlab_unsupported` (factual, exit 1: the declaration and the grammar are accepted; the glab adapter landed in #114 but provider routing into evaluation is the remaining Phase-2 work) and no `gh` call ever sees a group/subgroup ref; the same guard covers every gh-backed command. Undeclared `gitlab.com`/`*gitlab*` hosts — and nested-group paths on them — keep `gitlab_unsupported` until declared, never folded into `origin_unresolvable`; anything else ⇒ `origin_unresolvable` (fix text is platform-neutral). Owner/repo comparison is case-insensitive.

Checks (G11): evaluated at the **PR head SHA**, never the local HEAD. A re-run does not replace the old run: the Checks API keeps **every run of the same name** on the commit. The **truth run** for a name is the run with the latest `started_at`, ties broken by the higher check-run id — response order is never evidence (one runtime experiment, 2026-08-20: `gh api .../check-runs` on re-run commits of this repository returns same-name runs in descending-id order with identical names, no re-run suffix; semantics must not depend on that undocumented order). The same truth-run rule decides the generated harness wait step. Per name: no check run with that name ⇒ `checks_missing`; the truth run is not completed ⇒ `checks_pending`; the truth run is completed with a conclusion other than success ⇒ `checks_failed`. All failing names are enumerated in one verdict. `checks_pending` is classified `factual` (exit 1): the evidence is complete and says "not yet" — it is a **transient, retryable** non-acceptance, not a defect. Wait for CI to finish and re-run `specgit finish`.

Additional evidence rules:

- Local HEAD ≠ PR head SHA ⇒ informational `local_head_stale` warning only. Acceptance is about the PR.
- A dirty working tree is reported in evidence; it is never a gate.
- Any evidence failure or unknown ⇒ verdict `unknown`, exit 3 — unless all evidence was gathered and ≥1 gate failed ⇒ `rejected`, exit 1.
- Evidence completeness (#120, I3b): list-shaped evidence inputs are exhausted or the verdict is `unknown`. The open-issue search and check-run pagination run to exhaustion; a truncation signal — GitHub `incomplete_results: true`, or a pagination cap reached on a full page (GitHub search never returns more than 1000 results) — fails `evidence_truncated` (exit 3). A silently partial list is never consumed by a verdict or by issue adoption. (`specgit pr` discovery uses a bounded probe whose zero/one/several refusal semantics are fail-safe under truncation: ≥2 matches always refuse with the candidate list.)

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
- HTTP 404 ⇒ `issue_not_found` / `pr_not_found`; other transport failures and timeouts ⇒ `gh_transport`. Truncation of a list-shaped response (`incomplete_results: true`, a pagination cap hit on a full page) ⇒ `evidence_truncated`. Every failure is evidence; none of them pass acceptance, and there is no silent fallback.
- The seam is injectable: tests run against a mock provider (and `SPECGIT_GH` can point at a scripted `gh`), so acceptance logic is verifiable offline.
- How the port itself evolves — required-versus-optional member rules, the deprecation path, and the tracking obligations for alternate providers and test doubles — is the committed [port-compatibility policy](providers.md).

### The glab mirror (#114)

The same port has a second adapter: `GlabProvider` (`src/providers/gitlab/glab-cli.ts`) flows GitLab evidence through the authenticated `glab` CLI under the same discipline — per-host auth (`glab auth status --hostname <host>`), every api call host-scoped, `SPECGIT_GLAB` / `SPECGIT_GLAB_TIMEOUT_MS` mirroring the gh pair (timeout ⇒ `glab_transport`), read endpoints plus exactly the four documented write endpoints, tokens never read or logged, list pagination to exhaustion with the `evidence_truncated` guard. A declared self-managed host is version-gated to `>= 19.2.4 < 19.3.0` via `glab api /metadata` (`gitlab_version_unsupported` outside); GitLab.com is judged by capability probing, never version pinning. Evaluation does not route through it yet — the `gitlab_unsupported` origin guard holds until the Phase-2 routing slices ([gitlab-support.md](gitlab-support.md)).

## State and assets

Everything SpecGit writes falls into exactly three tiers:

| Tier | Contents | Owner |
| --- | --- | --- |
| **Authoritative committed files** | `spec_git/policy.yaml` (required-checks policy), `.specgit.yaml` (the delivery record), `spec_git/providers.yaml` (optional platform declaration) | You. Hand-editable, reviewed in PRs like code; the CLI validates but never invents content. |
| **Derived committed harness** | `.github/workflows/specgit-accept.yml`, the managed `<!-- specgit:block:start/end -->` region in `AGENTS.md` (and `CLAUDE.md` when present) | Generated by `specgit init`. Safe to regenerate; re-running `init --force` repairs drift. Content outside the managed markers is yours. |
| **Local integration assets** | `.opencode/hooks.json` guard entry + `.opencode/hooks/specgit-merge-guard.sh`, the managed region of `.git/hooks/pre-push`, agent entry points installed by `specgit setup` (`.opencode/command/`, portable skills) | Machine-local wiring. Merged non-destructively (existing user hooks and entries are preserved); commit them only if your team wants shared wiring. |

Verdicts are never part of state: they are computed per invocation from git and GitHub and never persisted.

## Exit codes and JSON

Stable contract: `0` success/accepted · `1` rejected with complete evidence · `2` usage error · `3` fail-closed unknown · `130` the Ctrl-C interruption exception (stderr `Interrupted.`, no envelope — see the [CLI reference](cli.md)). `--json` output is a single JSON envelope on stdout — shape documented in the [CLI reference](cli.md). Telemetry does not exist; the only environment inputs are `SPECGIT_GH`, `SPECGIT_GH_TIMEOUT_MS`, `SPECGIT_GLAB`, `SPECGIT_GLAB_TIMEOUT_MS`, and standard `NO_COLOR`/`CI` detection.
