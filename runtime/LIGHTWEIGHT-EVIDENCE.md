# Lightweight Rust implementation evidence

2026-09-10 snapshot. **Implementation is in progress; this is not a product
completion, merge or release certificate.** `pass` below applies only to the named
run/scenario. Missing real-platform evidence stays `not_run` or `blocked`.

## Identity and evidence boundaries

| Item | Recorded identity |
| --- | --- |
| Delivery | Existing draft [PR #525](https://github.com/LeXwDeX/SpecGit/pull/525), `feat/512-rust-native-delivery`; existing Issue history and closing references retained. |
| Source baseline | `3eb47278459db71a5d29ddd1b25ee1bfa15ca23c`. Implementation commit: `b552ece095eefb457d44fca1e2d2bbf35b01c76c`. Later evidence-only commits do not change runtime source. |
| Initial design anchor | `a0d9191575dfcf0c941186d6efcb6b9e45bc6b34`, [PR #538](https://github.com/LeXwDeX/SpecGit/pull/538). |
| Reviewed design revision | `1a1ca102952ca6537340555b302e20ac34f4c3d3`: [design](https://github.com/LeXwDeX/SpecGit/blob/1a1ca102952ca6537340555b302e20ac34f4c3d3/docs/design/specgit-2-rust-design.md), [handoff](https://github.com/LeXwDeX/SpecGit/blob/1a1ca102952ca6537340555b302e20ac34f4c3d3/docs/design/specgit-2-rust-handoff.md). CLI suggestions are optional references; implemented choices are tested on their actual surface. |
| Local environment | macOS 27.0 / Darwin arm64; rustc 1.97.0, Cargo 1.97.0; Node v26.8.1. This is not Windows or Linux execution evidence. |
| Installation baseline A | `specgit-darwin-arm64`, `2.0.0-dev.0`; binary SHA-256 `263957825f66ac0af06d5723a296dfeec19527c75c0e6c6edae7be7f4108d45d`. |

The early runs below are retained as baselines. E07 records the final installed
source qualification separately; no earlier binary is silently assigned to the
implementation commit.

## Recorded runs

| ID | Result and exact scope | Evidence / limitation |
| --- | --- | --- |
| E01 | `pass`: `cargo test --manifest-path runtime/Cargo.toml --locked --features test-fixtures`, 152 passed, 1 ignored. | Parent task's completed local command output. Suite counts: assets 8, cli 7, cli_contract 11, config 4, fixture_snapshots 2, guidance 4, hooks 6, init 11, issue 6, migrate 16, native_file 2, native_status 12, observation 6, pr 9, probe 4, process 6, project 3, retired_commands 1, setup 8, spec 7, templates 5, watch 14. This is an earlier uncommitted snapshot, not a final current-head claim. |
| E02 | `pass`: targeted config/guidance/init 4+4+11 and setup 8. | `cargo test --manifest-path runtime/Cargo.toml --features test-fixtures --test config --test guidance --test init`; then `--test setup`. These overlap E01; do not add them to a unique-test total. |
| E03 | `pass`, earlier installed baseline A. | Local `installed.json` at `/private/tmp/specgit-c12-install-20260910-a/installed.json`, independently read and binary digest checked. Records offline npm install with scripts disabled, integrity/allowlist, npm shim, help/version, explicit JSON file/stdin, malformed/duplicate/unknown input, byte/deadline bounds, hook framing, no Git/Rust/credentials, and launcher SIGTERM exit 130. |
| E04 | `pass` for the bounded fixture boundary. | [retired_commands](tests/retired_commands.rs), [native_status](tests/native_status.rs), [observation](tests/observation.rs), [watch](tests/watch.rs); E01 executed them. Retired commands fail before remote access; native failed/pending/merged states are observations, not merge permission. |
| E05 | `pass`: documentation metadata. | `node scripts/ci-metadata-check.mjs`: 6 files, 132 passed / 44 scope skips. This validates documentation/metadata only. Source diff whitespace checks also passed at review time. |
| E06 | `pass`: final `cargo clippy --manifest-path runtime/Cargo.toml --locked --all-targets --features test-fixtures -- -D warnings`. | Current implementation source, no warnings. Also passes `cargo fmt --check` and diff whitespace checks. |
| E07 | Final committed-source artifact: `afbe7cc5c0050a2573fcb59e97efd3b1ff2f080ee031e730b5f1c4dacfbe3e2b`. | Built from implementation commit above with path remapping. Offline installation D and machine/effects checks passed at `/private/tmp/specgit-c12-install-20260910-d/installed.json` and `effects-preflight.json`. The complete installed profile is recorded at the sibling `profile/profile.json`; its final result is reported separately. C had 155 passed, 1 ignored in 25 processes (89.254s), but its pre-format digest differed, so C is not relabeled as D. |
| E08 | `pass`: installed C read-only GitHub PR #525 observation. | 13 Issues, 18 native checks, `open`, `auto_merge=not_registered`, exit 0 with `inspect_native_failure` advice. This is readback of the existing older remote head, not current-head CI or live write qualification. |

E03's packaged discovery contract predates the final side-effect metadata.
Its successful schema/help checks establish only that artifact's consistency.
It does not qualify current source, other targets, a real forge lifecycle, actual
host notification, public npm availability or publication authentication.
The one ignored E01 test is
`real_claude_host_consumes_async_observer_event_on_the_next_model_turn`;
it requires explicit real-host qualification and a loopback model fixture.

## L01–L18 disposition

Every row remains open for the listed missing evidence. Local fixture success and
external qualification are deliberately separate columns.

| ID | Current implementation / local evidence | Missing evidence and status |
| --- | --- | --- |
| L01 | One Rust library/binary with thin npm launcher; E03 exercises its installed argv, I/O and cancellation. | `pass`: committed-source macOS arm64 offline installation D (E07). `not_run`: Linux/Windows and other proposed architectures. |
| L02 | E01 process 6, project 3, native_file 2; E03 input deadline and installed launcher SIGTERM. Existing owned-process, path and permission mechanisms retained. | `not_run`: current Windows console, descendant recovery and full path/locale journeys; final three-OS runtime evidence. |
| L03 | E02 init 11/config 4: supported/unsupported/unknown reports, explicit manual choice, no native settings writes, no guessed default, dry-run without local state, language and target identity. | `not_run`: final installed GitHub/GitLab live capability readback. GitLab auto-merge remains `unknown` by design when metadata cannot prove support; manual fallback is explicit. |
| L04 | E01 assets 8, E02 guidance 4/setup 8/init 11: foreign content, later chmod, rollback, lock ownership, CRLF, symlink rejection and no-write previews. | `not_run`: final Windows execution and final installed/shared-worktree preservation matrix. No inference from cross-compilation. |
| L05 | E01 issue 6/spec 7/templates 5: independent labels/specs, duplicate preflight, exact adoption, template limits and explicit missing-label creation. | `not_run`: actual two-forge Issue creation/readback and different-WHY duplicate decisions on authorized test objects. |
| L06 | E01 pr 9: multiple references, no-diff/unpushed pending state, actual fixture Git push, body preservation, conflicting edits and project identity. | `not_run`: final installed two-Issue-to-one-request native journey on both forges. |
| L07 | E01 Issue/PR response-loss recovery and migration/selection scenarios retain exact intent and native identity. | `not_run`: complete live restart/new-clone/source-deleted adoption matrix; do not infer every L07 scenario from a suite count. |
| L08 | E04: current native check/status/MR pipeline facts, failed reads, partial/duplicate pages, stale head, missing-versus-null, merged-open and association discrepancies. | `not_run`: final live auth/rate/permission and lifecycle checks. GitHub latest check results and GitLab MR head pipeline are not a complete workflow/child-DAG assessment. |
| L09 | Core merge endpoints and control modules removed; E04 rejects retired commands before native access. Skill/guidance assign native registration to an already authorized Agent. | `not_run`: actual GitHub/GitLab native auto-merge registration, revocation and repair/re-observation journey. No authorization to merge SpecGit's draft is inferred. |
| L10 | E04 separates merge from known closed associated Issues; optional Agent closure defaults off. Subsequent next-action/watch wording implements the preference boundary. | Final focused watch regression passed (15 plus one ignored); `not_run`: actual multi-Issue closing and explicitly authorized supplementary closure/readback. Unknown association is not closure permission. |
| L11 | E01 watch 14: stable IDs, session receipts, supersession, timeout, cancellation, crash/restart, bounded retention, local edits and zero remote writes. | `not_run`: final installed cross-worktree/session live journey after the last changes; platform/host end-to-end recovery. |
| L12 | E01 hooks 6 and setup 8; E03 hook stdin/stdout. Registration remains `written_not_verified`. | `not_run`: current real-host import/event/context/message delivery. The real-Claude test was ignored. Immediate idle wake is `not_supported`; next-turn delivery and human reading are separate. |
| L13 | E01 cli 7/cli_contract 11; E02 bilingual guidance; E03 baseline discovery/input; E05 packaged-reference content review. | `pass`: final rebuilt installed schema/effects/REFERENCE comparison in D. Other target installations remain unqualified. |
| L14 | E01 migration 16/assets 8; local source removal inventory below. Old drafts, foreign assets, shared hooks and unknown writers are preserved/refused. | `not_run`: real project cutover; old remote writer quiescence must be proven before activation. No cleanup of retained worktrees is authorized. |
| L15 | Retained-behavior suite and retired-test disposition are explicit. Fixture timing is a local baseline, not a speed claim. | `not_run`: final SHA on user-owned Linux/macOS/Windows CI, installed journeys and Windows equal-workload/process profile. Dependency Review and binding blockers below remain. |
| L16 | E03 proves one offline macOS arm64 npm tarball installation, integrity and asset allowlist without credentials/toolchain. | E07 qualifies the final macOS arm64 binary and privacy/allowlist checks. `not_run`: every other proposed target's actual install and public registry availability. |
| L17 | Distribution documents separate staging/installation from publication and preserve exact artifact identity. | `blocked`: publication not authorized; self-hosted npm authentication path must be explicitly configured/verified at authorized release time. No source-visibility or hosted-runner fallback. |
| L18 | 318 unique history rows and 48 unique F rows verified; disposition counts and current engine/test removal are recorded below. Typed observation and concrete adapters are reviewable in this diff. | `not_run`: independent final four-layer review, retained-row-to-final-regression completion, final artifact/source linkage. Inventory completeness is not product correctness. |

Implemented CLI references are traceable without a separate conformity score:
C01–C05 use the common clap schema/JSON/input/error surface; C06 previews local
assets and Issue/PR mutations; C07 retains uncertain-write recovery; C08 retains
native IDs and bounded pagination; C09 uses existing process/watch bounds;
C10 shares typed use cases; C11 preserves existing authorization; C12 is installed
qualification. Final behavior/effects checks remain outstanding where noted.
No extra MCP server or general workflow framework was added for these choices.

## History and retired-test mapping

The immutable [318-row history](https://github.com/LeXwDeX/SpecGit/blob/a0d9191575dfcf0c941186d6efcb6b9e45bc6b34/docs/design/specgit-2-rust-history.md#3-全部-318-条-issue-的去向)
is the per-Issue source of truth; this file does not duplicate that table.
The 318 rows contain 139 retain, 85 adjust, 47 return-to-platform/Agent,
45 historical-only and 2 retire dispositions. IDs are unique. The same document's
[F01–F48 table](https://github.com/LeXwDeX/SpecGit/blob/a0d9191575dfcf0c941186d6efcb6b9e45bc6b34/docs/design/specgit-2-rust-history.md#2-旧-f01f48-的逐项处置)
contains each old item exactly once. These counts prove a complete disposition
inventory, not 318 implemented regressions.

| Former runtime/test responsibility | Current disposition and retained checks |
| --- | --- |
| `assessment.rs`, `native_requirements.rs`, old assessment tests | Local acceptance/required-check rules retired. Typed [observation](src/observation.rs) and [observation tests](tests/observation.rs) retain missing/invalid facts, native lifecycle and check identity; they do not calculate eligibility. F25/F26/F27 map to L08/L13. |
| `finish.rs` and old finish tests | Command removed. Relevant scenarios move to [native_status tests](tests/native_status.rs): current facts, failed reads, stale heads, partial pages, merge versus actual Issue state and association discrepancies. Candidate-approved required-check gating is retired, not silently considered tested. |
| `merge.rs`, `native_settings.rs` and old merge tests | Core writes/gates/recovery retired. [Retired-command tests](tests/retired_commands.rs) check no native access; init tests check explicit capability choices. Actual merge/settings work belongs to authorized native Agent/admin operations. F09/F29/F30 are not inherited as Rust controllers. |
| `promotion.rs` and old promotion tests | Dedicated range/postimage/promotion inference retired. Ordinary selected/native Issue associations remain under Issue/PR and observation tests. No substitute stage-closing engine; F38/F48 remain retired runtime responsibilities. |
| Actions job/suite ownership reconstruction and GitLab child/DAG expansion | Removed from [native_checks](src/native_checks.rs). Native latest pending result is not replaced by old Actions green; incomplete pages/duplicate objects remain unknown; MR head pipeline failure is shown without expanding child jobs. Missing pipeline identity differs from explicit null. This is a narrower observation contract, not equivalent DAG coverage. |

The removal inventory is the current `git diff` against the source baseline:
`src/lib.rs` no longer exports the six retired modules above; those six source
files and four controller test suites are deleted. The public rejection test,
new observation/status tests and generated installed schema replace their active
surface where applicable. The development mapping in
[RETIRED-TESTS.md](RETIRED-TESTS.md) was retained for each old finish,
merge and promotion scenario; no claim is made that deleted engine assertions
remain one-for-one product obligations.

Four-layer review state: architectural authority and protocol boundaries are
represented by the removal/adaptor diff; framework evidence is the bounded
process/assets/CLI tests; business-code evidence is the scoped init/Issue/PR/status
suites; product-business evidence still needs real two-forge, three-OS and host
journeys. The final independent review must inspect remaining dependency seams,
not infer purity or extensibility from filenames or test totals.

## External blockers and minimum next conditions

- **Dependency Review: blocked capability.** The parent task read the failing
  native job and identified missing repository capability. Historical failed job:
  [Dependency Review](https://github.com/LeXwDeX/SpecGit/actions/runs/34353247996/job/102471597948).
  Restore/prove the required native capability through an authorized owner action;
  do not remove or weaken the check. The old job is not a current-candidate result.
- **Existing binding conflict: blocked.** #473 remains associated with another
  open [PR #496](https://github.com/LeXwDeX/SpecGit/pull/496), so bootstrap for the
  candidate reported duplicate ownership. Preserve both histories and resolve
  the existing native/SpecGit association explicitly; do not create a duplicate
  WHY, force-push, close old work or silently drop its closing reference.
- **Final CI: pending separate run evidence.** All candidate CI runner routes are
  self-hosted. The observed default-branch Completion workflow listens only to
  `SpecGit Acceptance`, so dispatching `CI` directly does not enter that hosted
  chain. Commits carry `[skip ci]`; do not dispatch Acceptance or edit the PR body
  (its edited event would start Acceptance). The draft remains unmerged. Report
  exact final-head run/job results separately; do not infer them from routing.
- **Live product/host qualification: not_run.** Use explicitly authorized test
  objects for native creation/registration/closure, then collect request/Issue
  readback and the correct host session's actual delivery. Fixture output and
  an installed manifest do not satisfy this condition.
- **Publication: blocked by scope and capability.** No publication authorization
  is present. Retain user-owned runners and private source. Establish a supported,
  approved npm authentication path only when release is authorized; local staging
  and earlier publication history do not establish one.

Next ledger revision must identify the actual implementation commit, final
artifact digests, runner/run links, native test objects and host evidence. It must
preserve failed/unknown/not-run entries until their particular conditions change.
