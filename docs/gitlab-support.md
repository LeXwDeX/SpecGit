# GitLab (glab) Support Roadmap

**v1 scope: GitHub.com plus GitLab CE/Free self-managed per the version policy below; GitLab capability lands incrementally per the Phase-2 roadmap.** SpecGit derives acceptance from GitHub evidence in v1: issues, pull requests, and check runs flow exclusively through the authenticated `gh` CLI ([the provider seam](../src/github/port.ts)). This document is the version-qualified plan for extending the same evidence model to GitLab through the `glab` CLI. Every behavioral claim below is pinned in the committed [GitLab 19.2 evidence ledger](evidence/gitlab-19.2.md) — claims without a ledger anchor are rejected on review (#94, #100).

## Current behavior (deliberate)

A GitLab origin is **recognized, not silently misread**:

- The platform is declared, not guessed: `specgit init --gitlab-host <hostname>` (or `<hostname>:<port>` when the instance uses a non-default port, #78; or the interactive platform question) persists the declaration in `spec_git/providers.yaml`, committed so the team shares it. A `github.com` origin defaults to GitHub with no declaration needed.
- `parseRepoRef` honors the declared endpoint: since #112 a matching origin **resolves through the GitLab origin grammar** — `group[/subgroup…]/project` paths at depth 2–5, URL-encoded `%2F` separators included, on all three accepted forms — with the full group path as the ref's owner and a `gitlab` platform marker (a deeper well-formed path fails closed as `gitlab_unsupported` naming the bound). Because evaluation evidence still flows through `gh` only, the GitLab route fails the origin gate `gitlab_unsupported` (factual, exit 1 — the declaration and the grammar are accepted, the glab provider is the missing piece); the same guard covers every gh-backed command, so no `gh` call ever sees a group/subgroup ref. A `gitlab.com`/`*gitlab*` host without a declaration keeps `gitlab_unsupported` at every depth — the substring heuristic never resolves a ref. Explicit ports follow the #78 rule: a scheme-default port (`:443` https, `:22` ssh) classifies like the portless form; a non-default port classifies only when the declaration names it (`host:port`, persisted as `gitlab.port`). Undeclared non-github origins stay `origin_unresolvable` with a `platform_undecided` warning.
- `specgit doctor` surfaces `gitlab_unsupported` on the `origin` probe while still probing `gh`, so the report shows both facts.
- `specgit init` already classifies the platform from the origin URL (`github | gitlab | unknown`, no network), reads `.gitlab-ci.yml` job keys when no GitHub workflows exist, and reports `glab` presence on PATH (reported only). Policy generation therefore already works for GitLab CI.

## Supported-version policy (self-managed)

- **Self-managed GitLab is supported at exactly `>= 19.2.4 < 19.3.0`, CE/Free tier** (#98). The known-good anchor is the `v19.2.4-ee` release tag (tagged 2026-08-14, commit `85f4a2d9`). Any version outside the range fails closed: planned diagnostic `gitlab_version_unsupported`, exit 3, fix text pointing here and to upgrading within 19.2.x. Versions `>= 19.3.0` also fail closed until a rebaseline delivery widens the range — the range moves only through explicit rebaseline deliveries, never silent drift.
- **The `-ee`/`-ce` suffix is a release-channel marker, not semver pre-release semantics**: naive semver ordering ranks `19.2.4-ee < 19.2.4`, which is wrong. Version comparison strips the suffix first, then compares the `x.y.z` triple (ledger rule 4).
- **Version discovery uses the authenticated metadata endpoint** (`glab api /metadata`): no unauthenticated version channel is documented at the pinned tag (ledger row 3). `metadata.enterprise` is informational only — never a gate input.
- **GitLab.com (SaaS) is in scope and is judged by capability probing, never version pinning** (#93): the instance auto-upgrades, so a pinned self-managed range cannot apply. The evidence path probes every API surface the delivery depends on with read-only calls; any probe failure ⇒ verdict `unknown` (planned `gitlab_capability_missing`, exit 3). Missing evidence is UNKNOWN = a blocked path, never an inferred capability.
- **glab floor: 1.113.0**, pinned from gitlab-org/cli tag `v1.113.0` (commit `d6288130`). The floor rises to 1.114.0 only if implementation depends on same-host SSH capability, with a cited gitlab-org/cli reference — decided before the first implementation slice. glab authenticates per host (`glab auth status --hostname <host>`; remediation `glab auth login --hostname <host>`; ledger row 8).
- **Planned environment contract** (mirroring `SPECGIT_GH`/`SPECGIT_GH_TIMEOUT_MS`; recorded now, implemented with the adapter): `SPECGIT_GLAB` (glab executable path, default PATH) and `SPECGIT_GLAB_TIMEOUT_MS` (default 15000; timeout ⇒ `glab_transport`, exit 3).
- **`gitlab.insecure_ssl` is per-host**: `true` in `spec_git/providers.yaml` skips TLS verification for that declared host only — never global, never logged; `false`/absent = full verification. The exact glab host-scoped mechanism is not yet pinned from gitlab-org/cli, so enabling it stays a blocked path until pinned (ledger, open unknowns).

## Design principles

1. **Mirror the seam, do not fork the gates.** Acceptance evaluation (record → policy → completeness → context → origin → provider → issues → pr → closing → checks) is platform-agnostic. Only evidence *collection* is platform-specific.
2. **One CLI per platform, authenticated, no tokens in state or logs.** GitHub evidence flows through `gh`; GitLab evidence will flow through `glab`. No direct REST clients.
3. **Fail-closed carries over.** Missing glab, unauthenticated glab, an out-of-range server version, or an unreachable GitLab yields `unknown`, never `accepted`. That includes the evidence-completeness rule (#120): every `rel="next"` continuation must run to exhaustion, and a full page without a usable `rel="next"` link — or a continuation that errors mid-list — fails closed (`evidence_truncated`, exit 3) exactly like `gh` today; a silently partial list is never consumed. The `getOpenIssueNumbers` and `getCheckRuns` cells in the method map below are planned under this rule from day one.
4. **Free-tier primitives only, honestly reported.** Ultimate-only status checks (`only_allow_merge_if_all_status_checks_passed`) are excluded forever (ledger row 22); `requiredChecks` reports the verified pipeline-gate intersection instead of fabricating GitHub semantics (ledger rows 7/20).

## Phases

### Phase 1 — recognition and diagnostics (shipped)

- Dedicated `gitlab_unsupported` diagnostic for GitLab origins, including nested-group paths (#95).
- `doctor` reports it; `init` reports platform + glab presence.

### Phase 2 — GlabProvider method map

Interface decision recorded (option B — neutral provider port with internal per-platform adapters), **not implemented**; `GitHubProvider` keeps its current shape and #80 compatibility (the [port-compatibility policy](providers.md)) until that slice lands. The per-platform adapter home exists since #113: the GitHub adapter lives at `src/providers/github/` (legacy `src/github/gh-cli.ts` / `protection-merge.ts` paths are stable aliases), so a future `GlabProvider` lands beside it as `src/providers/gitlab/`. The full 12-method map, anchored cell by cell in the ledger (row 24):

| GitHubProvider method | GitLab equivalent (19.2, Free tier) |
| --- | --- |
| `preflight` | `glab auth status --hostname <host>` (per-host auth, ledger row 8) |
| `getIssue` | `glab api projects/:id/issues/:iid` |
| `getOpenIssueNumbers` | `glab api projects/:id/issues?state=opened` with `per_page=100` + `rel="next"` continuation (ledger rows 15/24) |
| `getPr` | `glab api projects/:id/merge_requests/:iid` (state machine row 19) |
| `getCheckRuns` | pipelines by `sha` → per-pipeline jobs, `rel="next"` continuation (rows 15/16) |
| `createIssue` | `glab api projects/:id/issues -f …` |
| `createDraftPr` | `glab api projects/:id/merge_requests` with `Draft: <title>` (rows 6/18 — `glab mr create` has no structured-output flag) |
| `listOpenPrsByHead` | MR list filtered by source branch (`source_branch` list parameter, pinned FU-4 — ledger row 24) |
| `getBranchProtection` | `GET projects/:id/protected_branches/:name` (Free basic fields, row 20) |
| `enableBranchProtection` | protect default branch (integer access levels) + set `only_allow_merge_if_pipeline_succeeds` (rows 7/20) |
| `getRepoAutomerge` | read `only_allow_merge_if_pipeline_succeeds` from project JSON (row 7) |
| `enableRepoAutomerge` | repo gate (row 7) + per-MR `auto_merge` on merge (row 21) |

Check-run mapping: a GitLab pipeline job maps to a check whose name is the job name; `policy.required_checks` continues to hold exact names discovered from `.gitlab-ci.yml`, so `spec_git/policy.yaml` stays the single contract. A failed `allow_failure` job reports `conclusion: 'failure'` with `allowFailure: true` and the gate passes per pipeline semantics (row 17); retried jobs are omitted by default, so latest-attempt semantics are native (row 16).

**Selection rule (#100, seam implemented in #112):** only a `providers.yaml` declaration grants the GitLab path. `parseRepoRef` marks a ref `platform: gitlab` solely when the origin matched the declaration (host and port), and evaluation plus every gh-backed command route on that marker — the routed GitLab path fails closed `gitlab_unsupported` until the glab adapter lands. `classifyPlatform(originUrl)` — the `github | gitlab | unknown` heuristic — is used **only** for diagnostics and interactive questions; it never resolves a ref and never grants provider capability, and `unknown` platforms stay on the GitHub path and fail closed at the origin gate exactly as today.

Project identity is addressed by full path URL-encoded (`/`→`%2F`) as `:id` (row 4) and verified by numeric project id plus path comparison, because renamed projects redirect transparently (row 5).

### Phase 3 — parity and harness

- The acceptance workflow template gains a GitLab CI variant running `specgit finish` as a pipeline job. CI-job-token evidence gathering is blocked on the live cell (ledger row 10b) — the documented degradation path is a project access token.
- `specgit issue` bootstrap works against GitLab: draft MRs are created with the `Draft:` prefix (row 18), and MR bodies use the **common subset** closing references (`Closes #<iid>`, `Fixes #<iid>`) — valid on both platforms. Parsing is provider-parameterized: GitLab's default closing pattern (pinned at 19.2, ledger rows 12–14) accepts a superset — the `implement*` family, gerunds, an optional colon or `issue(s)` word between keyword and reference, comma/`and` multi-reference continuations, `group[/subgroup]/project#iid` full-path references, and `/-/issues/<iid>` URLs — and is subject to the pinned cautions (default-branch trigger, per-project auto-close setting, first-push disable, admin-replaceable pattern).
- The generated `AGENTS.md` managed block gains the GitLab-flavored surface when the adapter lands; the ten-command/two-state-file documentation sync is tracked in #91 and merged there — not duplicated here.

## Non-goals

- No cross-platform deliveries (one delivery, one platform, one PR/MR).
- No token storage: `glab` owns credentials, same as `gh` today.
- No support for versions outside `>= 19.2.4 < 19.3.0` (self-managed) without a rebaseline delivery; no Ultimate-tier primitives, ever.
