# Full project audit — 2026-09-04

This audit covers SpecGit's product behavior, architecture and implementation
at baseline `2e339f1489ed74ff3edb0746967432c9b928dacd` (v1.11.0), with fixes
tracked by [#387](https://github.com/LeXwDeX/SpecGit/issues/387) and
[PR #388](https://github.com/LeXwDeX/SpecGit/pull/388). The disposition follows
the requested priority: repair product defects and code bugs in this delivery;
record architecture improvements for later when no functional failure is proven.

There are **24 independently tracked corrections, #389–#411 and #416**. Some cover
several reproductions of the same invariant failure. This is an implementation
and verification record, not an acceptance verdict. The integrated current-head
CI, final review and `specgit finish` verdict must be recorded before claiming
acceptance. Merge and release are separate actions and are not enabled or
authorized in this delivery.

## Scope and method

The audit followed user-facing workflows through their evidence sources:
fresh adoption, configuration, setup, new and reused issues, partial and full
resume, PR repair, status, unbind, local and CI acceptance, automatic merge,
and interrupted release recovery. Architecture review separated module-boundary
concerns from failures that can be reproduced through a public command or port.

| Scope | Inspected responsibilities | Evidence method |
| --- | --- | --- |
| `src/cli/` lifecycle | Command composition, issue bootstrap, binding, resume, repair/merge, status, unbind, reference parsing, links, output and interruption | Graph discovery and call traces; exact source fallback; command regressions and observable mutation checks |
| `src/cli/` init/setup | Platform/check detection, project configuration, workflow generation, managed blocks, hook merging, ignore regions, snapshots, setup selection and asset inspection | Source and generated-content review; actual shell/git and isolated npm reproductions; rollback and mutation tests |
| `src/acceptance/`, `src/kernel/`, `src/record/`, `src/gitfacts/` | All eleven gates, evidence classification, strict policy/record parsing, root/worktree facts and merged lineage | Graph relationships, exact source; real git path cases; acceptance regressions and mutation checks |
| `src/providers/`, `src/github/`, `src/automation/` | GitHub/GitLab transport, auth routing, pagination, same-head checks, closing references, merge eligibility, protection updates and labels | Both adapter paths and shared helpers; primary API documentation; mocked CLI contracts and scoped regression suites |
| `scripts/`, `.github/workflows/`, build/package configuration | Version PR automation, publication/tag/release ordering, trusted source refs, packaging, generated distribution assets and required checks | Script/workflow source, release-state fault injection, workflow structural tests and read-only registry/tag comparison |
| `README.md`, CLI/reference/provider/baseline/release/issue-tracker documentation, `schemas/specgit/` | Current product contract, CLI reference, provider compatibility, issue tracker vocabulary, release and schema guidance | Cross-check against implementation and corrected reproductions; historical evidence kept distinct from current guidance |

The codebase graph was confirmed against this repository with full generation
`2026-09-04T05:17:07Z`. Coverage recorded no parser-partial or skipped source
files and no recorded gaps in the relied baseline scopes. This is a best-effort
coverage signal, not proof that every defect has been found. Graph source
snippets were unavailable, so material claims used direct source reads after
structural discovery. Changed files subsequently reported `metadata_changed`
and new files were not yet tracked; those files were verified through source,
diffs and tests. Gitignored local state, dependencies and build output are
outside the graph; relevant generated/runtime paths were exercised separately.
Historical evidence archives were consulted for prior decisions, not replayed
as new live evidence.

## Required corrections

All rows are implemented in this delivery; final integrated delivery gates are
recorded separately below. References are to the live tracker so each WHY keeps
its own acceptance criteria.

| Issue | Reproduction and product impact | Correction and regression location |
| --- | --- | --- |
| [#389](https://github.com/LeXwDeX/SpecGit/issues/389) · I0/I3 | `status` with no record reports healthy unbound despite an invalid/missing policy or unavailable git. | Evaluate remaining local evidence before the healthy exception; unknown snapshots carry no asset claim. `test/specgit-cli/status.test.ts`. |
| [#390](https://github.com/LeXwDeX/SpecGit/issues/390) · I0 | TTY `unbind` can prompt although its public contract requires `--yes`, compromising predictable JSON/script behavior. | Require `--yes` regardless of terminal state. `test/specgit-cli/unbind.test.ts`. |
| [#391](https://github.com/LeXwDeX/SpecGit/issues/391) · I1/I2 | Binding another repository's issue URL strips its identity and binds the same local number. Zero or unsafe URL numbers also pass coercion. | Preserve URL owner/repository until same-origin verification; validate positive safe integers before record writes. `test/specgit-cli/bind.test.ts`. |
| [#392](https://github.com/LeXwDeX/SpecGit/issues/392) · release seam | npm publication succeeds but tag/release creation fails; retry skips metadata, or can associate it with an advanced checkout. | Independently reconcile publication and metadata. Anchor recovery to registry `gitHead`, verify any remote tag, and accept only explicit npm 404 as absence. `test/specgit/release-state.test.ts`, `release-gates.test.ts`. |
| [#393](https://github.com/LeXwDeX/SpecGit/issues/393) · forge seam | GitLab issue creation sends a GitHub-style `body` parameter, losing the scaffold description. | Send the GitLab `description` field. `test/specgit/glab-provider.test.ts`. |
| [#394](https://github.com/LeXwDeX/SpecGit/issues/394) · harness seam | Detection combines the wrong platform's CI, includes hidden GitLab templates, omits a real `pages` job, or arms unprovable dynamic/target-only workflow names. | Resolve platform first; detect only its visible and statically provable candidates; report ambiguity/excluded workflows. Reject declaring github.com as GitLab. `test/specgit-cli/init-audit.test.ts`. |
| [#395](https://github.com/LeXwDeX/SpecGit/issues/395) · harness seam | Fresh `init` creates `.opencode` guard files and causes `setup` to select OpenCode for a generic agent. | Require genuine OpenCode configuration/user entry-point evidence; generated guards alone do not select the tool. `test/specgit-cli/init-audit.test.ts`. |
| [#396](https://github.com/LeXwDeX/SpecGit/issues/396) · git facts/I2 | Trimming paths or splitting worktree records on newlines corrupts valid paths. A different worktree with the same basename masks the correct branch. | Preserve path bytes, use NUL-delimited worktree enumeration, and match label plus branch in both gate implementations. `test/specgit/gitfacts.test.ts`, `acceptance.test.ts`, `test/specgit-cli/issue.test.ts`. |
| [#397](https://github.com/LeXwDeX/SpecGit/issues/397) · git/forge seam | Invalid origin or PR URL diagnostics echo embedded credentials or query/fragment data. | Redact rejected URL details while preserving diagnostic identity and useful remediation. Only synthetic sentinel values were used. `test/specgit/origin.test.ts`, provider URL tests. |
| [#398](https://github.com/LeXwDeX/SpecGit/issues/398) · product guidance | A supported GitLab route tells the user that glab is unimplemented. | Replace retired roadmap advice with the actual declaration/authentication repair path. `test/specgit/origin.test.ts`. |
| [#399](https://github.com/LeXwDeX/SpecGit/issues/399) · forge seam | Generated browser links drop a self-managed HTTPS port and lead to the wrong endpoint. | Preserve non-default HTTPS authority; keep SSH transport ports out of web URLs. `test/specgit-cli/forge-links.test.ts`. |
| [#400](https://github.com/LeXwDeX/SpecGit/issues/400) · I0 | Ctrl-C during the delivery-name prompt is swallowed and becomes usage exit 2. | Propagate cancellation to the shared exit-130 handler, with `Interrupted.` on stderr and no JSON envelope. `test/specgit-cli/issue-interruption.test.ts`. |
| [#401](https://github.com/LeXwDeX/SpecGit/issues/401) · harness seam | External CLI installation resolves against an adopting project's manifest/workspace/scripts; the wait step resolves its YAML dependency from the project. | Install into `$RUNNER_TEMP/specgit-cli`, invoke its binary directly, and resolve wait dependencies from that installation. `test/specgit-cli/external-harness.test.ts`, packed external-repo e2e. |
| [#402](https://github.com/LeXwDeX/SpecGit/issues/402) · harness seam | A valid branch containing YAML punctuation changes the generated workflow's branch filter. | Quote the scalar with JSON-compatible YAML syntax. `test/specgit-cli/init-audit.test.ts`. |
| [#403](https://github.com/LeXwDeX/SpecGit/issues/403) · I5/harness seam | GitLab adoption tells users to carry the policy but leaves the ignored provider declaration out of the PR. | Include `providers.yaml` in the force-stage adoption command. `test/specgit-cli/init-audit.test.ts`. |
| [#404](https://github.com/LeXwDeX/SpecGit/issues/404) · harness seam | Hook merge corrupts a malformed collection or shares a user matcher; an appended pre-push guard is bypassed by early exit or receives exhausted stdin. | Preserve malformed data with warning, isolate the guard entry, run shell guard first with replayed refs, preserve user exit semantics, and refuse unsupported non-shell hooks before writes. `test/specgit-cli/managed-assets-audit.test.ts`. |
| [#405](https://github.com/LeXwDeX/SpecGit/issues/405) · I5/harness seam | Failed reconciliation restores symlink target bytes as a regular file or silently accepts a dangling target. | Snapshot/restore link identity and reject unreadable dangling links before mutation. `test/specgit-cli/managed-assets-audit.test.ts`. |
| [#406](https://github.com/LeXwDeX/SpecGit/issues/406) · forge seam | Adding the acceptance check drops App-bound checks, review bypass allowances or enabled creation/lock/fork-sync protection. | Preserve all supported mutable settings; send explicit check identities, including the API's any-App representation. `test/specgit/protection-merge.test.ts`. |
| [#407](https://github.com/LeXwDeX/SpecGit/issues/407) · product rules/I2/I3 | Project language and label conventions exist as agent advice but cannot be selected and enforced against live facts. | Add optional interactive/script configuration, deterministic title/label checks before creation and at G7/G9, and real adapter metadata with unknown fallback. `test/specgit/project-rules.test.ts`, `provider-metadata.test.ts`, CLI convention/configuration tests. |
| [#408](https://github.com/LeXwDeX/SpecGit/issues/408) · I1/I4 | A complete record silently accepts unrelated same-count title arguments as resume keys; partial resume can change a durable branch prefix when a remaining new issue has a different type. | Compare supplied titles with live bound-issue titles; mismatch is usage drift and missing title evidence is unknown. No-argument/numeric resume remains available after renaming and retains the recorded branch. `test/specgit-cli/issue.test.ts`, `test/specgit-e2e/issue.e2e.test.ts`. |
| [#409](https://github.com/LeXwDeX/SpecGit/issues/409) · I5/harness seam | An old standalone ignore marker paired with a later managed end marker consumes adjacent user rules. | Pair the end with its nearest valid start and preserve neighboring content. `test/specgit-cli/managed-assets-audit.test.ts`. |
| [#410](https://github.com/LeXwDeX/SpecGit/issues/410) · I0/I3 | On another branch, a failed merged-history provider probe becomes factual `branch_mismatch` exit 1. | Preserve evidence failures as unknown exit 3; only proven non-merged mismatch is rejected. `test/specgit/acceptance.test.ts`. |
| [#411](https://github.com/LeXwDeX/SpecGit/issues/411) · release seam | Manual release dispatch can execute publication from a feature or tag ref. | Require the canonical repository and `refs/heads/main` at the release-job boundary. `test/specgit/release-gates.test.ts`. |
| [#416](https://github.com/LeXwDeX/SpecGit/issues/416) · I1/I2/I3 | GitLab returns a valid-shaped issue or MR payload with a different IID; the adapter accepts it and complete evaluation can report exit 0 for the wrong entity. | Require the issue/MR response IID to equal the requested identifier; mismatches are `glab_transport` and evaluation exits 3. Matching responses retain their behavior. `test/specgit/glab-identity-audit.test.ts`. |

The new project rules are opt-in. English validation rejects Unicode Han
characters; Chinese validation requires at least one. `kind` label mode needs
exactly one catalog kind plus declared extras; `project` mode needs a nonempty
subset of the configured vocabulary. Both permit at most one member per scoped
axis. This is deterministic validation, not language-model judgment. Existing
policies without `validation` preserve their behavior. The full contract is in
[the CLI reference](../cli.md#project-title-and-label-rules).

## Architecture disposition

The existing separation between local git facts, authenticated forge CLI
adapters, evidence envelopes, record/policy schemas and the acceptance evaluator
supports the product's fail-closed model. The reproduced boundary failures above
are repaired. The following structural concerns have no additional proven
functional failure after those repairs and are **deferred**, as requested:

| Concern | Why defer | Condition for revisiting |
| --- | --- | --- |
| [#412](https://github.com/LeXwDeX/SpecGit/issues/412): `ForgeReadPort` includes delivery mutations; `ForgeProvider` requires all administration capabilities | The name and breadth burden alternate providers, but methods remain explicit and evidence-returning. A split changes library interfaces and test doubles. | An alternate provider or new capability needs independently composed read/write/admin interfaces. |
| [#413](https://github.com/LeXwDeX/SpecGit/issues/413): duplicate CLI and acceptance context gates | The duplicate basename/branch behavior was fixed in both places. Extraction would reduce drift but is not needed to close the reproduced case. | A further rule change needs parallel edits or another divergence is observed. |
| [#414](https://github.com/LeXwDeX/SpecGit/issues/414): multiple platform classifiers and long embedded generated programs | Current platform-selection, quoting, dependency and hook failures are covered by observable regressions. Moving code alone gives no new acceptance behavior. | A new platform mode or generated-runtime change makes a shared classifier/content module materially simpler. |
| [#415](https://github.com/LeXwDeX/SpecGit/issues/415): concentrated `issue.ts`, `runCliWith`/`runMain` overlap and unused bootstrap-step metadata | These increase navigation and maintenance cost; no separate externally visible failure was established. | A bounded interface change can remove duplicated decisions while retaining the existing command/exit contract. |

The open tracker was searched before creating separate refactor work:
`gh issue list --state open --limit 1000` returned 24 issues, #387 and #389–#411.
Every returned title/body was inspected; the only overlapping item, #387, was
also read individually. It owns this audit/disposition record, not those
refactor implementations. No duplicate open refactor issue was found. The
deferrals are now tracked independently in #412–#415 with their rationale and
revisit conditions. They are not bound to or closed by PR #388.

Deferral is not permission to leave a discovered product defect. A new
reproduction must become a separately verifiable issue under the same invariant
or seam and enter the repair loop.

## Verification checkpoint

Evidence gathered during implementation, before final integrated delivery gates:

- Provider/release/protection work: 175 tests in the first scoped adapter batch;
  178 tests in the GH provider/automation/port contract batch; 46 tests in the
  final four focused files. These batches overlap and are not added together.
  Seven targeted behavior reversions produced assertion failures, then the
  original fixes were restored. Typecheck-test and lint passed at that checkpoint.
- Init/setup/assets work: 11 focused suites, 264 tests passed; eight targeted
  reversions failed as expected, followed by 18 restored post-mutation checks.
  Both typechecks and owned-source lint passed. Tests include actual shell hook
  execution, symlink rollback, and offline isolated npm installation/wait behavior.
- Lifecycle work: a combined 150-test checkpoint passed with build and both
  typechecks. Separate rule preflight tests then passed (nine tests), with nine
  targeted reversions failing as expected. Earlier lifecycle/binding cases were
  also checked by targeted reversions; overlapping checkpoint totals are not a
  unique repository-test count. The renamed partial-resume branch case was also
  demonstrated red/green and by mutation; all seven issue e2e tests then passed.
- Acceptance/git/record work: the parent audit's 187-test checkpoint passed;
  ten regressions were demonstrated red before the fix and ten targeted
  reversions failed as expected. The final configuration integration remains
  subject to the integrated run below.
- Final source review (#416): four regressions failed before the identity fix,
  including full-evaluator acceptance over both mismatched issue and MR IIDs;
  one matching-payload control passed. All five tests passed after the fix.
  Independently removing either equality check caused assertion failures;
  all five passed again after restoration. This used actual adapter parsing
  with injected CLI responses, not a claim of a live GitLab server mismatch.
- Read-only live release evidence: npm `specgit@1.11.0` reports `gitHead`
  `2e339f1489ed74ff3edb0746967432c9b928dacd`, matching the existing v1.11.0
  tag. No actual release or protection mutation was used as a reproduction.

Primary API references used for adapter semantics:
[GitLab issue creation](https://docs.gitlab.com/api/issues/#create-an-issue)
and [GitHub branch protection update](https://docs.github.com/en/rest/branches/branch-protection#update-branch-protection).
The GitLab API uses `description`; GitHub exposes App identities and mutable
protection fields that a preservation update must carry explicitly.

The environment has a real authenticated self-managed GitLab mirror. This audit's
adapter regressions do not replace that environment with an assumed absence.
No new live GitLab delivery, real merge race, protection write or publication
was performed for these fault-injection checks. Those operational results must
be reported only after the corresponding authorized live actions.

## Final delivery evidence

The final local integration run passed after all 24 corrections and generated
asset regeneration. Review and remote acceptance are recorded on
[PR #388](https://github.com/LeXwDeX/SpecGit/pull/388), against its current head;
the report itself never supplies a verdict.

| Required evidence | Result |
| --- | --- |
| Build, source/test typechecks and lint | Passed after final source restoration and asset regeneration |
| Complete local test run | 89 files passed; 1825 tests passed, 1 skipped (1826 total), 65.77 seconds |
| Full two-axis review and disposition of every finding | See the Standards/Spec evidence in PR #388 |
| Current PR-head CI, including SpecGit Acceptance | See the current-head checks linked from PR #388 |
| `specgit finish` at the final delivery commit | See the explicit exit code and commit in PR #388 |
| Merge, release and GitLab mirror publication | Not enabled/authorized in this delivery; automation remains disabled. |

Local tests and this report do not replace `specgit finish` exit 0. Any final
claim must name its commit and machine/CI evidence.

## Provider and automation source inventory

The provider audit inspected each baseline file below, plus the newly added
`release-state.mjs` and its tests. Other scopes are identified in the scope table
and their regression paths above.

- `src/providers/cli-evidence-transport.ts`, `cli-spawn.ts`, `routing.ts`,
  `github/gh-cli.ts`, `github/protection-merge.ts`, `gitlab/glab-cli.ts`.
- `src/github/port.ts`, `check-runs.ts`, `closing-refs.ts`, `pr-scaffold.ts`,
  `gh-cli.ts`, `protection-merge.ts`; `src/automation/ci-eligibility.ts`.
- `scripts/build-skills.mjs`, `merge-version-pr.mjs`, `pack-version-check.mjs`,
  `update-flake.sh`, and new `release-state.mjs`.
- `.github/workflows/ci.yml`, `rc-verify.yml`, `release-prepare.yml`,
  `security.yml`, `specgit-accept.yml` and adjacent workflow/script guidance.
- `build.js`, `bin/specgit.js`, `package.json`, `pnpm-workspace.yaml`,
  TypeScript configurations, Nix package/flake configuration and packaging tests.
