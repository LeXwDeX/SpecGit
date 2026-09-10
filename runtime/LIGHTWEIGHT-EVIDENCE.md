# Lightweight Rust implementation evidence

2026-09-10 qualification snapshot. **The product is not yet merged or published.**
A passing scenario below qualifies its named source, artifact and environment.
The user has authorized completion through stable `2.0.0` publication; missing
platform capability and failed current-head checks remain release blockers.

## Source and installed artifact identities

| Item | Evidence |
| --- | --- |
| Delivery | Ready [PR #525](https://github.com/LeXwDeX/SpecGit/pull/525), `feat/512-rust-native-delivery`, with all 19 closing references retained. Superseded PRs #496, #519, #522, #529 and #538 were closed without merging or deleting their branches. |
| Qualified runtime source | `4af05321aad54b2651e20a3a6ce8a820fb1c8cbc`. Earlier baseline `b552ece0` is historical, not the final source. Later evidence-only commits are not silently assigned these artifact identities. |
| Design | Approved lightweight [design revision](https://github.com/LeXwDeX/SpecGit/blob/1a1ca102952ca6537340555b302e20ac34f4c3d3/docs/design/specgit-2-rust-design.md). Native platforms own checks, protection, merge and automatic closure. |
| macOS installed binary | `specgit-darwin-arm64@2.0.0`, SHA-256 `a59f9909013c5b2ad8d0e26f9590a53101b69127804ef9a298097f3167da7783`; staged from the source above with private path remapping. Offline installation, package integrity, discovery/input and launcher checks passed. |
| Installed regression profile | 26 executables, 179 passed, 0 failed, 1 host-specific test ignored; 74.460 seconds. `/private/tmp/specgit-v2-4af05321-profile-cjs/profile.json`. The first profile selected a nonexistent `.mjs` launcher and failed; it is retained separately and is not counted as product evidence. The passing profile uses the packaged `bin/specgit.cjs`. |
| Real host | The ignored test was separately run through actual Claude Code 2.1.241 and the installed binary above: 1 passed, 3.81 seconds. An isolated loopback model verified next-turn delivery. This does not establish idle wake or that a human read the event. |
| Recorded candidate CI | [CI 34467382351](https://github.com/LeXwDeX/SpecGit/actions/runs/34467382351). All three Rust platforms, Linux/macOS TypeScript, lint/types, metadata, Nix and RC checks passed at this snapshot; Windows TypeScript is still running. No all-green claim. |

The downloaded CI Linux/macOS artifacts record GitHub's synthetic merge commit
`61c9d1a63bafbaa3350c6779fe19310fe87a4b4a`, whose native parents are
`2bee54b635a6ef87f04d0b7a927bad527003310f` and current head `4af05321`.
Both installed profiles passed 179 tests in 26 executables, with one separately
qualified host test ignored. Tarball SHA-512 integrity, package source/version,
and binary/launcher SHA-256 were independently recomputed and matched their
installation/profile records. These merge-test artifacts are not the local
head artifact above or a final `main` release build.

Windows installed qualification from the same CI merge commit subsequently
passed 175 tests in 26 executables, with one host-specific test ignored, in
529.361 seconds. Its binary SHA-256 is
`e62ceee8179703038e7fbdf48a3ef8a8ee7fe7064b1b0194a71a210e44b2bd3c`.
The downloaded tarballs, source/version, installed profile and binary/launcher
digests were independently matched. The Windows console-interrupt test passed
through the actual installed npm entrypoint. The earlier intermittent observer
I/O failure did not recur in either source or installed full suites; its dedicated
diagnostic is still pending and no causal fix is claimed.

## Live native journeys

All mutations below concern isolated qualification branches and test objects.
They contain a nine-line `RESULT.md` change and no product code or workflows.
They do not merge the product delivery into `main`.

| Journey | Observed result and artifact |
| --- | --- |
| GitHub create and associate | Binary from `cee4e05b`, SHA-256 `e1574163d0bdbabacd34f7d3348aa0788ce264dacfc00ca3ad083a2ef815e005`, created Issues #539/#540 and [PR #541](https://github.com/LeXwDeX/SpecGit/pull/541). Similar Issues #493/#514 were reviewed as different WHYs; exact review digests allowed the new specs. |
| GitHub pending / recovery | Missing remote branch returned unknown with no effects; pushed branch without a diff returned `pending_request` with no effects. A fresh clone adopted both Issues and PR #541 using only local writes. Original body and user-authored line were preserved. |
| GitHub completion / receipts | Native merge into `codex/v2-native-gh-target-20260910` was read back. Two open Issues, then one open Issue, both remained `merged_issues_open`. Both sessions returned `completed` only after actual closure of both Issues. Acknowledging session A did not consume session B's event. |
| GitHub deleted-source recovery | Native source deletion was verified with `git ls-remote`. A new clone fetched `refs/pull/541/head` and recovered Issue/PR identities without recreating the remote branch or objects. |
| GitLab create and associate | Binary from `7a28df2da21111ca5c1ca18b55dd7c39a4ed1c08`, SHA-256 `a16554a9ebda5ace5198ce57f3ada0e3d0d383b08d44fee02beebb7f007db253`. Actual project `git.ycgame.com/suntao/specgit` (1309), Issues #6/#7/#8 and [MR !6](https://git.ycgame.com/suntao/specgit/-/merge_requests/6). Issue #8 and MR !6 were created successfully through the fixed installed binary. |
| GitLab pending / recovery | Pushed source without changes returned `pending_request` with no effects. New clone adopted Issues 6/7/8 and MR 6 using only local writes. Independent native readback confirmed the exact normalized body and all three closing references. |
| GitLab completion / receipts | MR !6 merged only into `codex/v2-native-gl-target-20260910` at head `5ba79514c2bcfd179a9937558b789464815a5f26`. Three open Issues and then two open Issues remained incomplete. Both sessions returned `completed` after all three Issues were closed. Session A acknowledgement left B's distinct receipt pending. |
| GitLab deleted-source recovery | Native source deletion was confirmed. A new clone fetched `refs/merge-requests/6/head`; Issue and MR adoption succeeded with only local writes. |

Raw native reports and command results are retained under
`/private/tmp/specgit-v2-live-gh-*` and `/private/tmp/specgit-v2-live-gl-*`.
The two live binaries predate only the later safe filesystem-error diagnostic
change. They are not relabeled as the current artifact or final release build.
Both isolated targets deliberately used explicit manual observation because they
were non-default branches. Native auto-merge registration/revocation was not
exercised by these journeys and is not claimed.

The current `4af05321` installed artifact subsequently reread both completed
native requests and refreshed each session B subscription. Both stayed
`completed` with the same pending event ID, confirming upgrade readback without
duplicate completion events. This replay made no native writes.

## Defects found by qualification

- GitHub duplicate discovery initially blocked every similar candidate without
  a way to proceed after comparing distinct WHYs. `cee4e05b` adds review digests
  bound to fresh full candidate/spec facts, with stale/new candidate and uncertain
  write recovery rejection tests. Review is not permission to duplicate an issue.
- GitLab rejected native raw-body writes with HTTP 415. `0ea01d73` declares
  `Content-Type: application/json` at the shared write transport. A fixture first
  reproduced the failure, then the installed binary reached the actual API.
- GitLab strips trailing ASCII whitespace and normalizes CRLF in descriptions.
  `7a28df2d` accepts only this observed submitted-to-native normalization.
  Native-to-native concurrent-edit checks remain exact; leading whitespace,
  Unicode whitespace and interior edits are not silently trimmed.
- Windows CI `34463500666` failed before the first observer poll with exit 3 and
  `owned_assets/io_failed`, not a slow poll. `4af05321` preserves operation,
  error kind and raw OS code without exposing paths or error strings. The root
  filesystem fault still needs the new Windows run; no timeout was raised.

## L01–L18 disposition

| ID | Evidence and remaining boundary |
| --- | --- |
| L01 | One Rust binary/library and thin npm launcher; current macOS installed full profile passes. Final main-source three-target release artifacts are pending. |
| L02 | Bounded process/input/cancellation fixtures and installed I/O checks pass. Windows source and installed suites pass; the earlier intermittent filesystem failure is still being diagnosed. |
| L03 | Both actual forges report native capabilities and accept explicit manual observation. Unsupported/non-default or unknown capability is not silently enabled. |
| L04 | Asset ownership, conflicts, rollback, permissions, CRLF and link fixtures pass locally; Windows installed asset fixtures now pass; the earlier intermittent observer failure remains under diagnosis. |
| L05 | Both real forges exercised new Issue creation, exact recovery and multiple specs. GitHub distinct-WHY review and GitLab JSON/normalization defects were repaired and replayed. |
| L06 | Actual two/three-Issue aggregation, no-diff pending, body preservation, native ready and MR/PR identities passed on both forges. |
| L07 | Both forges passed new-clone and deleted-source recovery. Lost-response uncertainty is covered by deterministic fixtures; an arbitrary network outage during a real write was not induced. |
| L08 | Actual open/merged/partially closed/completed states and native associations were read back. Auth/rate/malformed/page failures remain deterministic-fixture evidence. No workflow/DAG eligibility reconstruction is claimed. |
| L09 | Removed runtime merge controllers and retired-command rejection are tested. Native merge was exercised on both isolated targets. Auto-merge registration/revocation was not exercised. |
| L10 | Both forges verified partial Issue closure remains incomplete and actual full closure yields completion. Native Agent closure was confined to test Issues. |
| L11 | Both forges verified independent session/worktree events, receipt isolation and restart. Timing, process death and outbox limits are fixture evidence. Windows observer regression is still open. |
| L12 | Current installed binary passed actual Claude Code next-turn event delivery. Idle wake is unsupported; other host configuration is not claimed as verified runtime delivery. |
| L13 | Current installed schemas, JSON/input/effects and packaged reference checks pass. Final target packaging remains subject to release qualification. |
| L14 | Migration and preservation fixtures pass. Actual product-project cutover has not occurred; old Completion workflow stays disabled until `main` contains its self-hosted replacement. Existing worktrees are retained. |
| L15 | Current three-platform Rust CI passes; Windows TypeScript and final all-check acceptance remain outstanding. Test totals are not architecture or platform acceptance. |
| L16 | Current macOS package installation passes without lifecycle scripts. Final three-target release build and public registry download/install remain outstanding. |
| L17 | Stable publication is explicitly authorized. Required Dependency Review capability is unavailable; no product merge, tag, package publication or release has occurred. |
| L18 | Complete history/F-row disposition remains below. Typed read/write separation and protocol normalization are source reviewed; final release qualification cannot be declared while the Windows defect and native security check remain unresolved. |

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

The removal inventory is the `git diff` against source baseline
`3eb47278459db71a5d29ddd1b25ee1bfa15ca23c`:
`src/lib.rs` no longer exports the six retired modules above; those six source
files and four controller test suites are deleted. The public rejection test,
new observation/status tests and generated installed schema replace their active
surface where applicable. The development mapping in
[RETIRED-TESTS.md](RETIRED-TESTS.md) was retained for each old finish,
merge and promotion scenario; no claim is made that deleted engine assertions
remain one-for-one product obligations.

The four review areas have separate evidence: architecture uses typed native
read/write capabilities and removed controllers; framework uses bounded
process/assets/CLI tests; business code uses init/Issue/PR/status suites; product
behavior uses the actual two-forge and host journeys above. Windows and native
security capability remain explicit gaps. No test total is a claim of universal
correctness or proof that every dependency seam is defect-free.

## Release blockers

1. Resolve and verify the Windows owned-asset filesystem failure on the unchanged
   observer deadlines, then obtain final-head complete CI and installed
   profiles. A standalone passing diagnostic run cannot replace full CI.
2. Restore native Dependency Review capability. The private personal GitHub
   repository's check reports that Dependency Review is unsupported; native
   Audit passes. No required check is removed, bypassed or replaced by local tests.
   Available organization/subscription capability requires owner clarification.
3. Only after final acceptance: confirm the product merge and every bound Issue
   closure, restore the migrated self-hosted Completion workflow, run the
   three-target Release build on actual `main`, verify artifact digests and
   installed profiles, then publish and independently read back registry and
   GitHub Release results.
