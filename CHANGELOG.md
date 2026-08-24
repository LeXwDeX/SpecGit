# specgit

## 1.5.3

### Patch Changes

- [#324](https://github.com/LeXwDeX/SpecGit/pull/324) [`2363c4a`](https://github.com/LeXwDeX/SpecGit/commit/2363c4a4a90dbeb6b41ffe132e4ce31c26b4a6d7) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - Fix `specgit issue` bootstrap ordering: the binding record is committed and the head pushed WITH that commit before PR creation, so fresh deliveries no longer die at "No commits between main and <branch>" on real GitHub ([#323](https://github.com/LeXwDeX/SpecGit/issues/323)).

## 1.5.2

### Patch Changes

- [#321](https://github.com/LeXwDeX/SpecGit/pull/321) [`1d9eec2`](https://github.com/LeXwDeX/SpecGit/commit/1d9eec222505b6ed4fbbf3800ad0d6e953622b81) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - The generated acceptance workflows cancel superseded runs via a concurrency group: a newer trigger event on the same pull request no longer leaves older acceptance copies burning parallel wait budgets ([#319](https://github.com/LeXwDeX/SpecGit/issues/319)).

## 1.5.1

### Patch Changes

- [#317](https://github.com/LeXwDeX/SpecGit/pull/317) [`d3dfb1d`](https://github.com/LeXwDeX/SpecGit/commit/d3dfb1d2d007ffc320412a5e168ba1fdd3b04f6f) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - Enforce fresh check evidence: the verdict and the generated wait step anchor at the ready-for-review transition — a truth run that started before the delivery became reviewable is not acceptance evidence ([#315](https://github.com/LeXwDeX/SpecGit/issues/315), [#316](https://github.com/LeXwDeX/SpecGit/issues/316)). The product CI re-verdicts on the transition.

## 1.5.0

### Minor Changes

- [#293](https://github.com/LeXwDeX/SpecGit/pull/293) [`f429c86`](https://github.com/LeXwDeX/SpecGit/commit/f429c862cc625bcbe799eb6c8190b2228e216abd) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - Shield the local delivery assets from git by default: `specgit init` now appends a managed, idempotent block to the root `.gitignore` covering `/.specgit.yaml` and `/spec_git/`, so record rewrites and policy regens never leak into unrelated commits ([#292](https://github.com/LeXwDeX/SpecGit/issues/292)). `.gitignore` only hides untracked files, so the bootstrap's own binding commit force-stages the authoritative delivery files (record always; policy and providers when present) onto the delivery branch — the CI verdict still reads them there. Pass `--no-ignore` to keep the classic committed model.

- [#303](https://github.com/LeXwDeX/SpecGit/pull/303) [`d993b56`](https://github.com/LeXwDeX/SpecGit/commit/d993b56896d575b7ed9451a7160d21aae62a92a4) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - Close the local/CI verdict fork on record repairs ([#299](https://github.com/LeXwDeX/SpecGit/issues/299)): `specgit pr` and `specgit bind` now carry the rewritten record into git on the delivery branch — the same force-staged, pathspec-limited binding commit the bootstrap uses, followed by `git push -u` — so the CI verdict on the PR head reads the same record the local verdict does. A local commit failure exits 3; a push failure downgrades to `record_carry_push_failed` (offline/sandboxed environments stay usable, the warning names the stale-verdict consequence); an off-branch repair skips the carry with `record_carry_skipped` instead of silently forking.

- [#306](https://github.com/LeXwDeX/SpecGit/pull/306) [`edf6595`](https://github.com/LeXwDeX/SpecGit/commit/edf65954f06dfb0a67767b61f3b9f5604516c710) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - Make `specgit init --force` the supported version-upgrade operation: it now converges an adopting repository to the running version's complete desired init-owned asset state ([#305](https://github.com/LeXwDeX/SpecGit/issues/305)). The managed `.gitignore` region is delimited by start/end markers and reconciled to the current entry set (a later version's new entries appear inside an existing region; a legacy or damaged region is migrated by consuming only the marker and the entry lines SpecGit knows it wrote, so adjacent user rules keep their bytes and position), an obsolete SpecGit-owned GitHub acceptance workflow is safely removed when a refresh declares GitLab (only with proven content ownership — anything else is preserved and reported), and the harness, policy, ignore, and providers mutations run inside one reversible transaction, so a failed upgrade restores the exact pre-run tree — bytes, modes, and directories created by the run — instead of leaving a mixed-version state. The init envelope gains `reconciled: { created, updated, removed, preserved }`.

  `specgit setup` joins the same upgrade story ([#307](https://github.com/LeXwDeX/SpecGit/issues/307)): re-running it after a CLI upgrade converges the selected agent surface (`--tool opencode | generic | all`) inside the same reversible transaction. Every generated command and skill now carries a `specgit-managed-entry-point` ownership marker (the released skills' `metadata.author: specgit` line is equivalent evidence), so a later version that retires an entry point removes it only when the bytes prove SpecGit ownership — an unmarked `specgit-*` file is user content, preserved byte-for-byte and reported as `unowned_asset_preserved`, never deleted — while discovery stays bounded to the selected surface's root and the unselected surface is never touched. A failed run restores the exact pre-run tree, and a second successful run is a filesystem no-op. The setup envelope's `assets` gains `reconciled: { created, updated, removed, preserved }` additively.

  `specgit status` becomes the deterministic local upgrade check ([#308](https://github.com/LeXwDeX/SpecGit/issues/308)): its `assets` area gains `generated`, a read-only drift report over the same desired states the writers converge (one shared inspector — no parallel checklist). Every managed asset is `current`, `stale`, `missing`, or `conflict` (unproven ownership — a human decision), grouped by the surface that repairs it with the exact fix command (`specgit init --force` / `specgit setup --tool opencode` / `specgit setup --tool generic`), with stable machine codes (`asset_stale`, `asset_missing`, `asset_conflict`) that never localize. An optional setup surface nothing was installed on is `absent` — clean, no missing-file list; each installed surface is diagnosed independently. The verdict is fail-closed about its own coverage: `complete` is true only when every desired part was claimed or proven skipped, and `clean` requires `complete` plus no stale/missing/conflict surface — "no detected drift" is never "proven clean". `uninspected` codes name every unknown that makes a report incomplete (undecided platform — including an invalid `spec_git/providers.yaml`, whose platform is never guessed from the origin — unresolved default branch, unmergeable hooks.json, a failed tracked probe, an unreadable `.gitignore`), while `skipped` names the intentional, proven opt-out (the committed-authoritative `.gitignore` model), which never spoils an otherwise current report; human output distinguishes current, drifted, and incomplete and never says current for an incomplete report. Drift never changes the exit code, the inspection never writes/prompts/calls the forge, and fail-closed snapshots carry no drift claim. The documented upgrade sequence — upgrade CLI → `init --force` → `setup --tool …` → `status` clean → review/commit — is pinned by a product-journey test that proves `git status --porcelain` stays empty after the upgrade commit.

  The managed agent guidance makes issue-first delivery explicit ([#309](https://github.com/LeXwDeX/SpecGit/issues/309)): the `AGENTS.md`/`CLAUDE.md` block generated by `specgit init` (both `en` and `zh`) now opens its agent-contract essentials with the rule that any non-trivial mutation — a feature, a fix, a refactor, a docs change — becomes tracker issues via `specgit issue <type>: <title>...` before development starts, that mid-conversation inventories become issues rather than chat artifacts or private checklists, and that trivial replies and read-only questions are exempt. The existing duplicate-search and one-WHY-per-issue guidance stays intact, `docs/agent-contract.md` gains the matching normative section, and a seeded old-version fixture test proves `init --force` rebuilds a pre-rule block byte-exactly while the user text around the markers survives untouched.

  Required-check selection on `init --force` becomes preserve-on-upgrade ([#310](https://github.com/LeXwDeX/SpecGit/issues/310)): a no-argument `init --force` is a version upgrade of the generated assets, not a policy re-birth — a valid existing policy's `required_checks` and `language` are preserved exactly (names and order, zero-check no-CI policies included), detection never replaces a working policy, and the run says so (`checks_preserved` warning; the human summary names the replacement path). Explicit repeated `--required-check` remains the one intentional replacement path and fully replaces the list; `--no-detect` refuses guessing, not preserving (it keeps demanding explicit names only when there is no policy to preserve). Fresh-init detection is held to the same truth boundary as the [#121](https://github.com/LeXwDeX/SpecGit/issues/121) trigger filter: a matrix job (placeholder name or not — the job id is not the expanded check-run name) and a reusable-workflow call have no statically provable check-run name, so they are never armed as required checks — they are reported in the new `detected.ambiguousJobs` envelope field with a `checks_name_ambiguous` warning naming the legitimate repairs (explicit `--required-check` with the real expanded names, or a flat-named aggregator job); a workflow with no provable names yields the fail-closed zero-check fallback policy with that warning, never a guessed name. Exact repeated display names across jobs de-duplicate to one entry, and detection now reads the discovered repository root instead of the invocation cwd.

  The documentation and diagnostic vocabulary converges on the [#63](https://github.com/LeXwDeX/SpecGit/issues/63) schema truth ([#312](https://github.com/LeXwDeX/SpecGit/issues/312)): `required_checks` is an array of non-empty strings and the array itself may be empty — the no-CI policy, where the generated SpecGit Acceptance job enforced through branch protection remains the gate. The customization, team-workflow, concepts, and troubleshooting pages that still claimed an empty list is invalid (or that the list must be non-empty) now state the empty/no-CI semantics — stale claims pushed users toward invented check names that never report and permanently trigger `checks_missing` — and `policy_invalid`'s fix stays generic to every invalid-policy cause (malformed YAML, unknown keys, wrong types, empty names) instead of falsely demanding at least one check. An anti-drift docs-consistency test pins the unified wording over the canonical pages and the diagnostic registry.

  The last bare-`specgit bind` repair recommendations converge on the issue-first story ([#313](https://github.com/LeXwDeX/SpecGit/issues/313)): the `record_missing` fix defined once in the kernel now drives both the record reader's evidence (surfaced by `specgit status` as the unbound state's `warnings[].fix`, which the managed status skill documents as naming `specgit issue`) and the acceptance code registry (`CODE_INFO.record_missing`, the fallback for finish/accept diagnostics). The shared wording leads with a concrete bootstrap — `specgit issue <title-or-number>...` — and mentions `specgit bind` only after the primary path, described as the lower-level scripting alias that writes or updates the delivery binding record from explicit inputs (not an equivalent bootstrap: `specgit issue` also creates the issues, branch, draft PR, and carrying commit/push); exit codes and machine shapes are untouched (`status` stays unbound with exit 0, finish/accept stay unknown with exit 3), and a focused test pins the reader evidence and the registry fix to the one shared string so the two sources cannot drift apart again.

  The whole upgrade journey is now cross-platform ([#314](https://github.com/LeXwDeX/SpecGit/issues/314)): the managed-asset reconciler compares and repairs mode drift only to the extent the filesystem can enforce it — full POSIX permission bits on Linux/macOS, the read-only attribute (the owner-write bit) on Windows, where Node can neither observe nor produce `0o644`/`0o755`. One shared equivalence rule serves the writer's plan, the `status` inspector, commit, and rollback, so a converged repository stays converged on every supported OS: a second `init --force` or `setup` run is a filesystem no-op and `status --json` can prove `assets.generated.clean` on Windows, while enforceable drift (including mode-only drift on POSIX and a read-only file a writable step desires on Windows) is still detected and repaired. A managed target that drifted write-protected no longer crashes the repair: the reconciler adds exactly the owner-write bit before it rewrites, unlinks, or rollback-restores such a target (EPERM on Windows, EACCES on POSIX before), and the final chmod puts the intended protection back — so retiring or refreshing a read-only SpecGit-owned asset works on every platform and a failed run still restores the pre-run protection byte-and-mode-exact.

- [#304](https://github.com/LeXwDeX/SpecGit/pull/304) [`ca73c23`](https://github.com/LeXwDeX/SpecGit/commit/ca73c23326baa674b3b40ddca35643fe31e18fe2) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - Converge the three forked copies of the sibling-check wait step into one shared generator ([#300](https://github.com/LeXwDeX/SpecGit/issues/300)): `src/cli/wait-step.ts` now renders the step for both workflow templates (REST for the self template, `gh api` for the external one) and — through the byte-exactness pin — this repository's own live workflow, so transport, retry, and [#119](https://github.com/LeXwDeX/SpecGit/issues/119) truth-run semantics can never diverge again. The wait step also pages the check-runs listing to exhaustion (`per_page=100` until a short page): on a head with more than 100 check-runs the required names were invisible before and the gate timed out after 15 minutes. The dead `retryAfterHeader` variable is gone.

### Patch Changes

- [#296](https://github.com/LeXwDeX/SpecGit/pull/296) [`cff970e`](https://github.com/LeXwDeX/SpecGit/commit/cff970e01c49b15b3e1f760cbef1af50009b1ccf) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - Fix the adoption cold-start ordering: the acceptance wait step now diagnoses an absent `spec_git/policy.yaml` at the PR head with an actionable message instead of an ENOENT crash (all three template copies), the interactive protection prompt warns that a fresh adoption must merge its adoption PR before the acceptance check becomes required, and README/existing-projects agree on the ordering — protect after the adoption merge, never before ([#297](https://github.com/LeXwDeX/SpecGit/issues/297)).

- [#302](https://github.com/LeXwDeX/SpecGit/pull/302) [`dd15929`](https://github.com/LeXwDeX/SpecGit/commit/dd1592977de3958edcf29325188af2c82f722fa9) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - Merged-delivery lifecycle honesty ([#298](https://github.com/LeXwDeX/SpecGit/issues/298)): `specgit unbind` on a tracked record now warns `record_deletion_tracked` (the working-tree deletion needs a commit — the next delivery's binding commit absorbs it) and `specgit init --force` on a tracked policy warns `policy_rewrite_tracked`, both instead of leaving silent working-tree residue after a delivery merges. Backed by a new read-only `GitPort.trackedFiles` member (`git ls-files` intersection, fail-closed as `tracked_probe_failed`, advisory at every call site) documented in the port-compatibility policy.

## 1.4.3

### Patch Changes

- [#290](https://github.com/LeXwDeX/SpecGit/pull/290) [`b801ffd`](https://github.com/LeXwDeX/SpecGit/commit/b801ffd0797f386234ef6589ce4c28ba8cf37f37) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - Fix the release watchdog's evidence source and make GitLab diagnostics honest: the version-PR watchdog now polls workflow runs instead of the per-commit check-run list (approval-waiting runs never create check-runs, so the alarm could not fire — [#265](https://github.com/LeXwDeX/SpecGit/issues/265)), and init on a declared GitLab origin no longer claims to create the GitHub Actions workflow it skips, with checks diagnostics GitLab-shaped there ([#269](https://github.com/LeXwDeX/SpecGit/issues/269)).

## 1.4.2

### Patch Changes

- [#272](https://github.com/LeXwDeX/SpecGit/pull/272) [`24c0c36`](https://github.com/LeXwDeX/SpecGit/commit/24c0c364346759244cb3837fcd57e8f9456c2222) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - Document the `gitlab-mirror` remote as the GitLab live-test and release-sync target in AGENTS.md: GitLab live testing and release syncing go through `git@git.ycgame.com:suntao/specgit.git` (glab-authenticated), and a release counts as done only after `main` and every version tag are pushed to it and verified ([#271](https://github.com/LeXwDeX/SpecGit/issues/271)).

## 1.4.1

### Patch Changes

- [#267](https://github.com/LeXwDeX/SpecGit/pull/267) [`75d2ece`](https://github.com/LeXwDeX/SpecGit/commit/75d2ece43989554ac34c3f0b58a99e6dec01d5c4) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - Align the contract docs with the shipped delivery-name behaviour: the
  product-contract bullet in AGENTS.md, the language section of
  `docs/cli.md` (which contradicted its own updated command section), and
  the v1 baseline now all state that a title yielding no ASCII slug never
  falls back to `issue<N>` — bootstrap asks for a kebab-case delivery
  name, and scripted sessions pass `--delivery <slug>`
  ([#263](https://github.com/LeXwDeX/SpecGit/issues/263)). Documentation
  only — no behaviour or machine-contract change.

## 1.4.0

### Minor Changes

- [#261](https://github.com/LeXwDeX/SpecGit/pull/261) [`50b55ac`](https://github.com/LeXwDeX/SpecGit/commit/50b55ac68eaf48eb7b4c61cc10ef5cf9b59843ca) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ## `specgit issue` never invents a delivery name

  - When a title yields no ASCII slug, bootstrap no longer falls back to
    `issue<N>`: an interactive session is asked for a kebab-case delivery
    name (up to three attempts), and a scripted session fails closed with
    `issue_delivery_name_required` pointing at the explicit flag
    ([#246](https://github.com/LeXwDeX/SpecGit/issues/246)).
  - New `--delivery <slug>` flag names the delivery explicitly and wins
    over the derived slug; an invalid value fails with
    `issue_delivery_name_invalid` before any side effect.
  - Resume never asks again: the recorded name is reused as-is. Branch
    syntax is unchanged (`<type>/<issue>-<slug>`), and the machine
    contract (exit codes, `--json` fields) is untouched.

### Patch Changes

- [#261](https://github.com/LeXwDeX/SpecGit/pull/261) [`50b55ac`](https://github.com/LeXwDeX/SpecGit/commit/50b55ac68eaf48eb7b4c61cc10ef5cf9b59843ca) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - Land the quality-loop workflow spec at `workflows/quality-loop.md` and
  wire it into the agent guidance: AGENTS.md now cites it under working
  discipline, and the dev loop references its pre-merge REVIEW+FIX rounds
  ([#257](https://github.com/LeXwDeX/SpecGit/issues/257)). Documentation
  only — no behaviour or machine-contract change.

## 1.3.2

### Patch Changes

- [#255](https://github.com/LeXwDeX/SpecGit/pull/255) [`9109351`](https://github.com/LeXwDeX/SpecGit/commit/91093514ba8d5266715709b3feaf18840b3b1a39) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - Fix `specgit issue` adoption on GitLab CE: CE issue notes carry no
  `web_url`, and the adapter rejected exactly that normal payload
  ([#252](https://github.com/LeXwDeX/SpecGit/issues/252)). The note deep-link is now derived deterministically from the
  returned id; only a payload carrying neither `web_url` nor an id fails
  closed. Found and verified against a live 19.3.0 CE instance.

## 1.3.1

### Patch Changes

- [#250](https://github.com/LeXwDeX/SpecGit/pull/250) [`5830e56`](https://github.com/LeXwDeX/SpecGit/commit/5830e5610a3f4a0355a9a302a015f1f3f06ed9dd) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - Extract the preflight fact into a named, platform-neutral `PreflightFact`
  on the forge port and rename the advisory flag to `versionUnverified`
  ([#247](https://github.com/LeXwDeX/SpecGit/issues/247)). No behaviour or machine-contract change: exit codes, `--json`
  fields, and the `gitlab_version_unverified` diagnostic code are
  untouched. Also untracks review scratch files and hardens `.gitignore`
  so `git add -A` never sweeps local scratch into a delivery.

## 1.3.0

### Minor Changes

- [#244](https://github.com/LeXwDeX/SpecGit/pull/244) [`868f646`](https://github.com/LeXwDeX/SpecGit/commit/868f64683dc0d2c8dc3ed3994c396a8c74eff664) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ## GitLab version window becomes advisory

  - The self-managed GitLab version window (`>= 19.2.4 < 19.4.0`) is no
    longer a hard gate: a version outside it now warns
    (`gitlab_version_unverified`) and evaluation proceeds against the live
    APIs ([#241](https://github.com/LeXwDeX/SpecGit/issues/241)). The fail-closed guarantee moves to behaviour — any API
    that fails or returns unparsable shapes still yields `unknown`
    (exit 3), exactly as before.
  - The retired `gitlab_version_unsupported` diagnostic (exit 3) is
    removed; nothing emits it anymore. The Rebaseline SOP stays and now
    moves the _verified_ marker (retiring the warning) rather than
    unblocking users — see docs/gitlab-support.md.

## 1.2.0

### Minor Changes

- [#239](https://github.com/LeXwDeX/SpecGit/pull/239) [`45cc10b`](https://github.com/LeXwDeX/SpecGit/commit/45cc10b8862673fc382d9e3f0f07b1761fe18147) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ## GitLab 19.3 rebaseline

  - Widen the self-managed GitLab support window from `>= 19.2.4 < 19.3.0`
    to `>= 19.2.4 < 19.4.0` ([#236](https://github.com/LeXwDeX/SpecGit/issues/236)): 19.3 instances such as `git.ycgame.com`
    (19.3.0 CE, probed live) no longer fail closed with
    `gitlab_version_unsupported` (exit 3) at preflight
  - Evidence chain: release tag anchor `v19.3.0-ee` @ `8f83039b` (tagged
    2026-08-20, protected), Metadata API shape unchanged at the pinned tag,
    fixtures verified unchanged on the live instance, and one real dogfood
    delivery whose `specgit finish` exited 0 on 19.3.0 — see
    [docs/evidence/gitlab-19.3.md](docs/evidence/gitlab-19.3.md)
  - Fake-glab test double now enforces GitLab method routing ([#234](https://github.com/LeXwDeX/SpecGit/issues/234)): known
    paths with unrouted verbs return a GitLab-shaped 404, guarding against
    regressions like the [#229](https://github.com/LeXwDeX/SpecGit/issues/229) PATCH-vs-PUT bug

## 1.1.1

### Patch Changes

- [#232](https://github.com/LeXwDeX/SpecGit/pull/232) [`d1b9227`](https://github.com/LeXwDeX/SpecGit/commit/d1b92275f45fffa9ae96e284eeaeeb2c4d098267) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ## GitLab provider

  - Fix `setPipelineGate` to edit the project with `PUT` instead of `PATCH`:
    GitLab's edit-project endpoint is routed for `PUT` only, so every
    pipeline-gate call returned HTTP 404 and `specgit init` could never enable
    branch protection / auto-merge on a declared GitLab origin ([#229](https://github.com/LeXwDeX/SpecGit/issues/229), [#230](https://github.com/LeXwDeX/SpecGit/issues/230))

## 1.1.0

### Minor Changes

- [#223](https://github.com/LeXwDeX/SpecGit/pull/223) [`b4421b4`](https://github.com/LeXwDeX/SpecGit/commit/b4421b42a328f3a0c0e486b2a430af4b8c4bcd56) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ## Agent harness & delivery experience

  - `specgit setup` installs 5 entry points per tool (issue, finish, doctor, pr, status) with new skills for doctor/pr/status diagnostics ([#164](https://github.com/LeXwDeX/SpecGit/issues/164), [#165](https://github.com/LeXwDeX/SpecGit/issues/165))
  - Doctor output now includes actionable fix guidance for each diagnostic code ([#166](https://github.com/LeXwDeX/SpecGit/issues/166))
  - `specgit issue` posts a traceability comment on each bound issue ([#160](https://github.com/LeXwDeX/SpecGit/issues/160), [#161](https://github.com/LeXwDeX/SpecGit/issues/161))
  - Issue help and skill list all 14 conventional title types ([#174](https://github.com/LeXwDeX/SpecGit/issues/174))
  - Managed AGENTS/CLAUDE block now includes agent contract essentials and draft→ready guidance ([#163](https://github.com/LeXwDeX/SpecGit/issues/163), [#176](https://github.com/LeXwDeX/SpecGit/issues/176), [#183](https://github.com/LeXwDeX/SpecGit/issues/183))

  ## JSON envelope

  - All `--json` envelopes carry a top-level `exit` field matching the process exit code ([#167](https://github.com/LeXwDeX/SpecGit/issues/167))
  - `specgit setup --json` reports `assets` (installed entry points) ([#168](https://github.com/LeXwDeX/SpecGit/issues/168))

  ## Behavioral changes

  - `specgit status` without a record now exits 0 with `state: "unbound"` instead of exit 3 ([#175](https://github.com/LeXwDeX/SpecGit/issues/175)). Scripts should branch on the `state` field or `gates.record` failure rather than exit code alone.
  - GitLab: more than 10 pipelines on the same head SHA causes `finish` to fail-closed with `evidence_truncated` (exit 3) instead of fetching unbounded pages ([#187](https://github.com/LeXwDeX/SpecGit/issues/187))

  ## TypeScript API

  - `ForgeProvider` is the canonical port name; `GitHubProvider` remains as a deprecated alias ([#169](https://github.com/LeXwDeX/SpecGit/issues/169))
  - `ForgeReadPort` / `ForgeAdminPort` split for capability-scoped consumers ([#180](https://github.com/LeXwDeX/SpecGit/issues/180))
  - `RepoRef.platform` is now a required `'github' | 'gitlab'` union ([#186](https://github.com/LeXwDeX/SpecGit/issues/186))
  - Custom `ForgeProvider` implementations must include `addIssueComment` ([#160](https://github.com/LeXwDeX/SpecGit/issues/160))
  - `CommandOutcome` union types split per command for narrower narrowing ([#179](https://github.com/LeXwDeX/SpecGit/issues/179))
  - Unified kernel `SpawnContract` replaces per-module duplicates ([#185](https://github.com/LeXwDeX/SpecGit/issues/185))

  ## Internal quality

  - init.ts decomposed into 5 focused sub-modules (849→173 lines orchestrator) ([#171](https://github.com/LeXwDeX/SpecGit/issues/171))
  - ESLint `no-explicit-any` restored to warn, `no-unused-vars` to error ([#172](https://github.com/LeXwDeX/SpecGit/issues/172))
  - Gate identifiers renamed from g1-g9 to semantic names ([#173](https://github.com/LeXwDeX/SpecGit/issues/173))
  - Test doubles renamed to platform-neutral MockForgeProvider ([#219](https://github.com/LeXwDeX/SpecGit/issues/219))
  - Evidence-cast sweep guard + human anti-drift byte locks + init unit tests added ([#213](https://github.com/LeXwDeX/SpecGit/issues/213), [#214](https://github.com/LeXwDeX/SpecGit/issues/214), [#220](https://github.com/LeXwDeX/SpecGit/issues/220))

## 1.0.1

### Patch Changes

- [#153](https://github.com/LeXwDeX/SpecGit/pull/153) [`a48997a`](https://github.com/LeXwDeX/SpecGit/commit/a48997a3ad6571b457ea3c82f38ba4ad059f8327) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - Docs: refresh the README for the 1.0 dual-platform release — full English, a Platforms section (GitHub out of the box; self-managed GitLab CE >= 19.2.4 < 19.3.0 via --gitlab-host and glab), npm badge, corrected stale facts (CLI is published; specgit setup shipped with [#7](https://github.com/LeXwDeX/SpecGit/issues/7)), and the glab surface in prerequisites, command table, env vars, and security. Align the linked docs with the shipped dual-platform contract: baseline-v1 non-goals, overview, concepts, glossary, FAQ, agent contract, installation, reference, getting-started, existing-projects, and the skills index.

- [#157](https://github.com/LeXwDeX/SpecGit/pull/157) [`a6e7ab1`](https://github.com/LeXwDeX/SpecGit/commit/a6e7ab16c6454550ec84aa400503d82e1c313d5b) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - Fix: scaffolded issue headings no longer carry (required)/(optional) markers — the template meta-information leaked verbatim into created issues (observed on [#152](https://github.com/LeXwDeX/SpecGit/issues/152)) and was copied downstream by LLM authors. Headings are now `## Why` / `## Scope` / `## Acceptance` in both locales (zh: 为什么/范围/验收); a regression test pins every locale marker-free. The deterministic-scaffold boundary ([#77](https://github.com/LeXwDeX/SpecGit/issues/77) adoption) and the PR scaffold are unchanged in shape.

## 1.0.0

### Major Changes

- [#90](https://github.com/LeXwDeX/SpecGit/pull/90) [`b550dc1`](https://github.com/LeXwDeX/SpecGit/commit/b550dc1c09e0f2a9eceb5d8364e9bd24fb9fd5f6) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - # Public Launch v1.0 ([#73](https://github.com/LeXwDeX/SpecGit/issues/73))

  Promote SpecGit to 1.0.0: the ten-command surface with `setup` public and
  `bind`/`unbind`/`accept` as automation aliases, the exit-code contract,
  `--json` single-document envelope, and fail-closed acceptance evaluator are
  declared stable. The 0.x line closes with 0.7.2; every blocking launch issue
  ([#62](https://github.com/LeXwDeX/SpecGit/issues/62)–[#72](https://github.com/LeXwDeX/SpecGit/issues/72)) is merged and dispositioned, security alert queues are empty, and
  the release-candidate certification path ([#71](https://github.com/LeXwDeX/SpecGit/issues/71)) has exercised build, tarball
  shape, registry reachability, and provenance dry-runs without publishing.

### Minor Changes

- [#82](https://github.com/LeXwDeX/SpecGit/pull/82) [`92fc99a`](https://github.com/LeXwDeX/SpecGit/commit/92fc99a7a21fd89784e358d288cbfe1fcb189e6f) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - Establish the coherent public CLI and state contract ([#69](https://github.com/LeXwDeX/SpecGit/issues/69)).

  - The command registry is pinned at exactly ten commands with `setup` public and `bind`/`unbind`/`accept` presented as automation aliases in help; the registry is exported (`COMMAND_NAMES`) and contract-tested against help output and the generated agent surface.
  - `specgit --help` documents the `SPECGIT_GH` and `SPECGIT_GH_TIMEOUT_MS` seams and the full exit-code contract, including the Ctrl-C 130 interruption exception: 130 sits outside the JSON envelope — stdout stays empty (exactly zero documents even under `--json`) and `Interrupted.` goes to stderr. The behavior is centralized in `EXIT_INTERRUPTED` + `emitInterrupted` and pinned by tests.
  - `specgit status` failure exits now match the normative table: exit 3 when the policy is missing/invalid or git cannot be spawned (previously exit 0), while factual mismatches (branch, origin, completeness) remain reported-through-gates with exit 0.
  - Gate-count truth is fixed at eleven (including `sequence`): `GATE_ORDER` is exported, and the finish/accept docstrings and the generated `specgit-finish` skill name all eleven gates.
  - State is classified through a three-tier taxonomy exported from `src/cli/state-taxonomy.ts` (authoritative committed files, derived committed harness, local integration assets) and surfaced in `status --json` as `assets`.
  - The managed AGENTS.md block generated by `init` now covers the whole ten-command surface.

- [#81](https://github.com/LeXwDeX/SpecGit/pull/81) [`00bff6b`](https://github.com/LeXwDeX/SpecGit/commit/00bff6bf01997525c57513f8ee44127296e6c433) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - Make `specgit init` non-destructive and governance-preserving ([#62](https://github.com/LeXwDeX/SpecGit/issues/62)).

  - All validation — flag checks, `--gitlab-host` validation, `policy_exists`, and a root-writability preflight — now happens before any filesystem or remote mutation. A rejected init leaves the repository byte-identical.
  - The harness write is error-atomic: mid-sequence failures roll every target back to its pre-write bytes and modes.
  - Existing hooks are merged, never overwritten: `.opencode/hooks.json` user entries and unknown keys are preserved (unparseable files left untouched with a warning), and a user git `pre-push` hook keeps its content with the specgit guard appended inside managed markers. The git hook installs via `git rev-parse --git-path hooks`, so linked worktrees and `core.hooksPath` (husky/lefthook) are respected.
  - `--protect` is now read-modify-write: existing required checks, reviews (including dismissal rules), push restrictions, admin enforcement, and rule booleans are read and preserved, with `SpecGit Acceptance` the only addition. The warned-path fix guidance no longer prints a command that would clear reviews/restrictions.
  - Re-init contract change: `init` with an existing policy exits 2 having written and probed nothing; `--force` rebuilds the policy and refreshes the harness (managed-block drift repair now happens on `--force`).

- [#147](https://github.com/LeXwDeX/SpecGit/pull/147) [`9626786`](https://github.com/LeXwDeX/SpecGit/commit/9626786da3650af77ff8e118862fa0a493913321) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Language configuration for generated text ([#118](https://github.com/LeXwDeX/SpecGit/issues/118))

  `spec_git/policy.yaml` gains an optional `language` key (`en` default, `zh`
  supported; set with `specgit init --language zh`) that selects the language of
  generated text: the issue-body and draft-PR body scaffolds written by
  `specgit issue`, the managed guidance block injected by `specgit init`, and
  success-path human prose on stderr. `init --force` inherits the existing
  policy's language unless `--language` overrides; unsupported values fail
  closed (`policy_invalid` / `language_invalid`) with the supported set named.

  Branch-slug derivation is now defined for non-ASCII titles under every
  language: any title containing non-ASCII characters derives the numeric
  fallback — issue [#123](https://github.com/LeXwDeX/SpecGit/issues/123) bootstraps branch `feat/123-issue123` (delivery
  `issue123`); the former `issue_title_not_english` rejection is gone. ASCII
  titles keep the first-three-words kebab slug.

  The machine contract is never localized, pinned by tests: exit codes,
  `--json` envelope field names, and diagnostic `code` values stay
  English/ASCII in every configuration (and, in 1.0.0, so does diagnostic
  prose — message/fix/warnings, gate and doctor probe lines); closing-reference
  keywords (`Closes #n`), the acceptance workflow YAML, and the guard scripts
  are untouched by the language key. Documented in README, docs/cli.md,
  docs/reference.md, and docs/baseline-v1.md.

  Rides along (docs): release-gates §2 evidence backfill for [#119](https://github.com/LeXwDeX/SpecGit/issues/119)/[#120](https://github.com/LeXwDeX/SpecGit/issues/120)/[#122](https://github.com/LeXwDeX/SpecGit/issues/122)
  and the §1 I3b status cell (E-1), and the §5 defer ruling for the bootstrap
  chain-order hardening (E-3, post-1.0.0 evergreen probe).

- [#81](https://github.com/LeXwDeX/SpecGit/pull/81) [`00bff6b`](https://github.com/LeXwDeX/SpecGit/commit/00bff6bf01997525c57513f8ee44127296e6c433) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - Generate a portable acceptance harness for external repositories ([#63](https://github.com/LeXwDeX/SpecGit/issues/63)).

  - `specgit init` now selects the workflow template by repository: the SpecGit repository itself (root package name `specgit`) keeps the local-build template; every other (adopting) repository gets a portable template that installs the published CLI at the exact running version (`specgit@<version>`, no ranges), sets up only Node at the engine floor, parameterizes the adopting repo's remote default branch, and never assumes or invokes the adopting project's toolchain, lockfile, layout, or build. The `--json` envelope reports the choice as `harness.template`.
  - No-CI repositories: init's detection fallback now writes an empty `required_checks` list instead of the unsatisfiable aggregate name "All checks passed" (never a check-run name — it deadlocked the generated wait step and made the verdict impossible). The policy schema accepts the empty list as the no-CI policy; the SpecGit Acceptance job, enforced through branch protection, is the gate. This is a schema widening with rationale documented in `schemas/specgit/schema.yaml`.
  - An unresolvable remote default branch falls back to `main` with a `default_branch_unresolved` warning (same fallback the protection probe already uses).

- [#89](https://github.com/LeXwDeX/SpecGit/pull/89) [`ec2dd29`](https://github.com/LeXwDeX/SpecGit/commit/ec2dd291238199e1d9b18d497d5d2280d324f82e) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Deterministic draft PR scaffold

  `specgit issue` now opens the draft pull request with a deterministic
  scaffold body instead of a bare closing-keyword list: the `Closes #n`
  line for every bound issue comes first, followed by Why / What changed /
  Evidence / Checklist sections. The renderer is a pure function of the
  bound issues — the same binding always renders the identical body — and
  its placeholders are advisory: closing references remain the only body
  gate, and the section text adds no closing-shaped content of its own.

  The body is written exactly once, at draft creation. Resume and
  `specgit pr` repair bind or adopt the existing PR without touching its
  body, so user edits survive every re-run. The renderer reads none of the
  adopting repository's files: repositories keep full ownership of their
  own pull-request templates (`PULL_REQUEST_TEMPLATE.md` in `.github/`,
  the root, or `docs/`), which GitHub skips anyway when a body is passed
  explicitly.

### Patch Changes

- [#139](https://github.com/LeXwDeX/SpecGit/pull/139) [`7650217`](https://github.com/LeXwDeX/SpecGit/commit/765021722ac5cde0054a29beac75f622dff100ac) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### CI dispositions recorded; auto-merge re-arm re-scoped to after 1.0.0

  Adds the "Known CI dispositions" section to `docs/release-gates.md` — the
  gate-3 record for checks that live outside a delivery PR's own gates: the
  self-hosted-linux leg ([#105](https://github.com/LeXwDeX/SpecGit/issues/105), retirement line), the version-PR auto-merge
  arm-off ([#107](https://github.com/LeXwDeX/SpecGit/issues/107)), the GHAS dynamic-workflow exemption ([#109](https://github.com/LeXwDeX/SpecGit/issues/109)), and Validate
  Release Tracking's event-gate semantics ([#110](https://github.com/LeXwDeX/SpecGit/issues/110): runs only on `pull_request`
  and `merge_group`, skipped on main-push runs by design; its green predicate
  is read on the PR or merge-group run at the threshold). The re-arm comment
  in `release-prepare.yml` now names the actual decision — re-evaluated after
  1.0.0 ships (user ruling 2026-08-20) — replacing the satisfied-but-unmet
  rc.1 condition. Both changes are pinned red-first in
  `test/specgit/release-gates.test.ts` and `test/docs-consistency.test.ts`.

- [#133](https://github.com/LeXwDeX/SpecGit/pull/133) [`7d83c7e`](https://github.com/LeXwDeX/SpecGit/commit/7d83c7eaff76b461f6f7bfb81da6049884fbd461) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Evidence-completeness rule I3b: fail closed on silently truncated evidence lists ([#120](https://github.com/LeXwDeX/SpecGit/issues/120))

  Closes [#120](https://github.com/LeXwDeX/SpecGit/issues/120). The fail-closed promise had one branch implemented — errors
  (ungatherable evidence ⇒ exit 3) — and one unwritten: silent
  incompleteness. `getOpenIssueNumbers` fetched a single search page of 100
  while the same provider paginated `getCheckRuns`: with `ordered_issues:
true` and more than 100 open issues, an earlier open issue on page 2 was
  invisible to the sequence gate and a delivery could exit 0 over a
  violated policy; same-title adoption missed adoptable issues beyond
  page 1.

  - The rule is now contract, written as the second fail-closed branch in
    [docs/baseline-v1.md](../docs/baseline-v1.md): every list-shaped
    evidence input is paginated to exhaustion or signals truncation, and a
    truncation signal degrades the verdict to `unknown`
    (`evidence_truncated`, exit 3) — never a complete-evidence exit 1.
  - `getOpenIssueNumbers` pages the issue search to exhaustion
    (per_page=100, deduplicated across page-boundary shifts);
    `incomplete_results: true` and the 1000-result search cap (10 full
    pages) fail `evidence_truncated`. `getCheckRuns` now signals
    truncation at its 10-page cap instead of returning a possibly partial
    list. The sequence gate and issue adoption consume the complete list
    through the same seam; the provider port documents the completeness
    contract (`ok` means exhausted).
  - `specgit pr` discovery stays as-is, disclosed: its bounded probe
    refuses on zero/several matches, so truncation cannot flip an outcome
    (≥2 always refuses with the candidate list).
  - The GitLab provider plan's `rel="next"` continuation
    ([docs/gitlab-support.md](../docs/gitlab-support.md)) is confirmed to
    carry the same rule from day one: continuation to exhaustion, full
    page without a usable link ⇒ `evidence_truncated`, exit 3.
  - TDD: a >100-issues scripted-provider fixture pins the sequence gate's
    false pass before the fix (red: 5 failed / 115 passed) and the correct
    complete-evidence rejection after; revert-verified (src/ reverted ⇒
    the same 5 reds return). Gates table, sequence semantics, provider
    seam rules, and `issue` diagnostics updated in docs.

- [#144](https://github.com/LeXwDeX/SpecGit/pull/144) [`0eff38c`](https://github.com/LeXwDeX/SpecGit/commit/0eff38cb7516eee8637b28cf6414ebbcf4def216) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### GitLab checks-gate semantics: allow_failure truth and the Free-tier requiredChecks ([#116](https://github.com/LeXwDeX/SpecGit/issues/116))

  Decided per D-4″ (job-level truth + pipeline-level verdict) and pinned by
  new ledger rows 25/26 (`docs/evidence/gitlab-19.2.md`, anchored at
  `v19.2.4-ee`):

  - `CheckRunInfo.allowFailure?` (provider port): a GitLab `allow_failure`
    job reports its truthful `conclusion: 'failure'` with the platform
    boolean, and the checks gate passes the run per pipeline semantics —
    a failed `allow_failure` job keeps the pipeline green (ledger row 17).
    Failure only: every other conclusion (cancelled, …) still fails,
    allowed or not. The GitHub adapter never sets the flag, so GitHub
    verdicts are byte-for-byte unchanged.
  - `GlabProvider#getCheckRuns` maps the full job-status vocabulary
    (pinned "Job status values" list): final states complete the run
    (`success`/'success', `failed`/'failure', `canceled`/'cancelled'),
    `skipped` jobs contribute no check-run at all (intentionally not run —
    a required name reads `checks_missing`), `manual` and every other
    non-final status stay pending (fail-closed). Retried jobs stay omitted
    (`include_retried` never passed, row 16).
  - `GlabProvider` gains a `requiredChecks` constructor option (the
    policy's list): `getBranchProtection`/`enableBranchProtection` now
    report the **verified pipeline-gate intersection** — the policy names
    that exist as CI job names of the branch's latest pipeline
    (`?ref=` filter, `order_by` id `desc` default — row 25) when
    `only_allow_merge_if_pipeline_succeeds` is on; off ⇒ `[]`. The
    Ultimate-only status-checks primitive is never touched (row 22), and
    without the policy injected the list stays honestly empty.
  - Open sub-mappings resolved in the ledger: `manual`⇒pending,
    `skipped`⇒absent (rationale recorded); the `WIP:`-prefix deferral is
    re-affirmed.
  - Unit tests pin the whole mapping table (allow_failure / retry /
    locked / skipped) and the intersection (gate on/off, no pipeline,
    slash-ref encoding, rename fail-closed, witness pagination I3b);
    existing GitHub checks-gate tests are unchanged and green.

  Not routed: evaluation still runs the gh path (`gitlab_unsupported`
  guard) until [#117](https://github.com/LeXwDeX/SpecGit/issues/117).

- [#146](https://github.com/LeXwDeX/SpecGit/pull/146) [`8f89a63`](https://github.com/LeXwDeX/SpecGit/commit/8f89a630343a8058feee5a1c815a1163a0e1b664) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### GitLab evaluation routing, e2e variant, and the nested-group dogfood ([#117](https://github.com/LeXwDeX/SpecGit/issues/117))

  The Phase-2 routing slice: a declared GitLab origin is now SERVED, not
  just recognized.

  - New `PlatformRoutingProvider` (`src/providers/routing.ts`) at the
    production composition (`src/cli/wiring.ts`): one provider for the
    commands, dispatching every call on the ref's platform marker ([#112](https://github.com/LeXwDeX/SpecGit/issues/112))
    — GitLab-declared refs to `GlabProvider` (constructed lazily with the
    declared hostname and the policy's `required_checks`, per [#116](https://github.com/LeXwDeX/SpecGit/issues/116)),
    everything else to the gh adapter. `preflight()` follows the delivery
    origin's resolved platform. The [#112](https://github.com/LeXwDeX/SpecGit/issues/112) invariant "no gh call ever sees
    a group/subgroup ref" moves from the retired `requireGithubRoute`
    guard into the dispatch (pinned by
    `test/specgit/routing-provider.test.ts` and the offline e2e's
    git-and-glab-only PATH).
  - `specgit finish` on a declared GitLab origin evaluates all eleven
    gates through glab (the origin gate passes the platform-marked ref;
    the closing gate already parses the GitLab dialect since [#115](https://github.com/LeXwDeX/SpecGit/issues/115)).
    Undeclared `gitlab`-looking hosts and too-deep paths still fail
    `gitlab_unsupported` at parse level.
  - `specgit init` on gitlab mode writes every platform-neutral harness
    asset but NO GitHub Actions workflow (`gitlab_harness_pending`
    warning; `harness: { template: 'gitlab-pending' }`) — the repo
    carries its own `.gitlab-ci.yml`, whose top-level job keys init
    detects as required checks.
  - `specgit doctor`'s provider probes follow the platform (envelope keys
    `gh_present`/`gh_authenticated` stay; `glab_missing` /
    `glab_unauthenticated` map onto them).
  - e2e: `external-repo-fixture.ts` gains the GitLab variant
    (`makeGitlabExternalRepo` — nested-group origin, pushable bare
    remote, own `.gitlab-ci.yml`); `gitlab-delivery.e2e.test.ts` proves
    the full delivery story offline on recorded payload shapes from
    `test/specgit-e2e/fixtures/gitlab/` (init → issue/MR bootstrap with
    the `Draft: ` prefix and the deterministic scaffold → finish exit 0,
    all gates green, zero gh reachable).
  - Dogfood evidence (GA gate 4): a real nested-group delivery on
    git.ycgame.com 19.2.4 CE with `specgit finish` exit 0 — archived in
    [docs/release-gates.md](../docs/release-gates.md) GA-4 and
    [docs/evidence/gitlab-19.2.md](../docs/evidence/gitlab-19.2.md);
    FU-5 (read-only project access token) applied as the CI-side glab
    credential.
  - GitHub-side zero regression: the GitHub paths are byte-unaffected
    (router dispatch is a no-op for github refs; gh tests unchanged).

- [#101](https://github.com/LeXwDeX/SpecGit/pull/101) [`3f937b1`](https://github.com/LeXwDeX/SpecGit/commit/3f937b13b766f35f0ddb51bd2f6fb45145ecd2a1) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### GitLab evidence gates: committed ledger, version-qualified policy, nested-origin diagnostic accuracy

  Closes the GitLab evidence-gate delivery ([#93](https://github.com/LeXwDeX/SpecGit/issues/93)–[#100](https://github.com/LeXwDeX/SpecGit/issues/100)). No provider code — the
  only production change is a bounded diagnostic fix; everything else is
  committed evidence and version-qualified documentation.

  - Nested-group GitLab origins (`group/subgroup/project`, depth ≥ 2) on a
    declared host or a `*gitlab*` host now report `gitlab_unsupported` with
    platform-neutral fix text instead of `origin_unresolvable` with
    GitHub-pointing advice ([#95](https://github.com/LeXwDeX/SpecGit/issues/95)). GitHub parsing, suffix-spoof hardening, and
    the explicit-port fail-closed rejection are unchanged.
  - New committed evidence ledger `docs/evidence/gitlab-19.2.md`: every GitLab/
    glab behavioral claim pinned to an official anchor (docs.gitlab.com,
    gitlab-org/gitlab @ `v19.2.4-ee`, gitlab-org/cli @ `v1.113.0`) with CE
    applicability, confidence, and status; the unprobed CI-job-token live cell
    is recorded as BLOCKED-live-cell, never invented ([#94](https://github.com/LeXwDeX/SpecGit/issues/94), [#96](https://github.com/LeXwDeX/SpecGit/issues/96), [#97](https://github.com/LeXwDeX/SpecGit/issues/97), [#99](https://github.com/LeXwDeX/SpecGit/issues/99)).
  - `docs/gitlab-support.md` rewritten version-qualified: self-managed support
    exactly `>= 19.2.4 < 19.3.0` CE/Free (fail-closed outside; GitLab.com by
    capability probing), the `-ee` channel-marker comparison rule, glab floor
    1.113.0, planned `SPECGIT_GLAB`/`SPECGIT_GLAB_TIMEOUT_MS`, the full
    12-method provider map including `getOpenIssueNumbers`, and the Phase-2
    selection rule — only a `providers.yaml` declaration grants GitLab;
    `classifyPlatform` never grants capability ([#100](https://github.com/LeXwDeX/SpecGit/issues/100)).
  - `docs/reference.md` (`gitlab.insecure_ssl` per-host semantics, nested-group
    classification) and `docs/troubleshooting.md` (`gitlab_unsupported`)
    version-qualified against the ledger.
  - Redacted GitLab 19.2.4 CE API payload fixtures committed under
    `test/specgit-e2e/fixtures/gitlab/` (data only; two-pass redaction, no
    tokens, no PII) for the future adapter's contract tests ([#96](https://github.com/LeXwDeX/SpecGit/issues/96)).

- [#143](https://github.com/LeXwDeX/SpecGit/pull/143) [`0124770`](https://github.com/LeXwDeX/SpecGit/commit/0124770d319fe846541f497cd631cbbb56ee843b) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### GlabProvider: the 12-method GitLab mirror ([#114](https://github.com/LeXwDeX/SpecGit/issues/114))

  Implements `GlabProvider` (`src/providers/gitlab/glab-cli.ts`) — the
  second `GitHubProvider` adapter, mirroring the gh adapter method-for-method
  through the `glab` CLI: per-host auth (`glab auth status --hostname`), every
  api call host-scoped, `SPECGIT_GLAB`/`SPECGIT_GLAB_TIMEOUT_MS` honored
  (timeout ⇒ `glab_transport`, exit 3), version discovery via
  `glab api /metadata` with the `>= 19.2.4 < 19.3.0` self-managed window
  (`gitlab_version_unsupported` outside; GitLab.com never version-pinned),
  offset pagination to exhaustion with the I3b completeness guard
  (`evidence_truncated` at the cap), `createDraftPr` via the REST create with
  the `Draft: ` title prefix and `iid`/`web_url` JSON mapping (zero stdout
  scraping), `listOpenPrsByHead` via the MR-list `source_branch` filter
  (pinned FU-4, ledger row 24 — all 12 map cells now anchored), project
  identity verified by `path_with_namespace` against rename redirects (row 5),
  and tokens never read, stored, or logged. Read endpoints plus exactly the
  four documented write endpoints (issues, merge_requests,
  protected_branches, project PATCH). The shared CLI transport (spawn seam,
  shebang resolution, sanitization) moved to
  `src/providers/cli-spawn.ts`; the GitHub adapter re-exports it unchanged.
  Scripted-glab contract tests mirror `gh-provider.test.ts` across all
  methods (success / unauthenticated / timeout / bad JSON / pagination >100),
  and the provider contract test pins the adapter to
  `GITHUB_PROVIDER_MEMBERS`. Not routed: evaluation stays gh-only until the
  Phase-2 routing slices ([#115](https://github.com/LeXwDeX/SpecGit/issues/115)/[#116](https://github.com/LeXwDeX/SpecGit/issues/116)) — the `gitlab_unsupported` guard holds.

- [#130](https://github.com/LeXwDeX/SpecGit/pull/130) [`824d5f8`](https://github.com/LeXwDeX/SpecGit/commit/824d5f8afd01ef168272c5eb9ac64f454bebe6a7) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### init detection trust boundary: only PR-triggered workflows become required checks ([#121](https://github.com/LeXwDeX/SpecGit/issues/121))

  Closes [#121](https://github.com/LeXwDeX/SpecGit/issues/121). The required-checks detection predicate classified any
  non-`workflow_dispatch` workflow as PR-running, so push-triggered deploy
  workflows with branch filters and scheduled jobs landed in
  `policy.required_checks` at `specgit init`. Those checks never report on a
  PR head — permanent `checks_missing`, every delivery exits 1 forever — and
  the "never weaken the policy" iron rule made the only correct repair a
  forbidden act. Stillborn harness for affected repo classes.

  - `src/cli/detect-checks.ts`: classification is trigger-inclusion now — a
    workflow contributes required-check candidates only when its triggers
    include `pull_request` or `pull_request_target` (both report check runs
    on a PR head). An omitted `on` key keeps GitHub's default triggers
    (push and pull_request) and still qualifies. Push (filtered or not),
    schedule, dispatch, and every other trigger never qualify.
  - `specgit init` warns (`checks_not_pr_visible`) when workflows with jobs
    but no PR trigger exist, lists them in `detected.nonPrWorkflows`, and
    the fix text names the legitimate repairs: explicit `--required-check`
    for a job that genuinely reports on PR heads, and `init --force`
    re-detection after CI changes.
  - Iron rule re-worded in the docs to distinguish **weakening a true
    policy** (forbidden) from **correcting a wrong-at-birth one**
    (required): docs/cli.md (detection trust boundary), docs/reference.md
    (wrong at birth vs weakening), docs/troubleshooting.md (`checks_missing`
    structural cause), docs/baseline-v1.md (non-goal wording).
  - TDD: init fixture with push-filtered + schedule + `pull_request`
    workflows pins the classification, the warning, and the envelope;
    `pull_request_target` and trigger-less workflows pinned as qualifying;
    dispatch-only workflows now surface in `nonPrWorkflows` too.

- [#60](https://github.com/LeXwDeX/SpecGit/pull/60) [`22b5bbd`](https://github.com/LeXwDeX/SpecGit/commit/22b5bbd1759819ad48e5222064b080f5041b0222) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Attributed timeout diagnostics (`gh_timeout`)

  A `gh` call that exceeds its time budget (default 15 s) now fails with the
  dedicated `gh_timeout` code instead of the generic `gh_transport`, and the
  fix names the three likely causes in order — network reachability
  (`curl -sI https://api.github.com`), a GitHub incident (githubstatus.com),
  or a genuinely slow call — plus the knob: `SPECGIT_GH_TIMEOUT_MS`
  (milliseconds) raises the per-call budget for every `gh` invocation SpecGit
  spawns.

- [#145](https://github.com/LeXwDeX/SpecGit/pull/145) [`e5d6233`](https://github.com/LeXwDeX/SpecGit/commit/e5d6233258a65bf06daec895c6a5b66c8912550c) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Matrix results snapshot re-pinned to an actual run ([#88](https://github.com/LeXwDeX/SpecGit/issues/88) finding 1, 88-1)

  `test/specgit-e2e/MATRIX.md` 'Results' is now the snapshot of record:
  every count is an actual suite run pinned to one platform and one
  commit — Local (darwin arm64, Node v26.7.0) at `0eff38c`: `Tests 797
passed | 1 skipped (798)` across `43` files, matrix-layer files
  `external-matrix` 3 passed and `install-smoke` 6 passed | 1 opt-in
  skip. This retires the drifted 502/599/600 counts that coexisted in
  docs and delivery prose since Wave 4A; the refresh rule is re-run and
  re-pin all three facts (count, platform, commit). The CI note now
  records the workflow facts since `4df0ae0`: 20-minute test-job timeout
  (was 15) and windows-pwsh `VITEST_MAX_WORKERS=1` (was 2; linux/macos
  run 4). Findings 4 and 6 of [#88](https://github.com/LeXwDeX/SpecGit/issues/88) shipped earlier ([#137](https://github.com/LeXwDeX/SpecGit/issues/137), [#134](https://github.com/LeXwDeX/SpecGit/issues/134)).

- [#142](https://github.com/LeXwDeX/SpecGit/pull/142) [`d8a5fb3`](https://github.com/LeXwDeX/SpecGit/commit/d8a5fb3ba95f91baa2e06fe6aada0d12ed314ef8) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Merged-lineage anchor validation ([#76](https://github.com/LeXwDeX/SpecGit/issues/76))

  Closes [#76](https://github.com/LeXwDeX/SpecGit/issues/76). The merged-delivery lineage gate passed the provider's
  `merge_commit_sha` to `git merge-base --is-ancestor` as any non-empty
  string. GitHub normally reports a hex object id, but nothing enforced
  that: a malformed value rode git's opaque exit-128 path to fail closed
  with an unclassified error, and a ref-like value (`origin/main`) was
  resolved by git as a ref — silently accepted as a lineage anchor.

  - `GitPort.headContains` now validates the anchor as a full hex object
    id (40 hex chars for sha1 repositories, 64 for sha256) before any git
    invocation. A non-hex anchor — empty, whitespace, padded,
    ref-like, abbreviated, wrong length — fails closed as
    `merged_lineage_unavailable` without invoking git, so the diagnostic
    is classified at the port, not recovered from a git error.
  - Containment behavior is unchanged for valid anchors: exit 0 remains
    contained, exit 1 remains a decisive not-contained, unknown objects
    still fail closed.
  - Port-level tests pin both directions: 40- and 64-hex anchors reach
    git unchanged (spawn-spy asserts the exact `merge-base` argv), and
    the malformed matrix (empty, whitespace, ref-like, abbreviated,
    39/41/63/65-length) is rejected with zero git invocations; a
    real-repository regression proves `origin/main` is never resolved as
    a ref.

- [#136](https://github.com/LeXwDeX/SpecGit/pull/136) [`e75739a`](https://github.com/LeXwDeX/SpecGit/commit/e75739ac35571e1d595254d41e391bf4269ba0c3) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Nested-group origins on declared hosts resolve; platform routing reads providers.yaml ([#112](https://github.com/LeXwDeX/SpecGit/issues/112))

  Closes [#112](https://github.com/LeXwDeX/SpecGit/issues/112). rc.1 correctly classified nested-group GitLab origins as
  `gitlab_unsupported` ([#95](https://github.com/LeXwDeX/SpecGit/issues/95)) — a diagnostic, not capability. The GA gate
  needs `specgit finish` exit 0 on a real nested-group GitLab delivery,
  which starts with the origin grammar accepting depth-2-plus paths on
  declared hosts and platform selection routing through the committed
  `spec_git/providers.yaml` declaration.

  - `src/gitfacts/origin.ts`: on a **declared** host (and only there —
    the `*gitlab*` substring heuristic never resolves a ref, so no
    substring match grants capability), `parseRepoRef` now accepts
    `group[/subgroup…]/project` paths at depth 2–5, URL-encoded `%2F`
    separators included (both letter cases; any other percent-escape
    fails closed), on all three origin forms (https, ssh URL, scp-like).
    The resolved ref carries the full group path as its owner plus a
    `gitlab` platform marker — reachable solely through the declaration.
    A well-formed path deeper than 5 segments fails closed as
    `gitlab_unsupported` naming the bound; malformed paths, depth-1
    paths, and the scp port-intent shape keep `origin_unresolvable`.
    The GitHub three-form truth table is pinned unchanged (no nested
    paths, no `%2F` decoding on `github.com`).
  - Platform routing ([#100](https://github.com/LeXwDeX/SpecGit/issues/100) selection rule, seam implemented): the new
    `requireGithubRoute` guard is the one seam decision — a ref marked
    `gitlab` fails closed `gitlab_unsupported` with declaration-aware
    text (factual, exit 1: the declaration and grammar are accepted, the
    glab provider is not implemented yet). The evaluator's origin gate
    (G5) and the production CLI wiring (every gh-backed command: `issue`,
    `pr`, `finish`, `status`, `doctor`, `init`) route through it, so no
    `gh` call ever sees a group/subgroup ref; `classifyPlatform` stays
    diagnostics-only.
  - Docs: `docs/reference.md` G5 paragraph documents the accepted forms
    and the routing rule; `docs/gitlab-support.md` current-behavior and
    Phase-2 selection-rule sections updated; `docs/cli.md` platform-mode
    paragraph aligned; evidence ledger row 4 updated from live-cell-only
    to grammar-implemented (API-side `%2F` addressing stays with the
    glab adapter slice).
  - TDD: origin grammar truth table (depth 2–5 × three forms, `%2F`
    decode, depth bound, escape rejection, heuristic/undeclared/github
    pins, spoof corpus) and evaluator routing pins (origin gate failure,
    provider never invoked) — red-first with mutation revert-checks
    recorded (decode removal and depth-bound removal re-redden the
    origin suite; routing removal re-reddens the evaluator suite).

- [#127](https://github.com/LeXwDeX/SpecGit/pull/127) [`99d5e73`](https://github.com/LeXwDeX/SpecGit/commit/99d5e7300514eee96d6c9441612ace42ac382479) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### CI: drop the deprecated magic-nix-cache step from Nix Flake Validation

  Removes the pinned `DeterminateSystems/magic-nix-cache-action@…# v14` step
  from the `nix-flake-validate` job in `.github/workflows/ci.yml` ([#85](https://github.com/LeXwDeX/SpecGit/issues/85), W0′
  decision: repair option). magic-nix-cache is deprecated upstream and its
  FlakeHub registration path fails intermittently from external decay,
  red-noising Nix-touching runs without any product regression (observed on
  main run [32313535281](https://github.com/LeXwDeX/SpecGit/actions/runs/32313535281);
  green again by luck on run 32349155015). The job now builds cold on the
  ephemeral runner store — `nix build`'s sandboxed pnpm fetch needs no cache
  backend, and `spec_git/policy.yaml` is untouched.

  `test/ci-workflows.test.ts` pins the repair: no workflow may reference
  magic-nix-cache again (red-first: the pin failed on the pre-change tree).

- [#134](https://github.com/LeXwDeX/SpecGit/pull/134) [`efe3b72`](https://github.com/LeXwDeX/SpecGit/commit/efe3b7225e7d73cde96d74f3342cb83d6069597c) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Explicit-port origin classification: default ports in, non-default declared ([#78](https://github.com/LeXwDeX/SpecGit/issues/78))

  Closes [#78](https://github.com/LeXwDeX/SpecGit/issues/78) (absorbing facets 2 and 6 of [#88](https://github.com/LeXwDeX/SpecGit/issues/88) per the W1′ wave anchor).
  Legitimate remotes such as `ssh://git@github.com:22/owner/repo.git` failed
  with `origin_unresolvable`; explicit ports equal to the scheme default now
  classify identically to the portless form, without reopening the spoofing
  surface (userinfo, path, query, host-suffix).

  - `src/gitfacts/origin.ts`: the port rule is one seam decision — a shape's
    effective port (explicit digits, else the scheme default: 443 https,
    22 ssh; scp is implicitly ssh:22) classifies when it equals the scheme
    default, or exactly the port a GitLab declaration names. github.com and
    the `*gitlab*` heuristic never accept non-default ports; a declaration
    may (`--gitlab-host host:port`, persisted as `gitlab.port`), and then
    only that exact host:port classifies. Leading-zero ports normalize with
    WHATWG URL semantics (`:022` is 22); ports 0/65536+/non-digit never
    classify. `extractOriginHost` mirrors the same normalization so the
    whole seam answers one port question one way.
  - 88-6 (g5 folding): the evaluator's origin gate now reports
    `gitlab_unsupported` under its own code (factual, exit 1 — complete
    evidence saying the platform is GitLab) instead of folding every
    failure into `origin_unresolvable` with GitHub-pointing advice;
    `docs/troubleshooting.md`'s stale "(exit 3)" claim aligned to the
    implemented contract.
  - 88-2 (init seam): `specgit init`'s regex host extractor is replaced by
    the structural `extractOriginHost` seam — the host never carries
    userinfo or port digits, the explicit port is captured separately — so
    `ssh://git@github.com:22/...` platform-resolves to github and
    `--gitlab-host` validates host and port against the origin endpoint
    (both directions, with the fix naming the `host:port` grammar). The
    TTY-question path persists the port for non-default-port origins.
  - TDD: port truth table + spoof corpus in `test/specgit/origin.test.ts`
    (default ports in, `:8443` undeclared still rejected, declared
    host:port exact-match, malformed declarations fail closed), evaluator
    case `gitlab_unsupported` in `test/specgit/acceptance.test.ts`, init
    tests for the seam and declaration grammar; every slice red-first with
    a mutation revert-check recorded in the PR.

- [#135](https://github.com/LeXwDeX/SpecGit/pull/135) [`15ce8ef`](https://github.com/LeXwDeX/SpecGit/commit/15ce8efc41c48f828a09fd481f853420db886b3d) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Provider adapter home: src/providers/github (zero-behavior move)

  Translates the GitHub adapter to the neutral per-platform home ([#113](https://github.com/LeXwDeX/SpecGit/issues/113),
  Phase-2 entry of the GitLab roadmap). `src/github/gh-cli.ts` and
  `src/github/protection-merge.ts` move verbatim to
  `src/providers/github/` (the only edit inside the moved files is three
  relative import specifiers); `src/github/port.ts` — the `GitHubProvider`
  port and its fact types — stays where the [#80](https://github.com/LeXwDeX/SpecGit/issues/80) compatibility policy pins
  it.

  - **Zero regression by construction:** the legacy `src/github/gh-cli.ts`
    and `src/github/protection-merge.ts` paths remain as stable alias
    modules (`export *` from the canonical home), so the existing GitHub
    suite passes **without editing a single test file** — verified as
    identical counts before and after (651 passed | 1 skipped).
  - **Production imports repointed:** `src/index.ts` and `src/cli/wiring.ts`
    now import `GhCliGitHubProvider` from the canonical home; the public
    API surface is unchanged (same exported names, same types).
  - **Contract tests extended ([#80](https://github.com/LeXwDeX/SpecGit/issues/80)):** the provider-port contract test now
    pins the canonical home — `GhCliGitHubProvider` implements
    `GITHUB_PROVIDER_MEMBERS` from `src/providers/github/gh-cli.ts`, the
    legacy alias modules re-export the _same_ class and functions (identity,
    never copies), and the public API re-exports the canonical
    implementation.

- [#129](https://github.com/LeXwDeX/SpecGit/pull/129) [`d99b09a`](https://github.com/LeXwDeX/SpecGit/commit/d99b09a522ee8b3a6603046a00eb9d36be6b05ec) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Provider port-compatibility contract committed: policy, inventories, contract tests, full port vocabulary

  Keeps the provider ports compatible as the seams evolve ([#80](https://github.com/LeXwDeX/SpecGit/issues/80)). The two TS
  seams behind the provider contract — `GitPort` (`src/gitfacts/port.ts`) and
  `GitHubProvider` (`src/github/port.ts`) — now carry a written compatibility
  policy (`docs/providers.md`): required-versus-optional member rules (ports
  have only required members; optional members exist only on evidence facts
  and must define their fallback — `IssueFact.title`'s adoption fallback is
  pinned), a three-step deprecation path, and tracking obligations for the
  future glab adapter and every test double.

  - **Member inventories live beside the ports** (`GIT_PORT_MEMBERS`,
    `GITHUB_PROVIDER_MEMBERS`) and are compile-checked with
    `satisfies Record<keyof <Port>, true>`: port and inventory cannot drift
    in either direction under `tsc`.
  - **Contract tests** (`test/specgit/provider-port-contract.test.ts`) hold
    every in-tree implementation to the same port shape —
    `GhCliGitHubProvider`, `LocalGitAdapter`, `MockGitHubProvider`,
    `makeGhProvider`, `makeGitPort` — one assertion per implementer for full
    red attribution, plus a doc-sync test pinning `docs/providers.md`'s
    inventory tables to the exported lists member-for-member.
  - **Deliberate proof (recorded in PR [#129](https://github.com/LeXwDeX/SpecGit/issues/129))**: temporarily adding the
    required member `__contractProbe()` to both ports went red everywhere it
    must — `tsc` at every src implementer and both inventory checks (6
    errors); after propagating the probe into the inventories, the contract
    test went red naming all five implementers plus its own fixture and the
    doc-sync (7/9). Reverted; all green.
  - **Real drift found and fixed on first run**: `makeGhProvider`
    (`test/specgit-cli/helpers.ts`) was missing `getOpenIssueNumbers` —
    invisible until now because no gate typechecks `test/`. The double now
    implements it (scriptable via `openIssueNumbers`, default `ok([])`,
    matching `MockGitHubProvider`).
  - **Export completion**: the public API (`src/index.ts`) now carries the
    full port vocabulary — the stable port names `GitPort`/`GitHubProvider`
    plus `GitWritePort`, `BranchCheckout`, `BranchProtectionFact`,
    `RepoAutomergeFact`, and both member inventories — so an alternate
    provider can be written against the public API alone.

- [#123](https://github.com/LeXwDeX/SpecGit/pull/123) [`f484b76`](https://github.com/LeXwDeX/SpecGit/commit/f484b76b7ae9f731fa27c81a4bd3641a338f87f5) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Release gates committed: invariant core, red-line closure list, GA completion vocabulary

  Documents the 1.0.0 definition of done in `docs/release-gates.md` ([#108](https://github.com/LeXwDeX/SpecGit/issues/108)),
  superseding the session-local release-order plan. The document carries the
  provider-neutral, falsifiable invariant core I0–I5 (I3a implemented; I3b in
  flight via [#120](https://github.com/LeXwDeX/SpecGit/issues/120)), the red-line closure checklist for the four 1.0 blockers
  ([#119](https://github.com/LeXwDeX/SpecGit/issues/119) duplicate check-run semantics, [#120](https://github.com/LeXwDeX/SpecGit/issues/120) evidence completeness, [#121](https://github.com/LeXwDeX/SpecGit/issues/121) detection
  trust boundary, [#122](https://github.com/LeXwDeX/SpecGit/issues/122) draft verdict dimension) with evidence slots, the GA five
  gates as the only authoritative completion vocabulary (G-FINAL subsumed), the
  gate-7 protocol (`workflow_dispatch` acceptance run on the release tag, run
  URL archived), and the growth discipline (every ticket cites an invariant or a
  seam; otherwise an explicit accept-or-defer — first exercised by [#118](https://github.com/LeXwDeX/SpecGit/issues/118),
  deferred-to-last).

  Riding the same slice, per the wave brief:

  - **F-1 micro docs fix**: `AGENTS.md` and `docs/baseline-v1.md` no longer
    assert a GitHub-only v1 scope; both now carry the incremental dual-platform
    narrative ratified in `docs/gitlab-support.md` (D-1=A).
  - **PR template time bomb defused**: `.github/PULL_REQUEST_TEMPLATE.md` no
    longer carries the literal `Closes [#123](https://github.com/LeXwDeX/SpecGit/issues/123)` — the placeholder is now
    `Closes #<issue-number>`, so an unedited template can never auto-close a
    real issue.
  - `test/docs-consistency.test.ts` pins all of the above (red-first: all four
    assertions failed on the pre-change tree).

- [#140](https://github.com/LeXwDeX/SpecGit/pull/140) [`61833f4`](https://github.com/LeXwDeX/SpecGit/commit/61833f4ccb93f87925bdb79afb634d7d0212ce90) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Same-title adoption: title-carrying scan, scaffold disambiguation, bounded probe cost ([#77](https://github.com/LeXwDeX/SpecGit/issues/77))

  Closes [#77](https://github.com/LeXwDeX/SpecGit/issues/77). The bootstrap adoption probe — the remotely discoverable
  idempotency marker that lets `specgit issue` adopt an issue a previous
  run created but failed to record — had three defects in one mechanism:
  **trust** (an unrelated pre-existing open issue with the same title was
  silently adopted and bound), **coverage** (adoption read titles through
  a per-issue `getIssue` fan-out over the open list), and **cost** (every
  bootstrap with a pending title argument cost O(open issues) provider
  calls). The completeness face (paginate-or-exit-3 across all list
  consumers) landed with [#120](https://github.com/LeXwDeX/SpecGit/issues/120); this delivery closes the adoption face.

  - New required port member `getOpenIssues` (`OpenIssueFact`: number,
    optional title/body): one paginated title-carrying search — complete
    to exhaustion under the [#120](https://github.com/LeXwDeX/SpecGit/issues/120) I3b contract, `evidence_truncated` on
    `incomplete_results` or the 1000-result cap — replaces the per-issue
    fan-out. `getOpenIssueNumbers` derives from the same scan: one
    pagination implementation, one completeness contract. Probe cost is
    bounded by pages, not open-issue count; a provider-level call-budget
    test pins it (250 open issues ⇒ 3 search calls, zero per-issue GETs).
  - Same-title collisions are disambiguated, never silently adopted: a
    single exact-title open match is adopted; multiple matches resolve to
    a sole candidate carrying the deterministic scaffold body this tool
    writes (the boundary an unrelated human issue does not carry); an
    unresolvable collision is the new usage diagnostic
    `issue_title_ambiguous` (exit 2) listing every candidate, with the fix
    to adopt explicitly by number — zero side effects, never a guess.
  - Fail-closed behavior is unchanged and pinned: probe failures pass
    through (exit 3), numeric-only arguments skip the probe, closed
    issues are invisible by construction (the search pins
    `is:issue+is:open`).
  - TDD: red first — disambiguation, >100-open-issues adoption beyond the
    first page, and budget pins failed against the silent-`.shift()`
    probe (12 red), then green via the seam change; the existing
    exactly-once fault-injection suite (lost durability, title drift,
    PR adoption, zero-side-effect drift refusals) migrated to the new
    seam and passes unchanged in behavior.

- [#138](https://github.com/LeXwDeX/SpecGit/pull/138) [`a61780e`](https://github.com/LeXwDeX/SpecGit/commit/a61780ed08df13d3c2255f896bff9c9729617b76) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### CI: retire the never-green self-hosted-linux test leg ([#105](https://github.com/LeXwDeX/SpecGit/issues/105))

  Removes the experimental `test_selfhosted` shadow job
  (`continue-on-error: true`) from `.github/workflows/ci.yml`. The leg was
  never green: every execution since introduction crashed at job
  initialization with zero steps run — the runner container cannot create
  its tool-cache directory (`/home/runner/work/_tool`, permission denied) —
  an infrastructure-side failure no repository change can influence
  ([W1 diagnosis](https://github.com/LeXwDeX/SpecGit/issues/105#issuecomment-5356816362)).
  The GA-1 retirement line (end of W2, user ruling 2026-08-20) was reached
  with the last five consecutive `main` runs red on the leg (through
  `15ce8ef`), so self-hosted coverage leaves the release matrix with the
  rationale recorded on the issue and referenced from
  [docs/release-gates.md](../docs/release-gates.md) §3. Required checks are
  untouched — hosted `linux-bash`/`macos-bash`/`windows-pwsh` legs stay,
  `spec_git/policy.yaml` unchanged.

  `test/specgit-cli/workflow-security.test.ts` pins the retirement
  red-first: no job may run on the self-hosted pool and no matrix entry may
  carry the self-hosted label or runner (the pin failed on the pre-change
  tree).

- [#126](https://github.com/LeXwDeX/SpecGit/pull/126) [`97056da`](https://github.com/LeXwDeX/SpecGit/commit/97056da796a56f0eb696b47aabf123f4f524c8af) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Test tree under typecheck; pre-push upgrade keeps trailing user content

  - `tsconfig.test.json` brings the test tree under `tsc` with the same
    strictness as `src/` ([#79](https://github.com/LeXwDeX/SpecGit/issues/79)): `pnpm run typecheck:test` visits every test
    file, the CI "Lint & Type Check" job runs it alongside
    `tsc --noEmit`, and the pre-existing backlog (mock `Evidence` widening,
    a missing `getOpenIssueNumbers` fake, two e2e fixture signatures) is
    fixed in the same change — zero product-semantics changes.
  - Fixing 88-3 of [#88](https://github.com/LeXwDeX/SpecGit/issues/88): `mergeGitPrePush` no longer deletes user content
    that follows `# <<< specgit:end <<<` when upgrading the marker-first
    pre-push layout to the spawnable layout — the rebuild keeps everything
    after the managed region and stays byte-stable on re-merge
    (adversarially reproduced on main by W0′; repro landed beside the
    existing coverage in `test/specgit-cli/harness-merge.test.ts`).

## 1.0.0-rc.1

### Patch Changes

- [#101](https://github.com/LeXwDeX/SpecGit/pull/101) [`3f937b1`](https://github.com/LeXwDeX/SpecGit/commit/3f937b13b766f35f0ddb51bd2f6fb45145ecd2a1) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### GitLab evidence gates: committed ledger, version-qualified policy, nested-origin diagnostic accuracy

  Closes the GitLab evidence-gate delivery ([#93](https://github.com/LeXwDeX/SpecGit/issues/93)–[#100](https://github.com/LeXwDeX/SpecGit/issues/100)). No provider code — the
  only production change is a bounded diagnostic fix; everything else is
  committed evidence and version-qualified documentation.

  - Nested-group GitLab origins (`group/subgroup/project`, depth ≥ 2) on a
    declared host or a `*gitlab*` host now report `gitlab_unsupported` with
    platform-neutral fix text instead of `origin_unresolvable` with
    GitHub-pointing advice ([#95](https://github.com/LeXwDeX/SpecGit/issues/95)). GitHub parsing, suffix-spoof hardening, and
    the explicit-port fail-closed rejection are unchanged.
  - New committed evidence ledger `docs/evidence/gitlab-19.2.md`: every GitLab/
    glab behavioral claim pinned to an official anchor (docs.gitlab.com,
    gitlab-org/gitlab @ `v19.2.4-ee`, gitlab-org/cli @ `v1.113.0`) with CE
    applicability, confidence, and status; the unprobed CI-job-token live cell
    is recorded as BLOCKED-live-cell, never invented ([#94](https://github.com/LeXwDeX/SpecGit/issues/94), [#96](https://github.com/LeXwDeX/SpecGit/issues/96), [#97](https://github.com/LeXwDeX/SpecGit/issues/97), [#99](https://github.com/LeXwDeX/SpecGit/issues/99)).
  - `docs/gitlab-support.md` rewritten version-qualified: self-managed support
    exactly `>= 19.2.4 < 19.3.0` CE/Free (fail-closed outside; GitLab.com by
    capability probing), the `-ee` channel-marker comparison rule, glab floor
    1.113.0, planned `SPECGIT_GLAB`/`SPECGIT_GLAB_TIMEOUT_MS`, the full
    12-method provider map including `getOpenIssueNumbers`, and the Phase-2
    selection rule — only a `providers.yaml` declaration grants GitLab;
    `classifyPlatform` never grants capability ([#100](https://github.com/LeXwDeX/SpecGit/issues/100)).
  - `docs/reference.md` (`gitlab.insecure_ssl` per-host semantics, nested-group
    classification) and `docs/troubleshooting.md` (`gitlab_unsupported`)
    version-qualified against the ledger.
  - Redacted GitLab 19.2.4 CE API payload fixtures committed under
    `test/specgit-e2e/fixtures/gitlab/` (data only; two-pass redaction, no
    tokens, no PII) for the future adapter's contract tests ([#96](https://github.com/LeXwDeX/SpecGit/issues/96)).

## 1.0.0-rc.0

### Major Changes

- # Public Launch v1.0 ([#73](https://github.com/LeXwDeX/SpecGit/issues/73))

  Promote SpecGit to 1.0.0: the ten-command surface with `setup` public and
  `bind`/`unbind`/`accept` as automation aliases, the exit-code contract,
  `--json` single-document envelope, and fail-closed acceptance evaluator are
  declared stable. The 0.x line closes with 0.7.2; every blocking launch issue
  ([#62](https://github.com/LeXwDeX/SpecGit/issues/62)–[#72](https://github.com/LeXwDeX/SpecGit/issues/72)) is merged and dispositioned, security alert queues are empty, and
  the release-candidate certification path ([#71](https://github.com/LeXwDeX/SpecGit/issues/71)) has exercised build, tarball
  shape, registry reachability, and provenance dry-runs without publishing.

### Minor Changes

- [#82](https://github.com/LeXwDeX/SpecGit/pull/82) [`92fc99a`](https://github.com/LeXwDeX/SpecGit/commit/92fc99a7a21fd89784e358d288cbfe1fcb189e6f) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - Establish the coherent public CLI and state contract ([#69](https://github.com/LeXwDeX/SpecGit/issues/69)).

  - The command registry is pinned at exactly ten commands with `setup` public and `bind`/`unbind`/`accept` presented as automation aliases in help; the registry is exported (`COMMAND_NAMES`) and contract-tested against help output and the generated agent surface.
  - `specgit --help` documents the `SPECGIT_GH` and `SPECGIT_GH_TIMEOUT_MS` seams and the full exit-code contract, including the Ctrl-C 130 interruption exception: 130 sits outside the JSON envelope — stdout stays empty (exactly zero documents even under `--json`) and `Interrupted.` goes to stderr. The behavior is centralized in `EXIT_INTERRUPTED` + `emitInterrupted` and pinned by tests.
  - `specgit status` failure exits now match the normative table: exit 3 when the policy is missing/invalid or git cannot be spawned (previously exit 0), while factual mismatches (branch, origin, completeness) remain reported-through-gates with exit 0.
  - Gate-count truth is fixed at eleven (including `sequence`): `GATE_ORDER` is exported, and the finish/accept docstrings and the generated `specgit-finish` skill name all eleven gates.
  - State is classified through a three-tier taxonomy exported from `src/cli/state-taxonomy.ts` (authoritative committed files, derived committed harness, local integration assets) and surfaced in `status --json` as `assets`.
  - The managed AGENTS.md block generated by `init` now covers the whole ten-command surface.

- [#81](https://github.com/LeXwDeX/SpecGit/pull/81) [`00bff6b`](https://github.com/LeXwDeX/SpecGit/commit/00bff6bf01997525c57513f8ee44127296e6c433) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - Make `specgit init` non-destructive and governance-preserving ([#62](https://github.com/LeXwDeX/SpecGit/issues/62)).

  - All validation — flag checks, `--gitlab-host` validation, `policy_exists`, and a root-writability preflight — now happens before any filesystem or remote mutation. A rejected init leaves the repository byte-identical.
  - The harness write is error-atomic: mid-sequence failures roll every target back to its pre-write bytes and modes.
  - Existing hooks are merged, never overwritten: `.opencode/hooks.json` user entries and unknown keys are preserved (unparseable files left untouched with a warning), and a user git `pre-push` hook keeps its content with the specgit guard appended inside managed markers. The git hook installs via `git rev-parse --git-path hooks`, so linked worktrees and `core.hooksPath` (husky/lefthook) are respected.
  - `--protect` is now read-modify-write: existing required checks, reviews (including dismissal rules), push restrictions, admin enforcement, and rule booleans are read and preserved, with `SpecGit Acceptance` the only addition. The warned-path fix guidance no longer prints a command that would clear reviews/restrictions.
  - Re-init contract change: `init` with an existing policy exits 2 having written and probed nothing; `--force` rebuilds the policy and refreshes the harness (managed-block drift repair now happens on `--force`).

- [#81](https://github.com/LeXwDeX/SpecGit/pull/81) [`00bff6b`](https://github.com/LeXwDeX/SpecGit/commit/00bff6bf01997525c57513f8ee44127296e6c433) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - Generate a portable acceptance harness for external repositories ([#63](https://github.com/LeXwDeX/SpecGit/issues/63)).

  - `specgit init` now selects the workflow template by repository: the SpecGit repository itself (root package name `specgit`) keeps the local-build template; every other (adopting) repository gets a portable template that installs the published CLI at the exact running version (`specgit@<version>`, no ranges), sets up only Node at the engine floor, parameterizes the adopting repo's remote default branch, and never assumes or invokes the adopting project's toolchain, lockfile, layout, or build. The `--json` envelope reports the choice as `harness.template`.
  - No-CI repositories: init's detection fallback now writes an empty `required_checks` list instead of the unsatisfiable aggregate name "All checks passed" (never a check-run name — it deadlocked the generated wait step and made the verdict impossible). The policy schema accepts the empty list as the no-CI policy; the SpecGit Acceptance job, enforced through branch protection, is the gate. This is a schema widening with rationale documented in `schemas/specgit/schema.yaml`.
  - An unresolvable remote default branch falls back to `main` with a `default_branch_unresolved` warning (same fallback the protection probe already uses).

- [#89](https://github.com/LeXwDeX/SpecGit/pull/89) [`ec2dd29`](https://github.com/LeXwDeX/SpecGit/commit/ec2dd291238199e1d9b18d497d5d2280d324f82e) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Deterministic draft PR scaffold

  `specgit issue` now opens the draft pull request with a deterministic
  scaffold body instead of a bare closing-keyword list: the `Closes #n`
  line for every bound issue comes first, followed by Why / What changed /
  Evidence / Checklist sections. The renderer is a pure function of the
  bound issues — the same binding always renders the identical body — and
  its placeholders are advisory: closing references remain the only body
  gate, and the section text adds no closing-shaped content of its own.

  The body is written exactly once, at draft creation. Resume and
  `specgit pr` repair bind or adopt the existing PR without touching its
  body, so user edits survive every re-run. The renderer reads none of the
  adopting repository's files: repositories keep full ownership of their
  own pull-request templates (`PULL_REQUEST_TEMPLATE.md` in `.github/`,
  the root, or `docs/`), which GitHub skips anyway when a body is passed
  explicitly.

### Patch Changes

- [#60](https://github.com/LeXwDeX/SpecGit/pull/60) [`22b5bbd`](https://github.com/LeXwDeX/SpecGit/commit/22b5bbd1759819ad48e5222064b080f5041b0222) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Attributed timeout diagnostics (`gh_timeout`)

  A `gh` call that exceeds its time budget (default 15 s) now fails with the
  dedicated `gh_timeout` code instead of the generic `gh_transport`, and the
  fix names the three likely causes in order — network reachability
  (`curl -sI https://api.github.com`), a GitHub incident (githubstatus.com),
  or a genuinely slow call — plus the knob: `SPECGIT_GH_TIMEOUT_MS`
  (milliseconds) raises the per-call budget for every `gh` invocation SpecGit
  spawns.

## 0.7.2

### Patch Changes

- [#56](https://github.com/LeXwDeX/SpecGit/pull/56) [`38d43ee`](https://github.com/LeXwDeX/SpecGit/commit/38d43ee9674ba47e354c89f055db2c83810b966d) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Harness template sync + retry hardening

  - The acceptance-workflow template source now matches the repository's own
    evolved `specgit-accept.yml` (workflow_dispatch trigger, WAIT_SHA fallback
    to `github.sha`, hosted-pool rationale): re-running `specgit init` no
    longer regresses these fixes. An anti-drift test locks the template to
    the repo file byte-for-byte.
  - The wait-for-sibling-checks script retries transient check-runs API
    failures (5xx, 429, network errors) with bounded exponential backoff
    (5 attempts, 2s→30s ladder) — a platform blip no longer fails the
    acceptance gate.

## 0.7.1

### Patch Changes

- [#51](https://github.com/LeXwDeX/SpecGit/pull/51) [`1e524f1`](https://github.com/LeXwDeX/SpecGit/commit/1e524f1aeadf3fd94d473ba8e379bbfa86ef930b) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Release idempotence decided by tag existence

  The release workflow treated a MERGED version PR as "already shipped" — but
  the `changeset-release/main` branch keeps the previous version's merged PR,
  so the next release was silently skipped. The check now decides by tag:
  `v<version>` already on the remote means shipped (exit 0); otherwise the
  version PR is created (or recreated after an older merge), regardless of
  the stale PR state.

- [#49](https://github.com/LeXwDeX/SpecGit/pull/49) [`197a757`](https://github.com/LeXwDeX/SpecGit/commit/197a757339ea0afda231a546e7b6b2b04353bb0b) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Review findings addressed

  - `specgit init` interactive prompts (platform select, protection confirm)
    render to stderr, keeping the `--json` stdout contract (exactly one JSON
    document) intact on interactive terminals.
  - `--gitlab-host` on a github.com origin is rejected (`gitlab_host_invalid`)
    instead of silently writing a nonsensical declaration.
  - The wiring evaluate wrapper no longer clobbers a caller-supplied
    `gitlabHost`; provider discovery only fills the gap.
  - Docs updated for the platform-mode model: `--gitlab-host` in the init flag
    table, the `platform` envelope section, and the `spec_git/providers.yaml`
    schema in the reference.
  - Acceptance workflow: `workflow_dispatch` runs now work (the sibling-wait
    SHA falls back to `github.sha`); the dead bootstrap step on the hosted job
    is removed; the CI bootstrap condition keys on the stable
    `matrix.label == 'self-hosted-linux'` instead of the runner machine name.
  - Tests pin the github.com-rejection branch and suffix-host spoof immunity.

## 0.7.0

### Minor Changes

- [#42](https://github.com/LeXwDeX/SpecGit/pull/42) [`6bb6033`](https://github.com/LeXwDeX/SpecGit/commit/6bb6033c44b6abf225e2c087744f37faec151ed2) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Platform-mode model for GitHub and GitLab

  Self-hosted GitLab origins (git.ycgame.com, git.corp.example, …) are no
  longer misclassified as generic `origin_unresolvable`:

  - `specgit init` resolves a platform mode: a `github.com` origin defaults
    to GitHub; any other origin asks on an interactive terminal (GitHub or
    GitLab) or is declared explicitly with `--gitlab-host <hostname>` (bare
    hostname, validated against the origin host).
  - The declaration persists in `spec_git/providers.yaml`
    (`gitlab.host`, `gitlab.insecure_ssl` for self-signed certificates) —
    committed to the repository, shared by the whole team.
  - `parseRepoRef`, the acceptance evaluator, `doctor`, and `status` all
    consult the declared host: matching origins report the dedicated
    `gitlab_unsupported` diagnostic (the glab-provider roadmap stays in
    docs/gitlab-support.md); everything else keeps `origin_unresolvable`.
  - Evidence providers remain the official CLIs only — `gh` for GitHub,
    `glab` for GitLab (once implemented); no third-party API clients.
  - The `--json` envelope gains a `platform` section
    (`{ mode: github | gitlab | undecided, gitlabHost? }`), and an undeclared
    non-github origin warns `platform_undecided`.

- [#34](https://github.com/LeXwDeX/SpecGit/pull/34) [`9f9e114`](https://github.com/LeXwDeX/SpecGit/commit/9f9e1148107b199d03dcbe7e3861dc0507d53eb2) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Prompt-guided duplicate check before issue creation

  The managed prompt block injected by `specgit init` into `AGENTS.md` /
  `CLAUDE.md` now instructs agents to search the tracker for similar open
  issues before creating one (`gh issue list` / `gh search issues`), read
  every plausible candidate (`gh issue view`), compare the WHY, and let the
  requester decide between continuing the existing issue and creating a
  duplicate — one line of work per WHY, never two. Existing installations
  pick the guidance up on the next `specgit init`.

### Patch Changes

- [#40](https://github.com/LeXwDeX/SpecGit/pull/40) [`8358d76`](https://github.com/LeXwDeX/SpecGit/commit/8358d767149c5ed7580633fb32c85abb1c814639) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### init detection hardening

  - Job names containing matrix placeholders (e.g.
    `Unit Tests (${{ matrix.settings.name }})`) never appear in real
    check-runs; detection now falls back to the stable job id instead of
    writing an unmatchable name into `spec_git/policy.yaml`.
  - `workflow_dispatch`-only workflows never run on a PR head, so their jobs
    are excluded from detection (a workflow counts when any trigger other
    than `workflow_dispatch` is present; YAML 1.1's boolean-`true` parsing of
    the `on` key is handled).
  - Release workflow: when the bot cannot create the version PR, the
    fallback edit only reuses a PR that is still open — a closed one is now
    a hard error instead of silently masking the failure.

## 0.6.0

### Minor Changes

- [#37](https://github.com/LeXwDeX/SpecGit/pull/37) [`a0ecb70`](https://github.com/LeXwDeX/SpecGit/commit/a0ecb70031ce3ff4b8954cfc9811e21251a1d41d) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Ordered issue merging (`ordered_issues`)

  `spec_git/policy.yaml` gains an optional `ordered_issues: true` switch. When
  on, `specgit finish` enforces ascending merge order across deliveries: any
  open issue with a number smaller than this delivery's smallest bound issue
  rejects the verdict (`issue_out_of_order`, exit 1) naming the earlier open
  issues. The rule lives in the gate — every CI acceptance run and every local
  `finish` enforces it identically, so new agent sessions cannot merge out of
  order even by accident. Off (the default), nothing changes and no extra
  provider call is made.

## 0.5.0

### Minor Changes

- [#20](https://github.com/LeXwDeX/SpecGit/pull/20) [`07f749e`](https://github.com/LeXwDeX/SpecGit/commit/07f749e35f749d8201f2180cc38611a6bdddd43e) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Strict issue input spec for `specgit issue`

  - Issue titles must match `<type>: <english title>`; the type is validated
    against a fixed 14-entry whitelist (`feat`, `fix`, `refactor`, `perf`,
    `docs`, `test`, `chore`, `style`, `build`, `ci`, `revert`, `security`,
    `deprecate`, `dogfood`), and the title body must be printable ASCII.
    Missing/unknown types and non-English titles are usage errors (exit 2)
    that list the valid types; every title is validated before any issue is
    created.
  - Created issue bodies follow a required/optional section template
    (`## Why (required)`, `## Scope (optional)`, `## Acceptance (required)`).

  ### Acceptance-bypass guard at `specgit init`

  - After writing the policy and harness, `init` probes the default branch:
    when the `SpecGit Acceptance` check is not a required status check there,
    it warns that the acceptance gate can be bypassed, asks for confirmation
    on an interactive terminal, and (when confirmed, or with `--protect`)
    enables branch protection and repository auto-merge. `--no-protect` skips
    the probe. Provider or permission failures never fail `init`
    (fail-open); the `--json` envelope gains a `protection` section.

  ### GitLab origins recognized with a dedicated diagnostic

  - `gitlab.com` and self-hosted `*gitlab*` origins now fail with
    `gitlab_unsupported` (instead of the generic `origin_unresolvable`),
    naming the actual gap and pointing at the published GitLab/glab support
    roadmap (`docs/gitlab-support.md`). `specgit doctor` surfaces the same
    code on its `origin` probe.

## 0.4.0

### Minor Changes

- [#18](https://github.com/LeXwDeX/SpecGit/pull/18) [`1432789`](https://github.com/LeXwDeX/SpecGit/commit/1432789fc52cf4b5aaa4044c31755cffe7523bdb) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Init detection: platforms, GitLab CI, --force, --no-detect

  - `specgit init` now reports a `detected` JSON section: platform classified from the origin URL (github / gitlab / unknown, no network), the CI files the checks came from, and gh/glab presence on PATH (reported only)
  - Required-check discovery extends to `.gitlab-ci.yml` top-level job keys (reserved keys excluded) when no GitHub workflows exist
  - `--force` rebuilds `spec_git/policy.yaml` even when it exists (default stays the `policy_exists` usage error)
  - `--no-detect` keeps the strict legacy path: without explicit `--required-check` it exits 2 instead of detecting

## 0.3.0

### Minor Changes

- [#17](https://github.com/LeXwDeX/SpecGit/pull/17) [`c1649da`](https://github.com/LeXwDeX/SpecGit/commit/c1649da4f4feb372da72e05ea0fbbce8799dfbda) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Merged-delivery lifecycle

  - `specgit finish` on a merged delivery's record (e.g. on main after the PR merged) now returns **accepted** with a `record_of_merged_delivery` warning suggesting `specgit unbind --yes` — previously it mis-reported `branch_mismatch`. The merge is verified against PR evidence; a provider failure keeps the fail-closed mismatch.
  - `specgit issue` replaces a merged-delivery record automatically instead of failing with `issue_resume_drift` until a manual unbind — the merge is verified the same fail-closed way.

## 0.2.0

### Minor Changes

- [#11](https://github.com/LeXwDeX/SpecGit/pull/11) [`d290d0b`](https://github.com/LeXwDeX/SpecGit/commit/d290d0b0f96e633999a94ad26ad8acda86126213) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Automated npm releases

  Merging a PR to `main` with pending changesets now publishes automatically: the Release workflow consumes the changesets, bumps the version, builds, publishes to npm (automation token in the `NPM` environment), pushes the `v<version>` tag, and creates the GitHub Release. Direct pushes to `main` remain blocked by the pre-push guard, so every release traces to a merged PR. The beta-dispatch and GitHub-App/OIDC machinery from the inherited workflow is removed.

- [`48a1a00`](https://github.com/LeXwDeX/SpecGit/commit/48a1a00e77aa06384090abcdcf8c7b65076a9e63) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### SpecGit 0.1.0 — the strict delivery harness

  The delivery story becomes physical: one command to start, one to finish, and a CI gate that makes the verdict the only path to merge.

  - **`specgit issue <title-or-number>...`** — one-command bootstrap: creates or reuses N issues (one issue = one independently verifiable WHY), branches, opens the draft pull request that closes every bound issue, writes `.specgit.yaml`, and pushes. Re-running resumes; it is idempotent.
  - **`specgit finish`** — the evidence verdict (pure delegation to the acceptance evaluator; `accept` remains as a machine alias). Exit 0 is the only "done".
  - **`specgit pr`** — repairs the pull-request binding: auto-discovers the PR by head branch, errors with a fix when none is found, refuses with a list when several match.
  - **`specgit init` generates the harness**: `.github/workflows/specgit-accept.yml` (job _SpecGit Acceptance_ runs the verdict on every PR, waits for sibling required checks by name, and stays out of `policy.required_checks` to avoid self-deadlock) plus a managed prompt block injected between exact markers in AGENTS.md (created when missing) and CLAUDE.md (only when present). Re-init overwrites the block only.
  - **Agent surface simplified**: `skills/` and `.opencode/command/` are removed — the AGENTS.md block plus `docs/agent-contract.md` are the behavior source. `bind`/`unbind`/`accept` remain as machine aliases.
  - Dogfooded: the acceptance gate ran on its own delivery PR and caught four real harness defects (truncated action SHA, detached-HEAD checkout, empty check-runs race, status-vs-conclusion vocabulary) before release.

## 0.1.0

### Minor Changes

- **`specgit issue <title-or-number>...`** — one-command bootstrap: creates or reuses N issues (one issue = one independently verifiable WHY), branches, opens the draft pull request that closes every bound issue, writes `.specgit.yaml`, and pushes. Re-running resumes; it is idempotent.
- **`specgit finish`** — the evidence verdict (pure delegation to the acceptance evaluator; `accept` remains as a machine alias). Exit 0 is the only "done".
- **`specgit pr`** — repairs the pull-request binding: auto-discovers the PR by head branch, errors with a fix when none is found, refuses with a list when several match.
- **`specgit init` generates the harness**: `.github/workflows/specgit-accept.yml` (job _SpecGit Acceptance_ runs the verdict on every PR, waits for sibling required checks by name, stays out of `policy.required_checks` to avoid self-deadlock) plus a managed prompt block injected between exact markers in AGENTS.md (created when missing) and CLAUDE.md (only when present). Re-init overwrites the block only.
- **Agent surface simplified**: `skills/` and `.opencode/command/` removed — the AGENTS.md block plus `docs/agent-contract.md` are the behavior source. `bind`/`unbind`/`accept` remain as machine aliases.
- Dogfooded: the acceptance gate ran on its own delivery PR and caught four real harness defects before release.

## 0.0.1

### Initial release

SpecGit is a delivery binding and acceptance harness. This is the first
release of a new product; it replaces OpenSpec with no compatibility or
migration path.

- **Product identity.** Package `specgit`, CLI `specgit`, project data root
  `spec_git/`, delivery record `.specgit.yaml`. Canonical repository:
  https://github.com/LeXwDeX/SpecGit.
- **Delivery model.** A change binds one git branch or one git worktree to
  `issues[]` and one pull request; one PR may bind and close N issues.
- **Evidence-derived acceptance.** `specgit accept` derives its verdict
  fail-closed from real git, PR, and check evidence through mockable provider
  adapters (`git` locally, `gh` as the GitHub seam; `SPECGIT_GH` overrides the
  gh command). Spec artifacts, task files, or any other file contents can
  never change acceptance. Exit contract: 0 accepted · 1 rejected · 2 usage ·
  3 fail-closed unknown.
- **Command surface.** `specgit init` (write `spec_git/policy.yaml`), `bind`,
  `unbind`, `status`, `accept`, `doctor`. Non-interactive; exactly one JSON
  document on stdout with `--json`.
- **Agent surface.** Skills (`specgit-setup-policy`, `specgit-bind-delivery`,
  `specgit-accept-delivery`), the agent contract (`docs/agent-contract.md`),
  and the workflow guide (`docs/workflow-guide.md`).

History note: this project superseded
[Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec); its changelog
applies to the retired product and is not reproduced here.
