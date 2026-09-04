# GitLab (glab) Support

**v1 scope: GitHub.com plus self-managed GitLab CE/Free per the version policy below — both shipped.** Evidence flows exclusively through authenticated CLIs ([the provider seam](../src/github/port.ts)): `gh` on GitHub origins; since the glab adapter (#114) and per-platform routing (#117), a **declared** GitLab origin's issues, merge requests, and pipeline jobs flow through the authenticated `glab` CLI and every gate evaluates there. This document is the version-qualified contract for the GitLab side of that seam. Every behavioral claim below is pinned in the committed [GitLab 19.2 evidence ledger](evidence/gitlab-19.2.md) — claims without a ledger anchor are rejected on review (#94, #100).

```text
  specgit init / setup      once per repository: policy + acceptance
        |                   harness + agent entry points
        v
  specgit issue "..."       per delivery: issues + branch +
        |                   draft PR (Closes #n) + record,      [GitLab:
        |                   committed and pushed (idempotent     declare the
        |                   resume)                               host first]
        v
  work, commit, push -----> CI on the PR/MR head
        |                   (GitHub: SpecGit Acceptance job;
        |                    GitLab: your pipeline's finish job)
        v
  gh pr ready <n>           a draft PR always fails the verdict
        |                   (glab mr update <n> --ready on GitLab)
        v
  specgit finish            the verdict: eleven gates, fail-closed
        |-- exit 0 --> accepted -> merge -> confirmed issue closure: completed
        |-- exit 1 --> fix what the gates named (evidence complete)
        '-- exit 3 --> fix the environment first (specgit doctor)
```

## Current behavior (deliberate)

A GitLab origin is **recognized, not silently misread**:

- The platform is declared, not guessed: `specgit init --gitlab-host <hostname>` (or `<hostname>:<port>` when the instance uses a non-default port, #78; or the interactive platform question) persists the declaration in `spec_git/providers.yaml`, committed so the team shares it. A `github.com` origin defaults to GitHub with no declaration needed.
- `parseRepoRef` honors the declared endpoint: since #112 a matching origin **resolves through the GitLab origin grammar** — `group[/subgroup…]/project` paths at depth 2–5, URL-encoded `%2F` separators included, on all three accepted forms — with the full group path as the ref's owner and a `gitlab` platform marker (a deeper well-formed path fails closed as `gitlab_unsupported` naming the bound). Since #114 the glab adapter exists (`GlabProvider`, `src/providers/gitlab/glab-cli.ts`), mirroring all port methods over scripted-glab contract tests — including the #116 checks-gate semantics (mapping table + verified `requiredChecks` intersection). Since **#117 evaluation and every gh-backed command route**: the production context wires one `PlatformRoutingProvider` (`src/providers/routing.ts`) that dispatches per call on the platform marker — a GitLab-declared origin's issues, MRs, and pipeline jobs flow through glab, everything GitHub through gh, so no gh call ever sees a group/subgroup ref (the retired `requireGithubRoute` guard's invariant, now held by the dispatch and pinned by `test/specgit/routing-provider.test.ts`); `specgit finish` on a declared GitLab origin evaluates all eleven gates through glab, and the offline e2e (`test/specgit-e2e/gitlab-delivery.e2e.test.ts`) proves the full delivery story on recorded payload shapes. `init` on gitlab mode writes every platform-neutral harness asset but no GitHub Actions workflow (`gitlab_harness_pending` warning; carry your own `.gitlab-ci.yml`, whose top-level job keys init detects as required checks). A `gitlab.com`/`*gitlab*` host without a declaration keeps `gitlab_unsupported` at every depth — the substring heuristic never resolves a ref. Explicit ports follow the #78 rule: a scheme-default port (`:443` https, `:22` ssh) classifies like the portless form; a non-default port classifies only when the declaration names it (`host:port`, persisted as `gitlab.port`). Undeclared non-github origins stay `origin_unresolvable` with a `platform_undecided` warning.
- `specgit doctor` surfaces `gitlab_unsupported` on the `origin` probe while still probing `gh`, so the report shows both facts.
- `specgit init` already classifies the platform from the origin URL (`github | gitlab | unknown`, no network), reads `.gitlab-ci.yml` job keys when no GitHub workflows exist, and reports `glab` presence on PATH (reported only). Policy generation therefore already works for GitLab CI.

## Independent completion after MR verification

With an approved `automation.merge` policy, init installs a native MR trigger
and a separate default-branch completion pipeline. The trigger only starts the
continuation; it does not wait for it. The continuation uses authenticated glab
facts to verify the project, executing pipeline and job, current MR head pipeline,
and the exact upstream trigger relationship before excluding its own pipeline
from recursive checks. The original MR pipeline and every other downstream
pipeline still require success. A matching job name or environment variable is
insufficient evidence. Merging and issue closure retain the expected-SHA and
approved-target-policy checks; `finish` remains read-only.

The default `.gitlab-ci.yml` becomes a managed conditional router. Original
business YAML is preserved byte-for-byte in `.gitlab/specgit-business.yml` and
included for ordinary pipelines. The completion route includes only
`.gitlab/specgit-complete.yml`, so it neither reruns business builds nor waits on
itself. Disabling automation restores the current business file to the root.
GitLab resolves static local includes from the repository root, so their path
base is preserved. Init verifies the complete supported local include tree and
rejects ownership collisions, custom `ci_config_path`, dynamic or external
includes, pipeline inputs and other unprovable migrations before writing.
Existing business rules remain authoritative and must permit a real MR pipeline;
SpecGit does not change those rules to force a passing result.

The completion runner must already provide Node/npm, git and authenticated glab
with the permissions needed for the configured merge and issue closure. Init
never reads or stores a token. Its runtime is installed at the exact configured
SpecGit version; a missing completion protocol reports `runtime_upgrade_required`
instead of executing candidate MR source. Initial adoption therefore requires
an already published compatible CLI and an approved default-branch integration.

## Supported-version policy (self-managed)

- **Self-managed GitLab has a *verified* window of `>= 19.2.4 < 19.4.0`, CE/Free tier** (#98; widened by the #236 rebaseline; downgraded from a hard gate to an advisory check by #241). The known-good anchors are `v19.2.4-ee` at the floor (tagged 2026-08-14, commit `85f4a2d9`) and `v19.3.0-ee` at the head (tagged 2026-08-20, commit `8f83039b`; rows pinned in [gitlab-19.3.md](evidence/gitlab-19.3.md)). A version outside the window **never blocks**: preflight flags it and the verdict carries the warning `gitlab_version_unverified`, then evaluation proceeds against the live APIs. The fail-closed guarantee is the evidence pass itself — every gate reads real API responses through glab, so an API that fails or returns unparsable shapes still yields `unknown` (exit 3) exactly as before. The window moves only through explicit rebaseline deliveries, never silent drift (procedure: [Rebaseline SOP](#rebaseline-sop-moving-the-version-window)).
- **The `-ee`/`-ce` suffix is a release-channel marker, not semver pre-release semantics**: naive semver ordering ranks `19.2.4-ee < 19.2.4`, which is wrong. Version comparison strips the suffix first, then compares the `x.y.z` triple (ledger rule 4).
- **Version discovery uses the authenticated metadata endpoint** (`glab api /metadata`): no unauthenticated version channel is documented at the pinned tag (ledger row 3). `metadata.enterprise` is informational only — never a gate input.
- **GitLab.com (SaaS) is in scope and is judged by capability probing, never version pinning** (#93): the instance auto-upgrades, so a pinned self-managed range cannot apply. The evidence path probes every API surface the delivery depends on with read-only calls; any probe failure ⇒ verdict `unknown` (exit 3). Missing evidence is UNKNOWN = a blocked path, never an inferred capability.
- **glab floor: 1.113.0**, pinned from gitlab-org/cli tag `v1.113.0` (commit `d6288130`). The floor rises to 1.114.0 only if implementation depends on same-host SSH capability, with a cited gitlab-org/cli reference — decided before the first implementation slice. glab authenticates per host (`glab auth status --hostname <host>`; remediation `glab auth login --hostname <host>`; ledger row 8).
- **Implemented environment contract** (#114, mirroring `SPECGIT_GH`/`SPECGIT_GH_TIMEOUT_MS`): `SPECGIT_GLAB` (glab executable path, default PATH) and `SPECGIT_GLAB_TIMEOUT_MS` (default 15000; timeout ⇒ `glab_transport`, exit 3).
- **`gitlab.insecure_ssl` is per-host**: `true` in `spec_git/providers.yaml` is reserved to skip TLS verification for that declared host only — never global, never logged; `false`/absent = full verification. The field is declared-but-inert today: the exact glab host-scoped mechanism is not yet pinned from gitlab-org/cli, so enabling it stays a blocked path until pinned (see [Reference](reference.md); ledger, open unknowns).

## Rebaseline SOP (moving the version window)

The window above is hard-coded by design and moves **only** through an explicit rebaseline delivery — an ordinary SpecGit delivery: one or more independently verifiable issues bound to one branch and PR/MR; `specgit finish` exit 0 establishes acceptance, followed by confirmed merge and closure of every bound issue (#181, audit finding A-4). Since #241 the window is advisory — an outside version warns (`gitlab_version_unverified`) instead of blocking — so a rebaseline moves the *verified* marker (and retires the warning) rather than unblocking users; the evidence discipline is unchanged. Every new self-managed GitLab release or unverified-version warning follows this procedure; no ad-hoc archaeology, no silent drift.

**Triggers**

- A new self-managed GitLab release enters the team's upgrade horizon — a minor release the team intends to run, or a patch release the team wants admitted into the window.
- A user reports the `gitlab_version_unverified` warning from any SpecGit verdict against a declared GitLab origin: their instance version sits outside the verified window, and the warning's fix text points here.

**Steps**

1. **Issue.** File a single rebaseline issue naming the target version (e.g. "rebaseline the GitLab window to >= 19.x.y < 19.(x+1).0") and its trigger — the new release or the `gitlab_version_unverified` report. One issue = one independently verifiable WHY; do not bundle unrelated work.
2. **Constants.** Change exactly two constants in `src/providers/gitlab/glab-cli.ts`: `VERSION_WINDOW_MIN` and `VERSION_WINDOW_MAX_EXCLUSIVE`, plus the window string carried in the `gitlab_version_unverified` message in `src/acceptance/codes.ts`. Nothing else moves: the glab floor (1.113.0) rises only under the condition stated in the policy above, and the `-ee`/`-ce` suffix-stripping comparison (ledger rule 4) never changes.
3. **Evidence recapture.** On an instance running the new target version, recapture the dogfood evidence and commit the artifacts under `docs/evidence/` — the SOP's produced artifacts, named:
   - a new ledger file `docs/evidence/gitlab-<major>.<minor>.md` in the shape of [gitlab-19.2.md](evidence/gitlab-19.2.md): the metadata cell (authenticated `glab api /metadata` — version, revision, `enterprise` informational only), the known-good anchor (release tag + commit), and the re-verified rows the window affects (metadata chain rows 1–3 minimum);
   - refreshed recorded payload fixtures under `test/specgit-e2e/fixtures/gitlab/` whenever a recorded shape changed at the new version;
   - a dogfood witness file in the shape of [gitlab-dogfood-117.md](evidence/gitlab-dogfood-117.md): one real probe delivery on the new version whose `specgit finish` exited 0.
4. **Docs sync.** In the same delivery, update every committed surface that states the window: this document's policy bullet and non-goal, row 5 of the new ledger, `docs/baseline-v1.md`, the dual-platform scope paragraph of `AGENTS.md`, and `README.md`/`docs/cli.md` wherever they quote the range. The machine contract — diagnostic `code`s, exit codes, `--json` fields — is never renumbered or localized.
5. **Regression matrix.** The delivery must land green end to end: `pnpm exec tsc --noEmit`, `pnpm run typecheck:test`, `pnpm run lint`, `pnpm test` — specifically the provider port contract (`test/specgit/provider-port-contract.test.ts`), the scripted-glab adapter contract tests, and the offline delivery e2e (`test/specgit-e2e/gitlab-delivery.e2e.test.ts`) — plus a live smoke on the new-version instance: `specgit doctor` with the origin probe green, and one full probe delivery ending in `specgit finish` exit 0.
6. **Release notes.** The PR body and the CHANGELOG entry state the old and new window, the known-good anchor tag and commit of the new release, and link the new ledger file under `docs/evidence/`.

**Automation proposal (not implemented)**

A scheduled CI job could periodically poll the declared instance's metadata (`glab api /metadata`) or the upstream GitLab release feed, and when the reported version leaves the supported window, open a pre-filled rebaseline issue and a draft PR proposing the constant bump. This is a proposal only — no CI job edits the constants itself: the window moves only through the delivery above, so a proposed bump still runs the full evidence recapture (step 3) and regression matrix (step 5) before `specgit finish` can exit 0.

## Design principles

1. **Mirror the seam, do not fork the gates.** Acceptance evaluation (record → policy → completeness → context → origin → provider → issues → sequence → pr → closing → checks) is platform-agnostic. Only evidence *collection* is platform-specific.
2. **One CLI per platform, authenticated, no tokens in state or logs.** GitHub evidence flows through `gh`; GitLab evidence flows through `glab`. No direct REST clients.
3. **Fail-closed carries over.** Missing glab, unauthenticated glab, or an unreachable GitLab yields `unknown`, never `accepted`. An out-of-window server version warns (`gitlab_version_unverified`, #241) but never blocks on its own — the live API operations are the gate, and any of them failing or returning unparsable shapes fails closed. That includes the evidence-completeness rule (#120): every `rel="next"` continuation must run to exhaustion, and a full page without a usable `rel="next"` link — or a continuation that errors mid-list — fails closed (`evidence_truncated`, exit 3) exactly like `gh` today; a silently partial list is never consumed. The `getOpenIssueNumbers`, `getOpenIssues`, and `getCheckRuns` cells in the method map below are held under this rule from day one.
4. **Free-tier primitives only, honestly reported.** Ultimate-only status checks (`only_allow_merge_if_all_status_checks_passed`) are excluded forever (ledger row 22); `requiredChecks` reports the verified pipeline-gate intersection instead of fabricating GitHub semantics (ledger rows 7/20).

## Phases

### Phase 1 — recognition and diagnostics (shipped)

- Dedicated `gitlab_unsupported` diagnostic for GitLab origins, including nested-group paths (#95).
- `doctor` reports it; `init` reports platform + glab presence.

### Phase 2 — GlabProvider method map

Interface decision recorded (option B — neutral provider port with internal per-platform adapters). **The adapter landed in #114: `GlabProvider` implements every `GitHubProvider` member at `src/providers/gitlab/glab-cli.ts`** (beside the GitHub adapter's #113 home), held to the port shape by the provider contract test and mirrored against the gh adapter's scripted-CLI contract tests. **The #116 slice landed the checks-gate semantics**: the job→check-run mapping table (ledger row 26) and the Free-tier `requiredChecks` truth — the verified pipeline-gate intersection (rows 7/25), decided per D-4″ (job-level truth + pipeline-level verdict). **Routed in #117: `PlatformRoutingProvider` (`src/providers/routing.ts`) sits at the production composition and dispatches every provider call on the ref's platform marker — gh for GitHub refs, glab for GitLab-declared refs — so acceptance evaluation, bootstrap, repair, and diagnostics all serve a declared GitLab origin through glab** (the GitHub-only `requireGithubRoute` guard was retired with it; the invariant it held now lives in the dispatch). The per-platform adapter home exists since #113: the GitHub adapter lives at `src/providers/github/` (legacy `src/github/gh-cli.ts` / `protection-merge.ts` paths are stable aliases), and the shared CLI transport both adapters spawn through lives at `src/providers/cli-spawn.ts`. The method map follows the current [provider port inventory](providers.md#port-inventory): the twelve cells pinned in the ledger at the #114 landing (row 24; `listOpenPrsByHead` closed by FU-4), plus the members added later that `GlabProvider` implements under the same scripted-CLI discipline — `getOpenIssues` (#77), `getEvidenceAnchor` (#315), `addIssueComment` (#160), and the #330 tag trio (`addIssueLabels`, `listRepoLabels`, `ensureRepoLabels`; the last two are admin-surface seeds for issue tags, Free-tier project labels, Planner-or-above role required to create since 17.7):

| ForgeProvider member | GitLab equivalent (19.2, Free tier) |
| --- | --- |
| `preflight` | `glab auth status --hostname <host>` (per-host auth, ledger row 8) |
| `getCiConfigPath` | `glab api projects/:id`; verify project identity and `ci_config_path` before routing initialization |
| `getIssue` | `glab api projects/:id/issues/:iid` |
| `getOpenIssueNumbers` | `glab api projects/:id/issues?state=opened` with `per_page=100` + `rel="next"` continuation (ledger rows 15/24) |
| `getOpenIssues` | the same exhausted open-issue listing, carrying the full issue facts (#77) |
| `searchIssueHistory` | exhausted issue search across open and closed states; title/body history supports WHY comparison |
| `listIssuePullRequests` | exhausted issue-related MR listing, refreshed from current MR facts; scoped closing references establish occupancy |
| `getPr` | `glab api projects/:id/merge_requests/:iid` (state machine row 19); merged lineage uses the merge commit, squash commit, or explicitly unsquashed frozen diff head (row 28) |
| `getCheckRuns` | with the bound MR iid, read that MR's `head_pipeline` and exhaust only its jobs; verify both MR and pipeline SHA (row 27). Two-argument compatibility calls select the highest id from the bounded SHA listing. |
| `getPrChecks` | read the MR head pipeline and its linked downstream graph, exhaust ordinary and trigger jobs, return all executed jobs plus downstream pipeline states for the opt-in merge gate (rows 27/31) |
| `mergePr` | `PUT projects/:id/merge_requests/:iid/merge` with `sha=<verified-head>`; read the MR again to confirm merged state, without bypassing platform protection (row 30) |
| `closeIssue` | idempotent issue GET, `PUT projects/:id/issues/:iid` with `state_event=close`, then GET to verify closed state (row 30) |
| `getEvidenceAnchor` | no GitLab reviewable-transition anchor exists — an honest `anchoredAt: null` (#315) |
| `createIssue` | `glab api projects/:id/issues -f …` |
| `createDraftPr` | `glab api projects/:id/merge_requests` with `Draft: <title>` (rows 6/18 — `glab mr create` has no structured-output flag) |
| `listOpenPrsByHead` | MR list filtered by source branch (`source_branch` list parameter, pinned FU-4 — ledger row 24) |
| `addIssueComment` | exhaust `GET projects/:id/issues/:iid/notes`, reuse an exact-body note's URL, otherwise POST; CE deep links use the returned note id (row 29) |
| `addIssueLabels` (#330) | `PUT projects/:id/issues/:iid -f add_labels=<a,b>` (union semantics; answer's `labels` array must confirm every slug) |
| `listRepoLabels` (#330) | `GET projects/:id/labels?per_page=100` with exhausted continuation (#120) — project labels only; group labels are a separate surface and out of scope |
| `ensureRepoLabels` (#330) | `POST projects/:id/labels -f name=… -f color=…` per missing spec; HTTP 409 ("already been taken") is presence, not failure |
| `getBranchProtection` | `GET projects/:id/protected_branches/:name` (Free basic fields, row 20); `requiredChecks` = the verified pipeline-gate intersection (rows 7/25, #116) |
| `enableBranchProtection` | protect default branch (integer access levels) + set `only_allow_merge_if_pipeline_succeeds` (rows 7/20), then report the same verified intersection (#116) |
| `getRepoAutomerge` | read `only_allow_merge_if_pipeline_succeeds` from project JSON (row 7) |
| `enableRepoAutomerge` | repo gate (row 7) + per-MR `auto_merge` on merge (row 21) |

Check-run mapping (#116, ledger row 26): a GitLab pipeline job maps to a check whose name is the job name; `policy.required_checks` continues to hold exact names discovered from `.gitlab-ci.yml`, so `spec_git/policy.yaml` stays the single contract. Final states complete the run — `success`/'success', `failed`/'failure' with the platform `allow_failure` boolean carried as job-level truth, `canceled`/'cancelled' (gate-failing) — and the checks gate passes a failed `allow_failure` run per pipeline semantics (row 17; failure only — no other conclusion is laundered). A `skipped` job produces no check-run at all (intentionally not run ⇒ `checks_missing` for a required name); `manual` and every other non-final status read as pending, fail-closed. Retried jobs are omitted by default, so latest-attempt semantics are native (row 16). `requiredChecks` reports the **verified intersection** of the injected policy list with the CI job names of the branch's latest pipeline (`?ref=` filter, `order_by` id `desc` default — row 25) when `only_allow_merge_if_pipeline_succeeds` is on; off ⇒ `[]`, and the init warning carries the enable guidance. The Ultimate-only status-checks primitive is never touched (row 22).

**Selection rule (#100, seam implemented in #112, routed in #117):** only a `providers.yaml` declaration grants the GitLab path. `parseRepoRef` marks a ref `platform: gitlab` solely when the origin matched the declaration (host and port), and the routing provider dispatches on that marker — a GitLab-declared origin is served by glab, everything else by gh; an undeclared `gitlab`-looking host still fails closed `gitlab_unsupported`. `classifyPlatform(originUrl)` — the `github | gitlab | unknown` heuristic — is used **only** for diagnostics and interactive questions; it never resolves a ref and never grants provider capability, and `unknown` platforms stay on the GitHub path and fail closed at the origin gate exactly as today.

Acceptance supplies the bound MR iid to `getCheckRuns`: the MR's `head_pipeline` determines the only eligible pipeline, including its source project for fork MRs. Both the MR SHA and pipeline SHA must match the expected head. A null pipeline produces missing-check evidence; an omitted or malformed identity produces unknown evidence. Older successes cannot fill a current pipeline's missing, skipped, canceled or queued job. Two-argument API calls remain compatible by selecting the highest pipeline id from the bounded SHA list, but the acceptance path always carries the MR context (row 27).

Opt-in merge uses the same MR pipeline and requires its status to be `success`; every executed job must succeed, including jobs marked `allow_failure`. It exhausts both `/jobs` and `/trigger_jobs`, follows `downstream_pipeline` associations, and reads each child's actual pipeline state and both job collections. A successful trigger alone does not prove downstream success. Child names include their project and pipeline ids, so they cannot replace the root pipeline's required names. The traversal deduplicates project/pipeline identities and permits at most 32 pipelines; exceeding that bound, incomplete pagination, missing project identity, cross-host links, or unavailable evidence fails closed. A downstream project comes from its explicit project id or a validated same-host pipeline URL, never the parent project's name. The `trigger_jobs` route is documented since GitLab 19.2 and was read-only verified on 19.3.1 CE (row 31). After acceptance, the merge request sends the verified SHA as an atomic platform condition, confirms the merged state and only then permits bound-issue closure (row 30). `finish` remains read-only. Issue comments are resumable through a complete exact-body scan, without claiming atomic exactly-once creation across concurrent callers (row 29).

Project identity is addressed by full path URL-encoded (`/`→`%2F`) as `:id` (row 4) and verified by numeric project id plus path comparison, because renamed projects redirect transparently (row 5).

### Phase 3 — parity and harness

- The acceptance workflow template gains a GitLab CI variant running `specgit finish` as a pipeline job. CI-job-token evidence gathering is blocked on the live cell (ledger row 10b) — **FU-5 applied in the #117 dogfood**: a read-only project access token (`scopes: [read_api]`) as a masked CI variable authenticates glab inside the job, and the CI-side `specgit finish` exited 0 on the real probe delivery (evidence: [gitlab-dogfood-117.md](evidence/gitlab-dogfood-117.md)). The business acceptance job remains project-owned. Opt-in completion now generates a conditional root router and an independent completion job, as described below.
- `specgit issue` bootstrap **works against GitLab since #117** (proven on the real nested-group probe and offline in `test/specgit-e2e/gitlab-delivery.e2e.test.ts`): draft MRs are created with the `Draft:` prefix (row 18) after the branch push, and MR bodies use the **common subset** closing references (`Closes #<iid>`, `Fixes #<iid>`) — valid on both platforms. Parsing is provider-parameterized: GitLab's default closing pattern (pinned at 19.2, ledger rows 12–14) accepts a superset — the `implement*` family, gerunds, an optional colon or `issue(s)` word between keyword and reference, comma/`and` multi-reference continuations, `group[/subgroup]/project#iid` full-path references, and `/-/issues/<iid>` URLs — and is subject to the pinned cautions (default-branch trigger, per-project auto-close setting, first-push disable, admin-replaceable pattern).
- The generated `AGENTS.md` managed block gains the GitLab-flavored surface when the adapter lands; the ten-command/two-state-file documentation sync is tracked in #91 and merged there — not duplicated here.

## Non-goals

- No cross-platform deliveries (one delivery, one platform, one PR/MR).
- No token storage: `glab` owns credentials, same as `gh` today.
- No Ultimate-tier primitives, ever. Versions outside `>= 19.2.4 < 19.4.0` (self-managed) stay *unverified* — warned about (`gitlab_version_unverified`) — until a rebaseline delivery admits them; they are judged by their live API behaviour in the meantime, never silently trusted.
