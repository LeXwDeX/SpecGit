# SpecGit 2.0 feature acceptance matrix

> Historical F01–F48 baseline. The 2026-09-10 user simplification supersedes this
> matrix as an implementation target. Read each of the
> [48 explicit dispositions](specgit-2-rust-history.md) and the new
> [L01–L18 / C01–C12 acceptance requirements](specgit-2-rust-design.md).
> Preserve required behavior and evidence, but do not build the retired local
> finish/merge/promotion/programme engines merely to satisfy an old row.

Status: required acceptance plan, not executed results. This matrix covers the
[architecture](specgit-2.md), [harness contract](specgit-2-contract.md) and the
296 entries in the [history ledger](specgit-2-history.md). Each implementation
issue must link its relevant rows and supply evidence at its final revision.
The original task independently verifies the completed 2.0 result against these
features, including code review, smoke tests and applicable regression tests.

## Evidence and verdict rules

Use these methods in the matrix:

- **Code**: follow the actual installed entrypoint to the implementation and
  mutation/read paths; inspect configuration/persistence/error paths. Source
  presence alone does not prove behavior. Negative claims need bounded complete
  source/call coverage plus the relevant runtime cases.
- **Regression**: deterministic positive, rejection, missing-evidence and recovery
  cases through the public module/CLI interface, with independently specified
  provider fixtures. Avoid tests that merely mirror the implementation.
- **Smoke**: real compiled and installed executable, real local Git/filesystem/
  process behavior and recorded outputs. A development runner is insufficient
  for packaging, hooks or process claims.
- **Live**: actual supported forge/host/OS, authenticated through gh/glab, with
  identity/version and native readback. Mocks cannot replace required Live rows.

Each evidence record contains feature ID, document revision, implementation commit,
artifact/package identity, applicable platform/provider/host versions, command or
scenario, expected and actual result, exit/status, relevant run URL or sanitized
local artifact, and verdict. Keep private addresses/tokens/logs out of tracked
reports. Use `pass`, `fail`, `blocked`, or `not_applicable` with a precise reason;
`not_run` is unfinished, and waived/blocked evidence is not pass. Applicability
must follow the contract, not be invented after a failed test.

A passing feature requires all stated methods/scenarios applicable to the shipped
support matrix. A defect gets an ordinary explicitly bound repair issue, followed
by targeted regression and fresh current-head verification. Do not change the
requirement simply to obtain a green matrix. A proposed contract change needs an
explicitly reviewed document/issue amendment and its own evidence.

## Feature inventory

| ID | Feature / required behavior | Methods and decisive scenarios | Owner |
| --- | --- | --- | --- |
| F01 | One Rust runtime; thin npm launcher | Code + Smoke: installed command enters Rust, no TS product runtime or dynamic source compilation; wrapper forwards exact arguments | #509, #514 |
| F02 | Bounded process transport | Regression + Smoke: stdout/stderr/input limits, hanging child, cancellation/reap, descendant cleanup, spaces/Unicode/Windows environment | #509 |
| F03 | Stable JSON and exit meanings | Regression + Smoke: one stdout JSON document, stderr progress, invalid input 2, rejected assessment 1, missing evidence 3, accepted 0; hook mapping separate | #509 |
| F04 | Executable/subcommand probing | Regression + Smoke: selected git/gh/glab discovery/version/help, unsupported flags, changed executable invalidates cached compatibility; optional absent provider nonblocking | #509 |
| F05 | Real account/project API probing | Regression + Live: help succeeds but auth/network/API fails; exact project/IID; forbidden/rate-limit/not-found/malformed distinctions; setup project not_checked | #509, #511 |
| F06 | Read/write capability separation | Code + Regression: observer/hook/probe lacks mutation handle; recorded calls prove no issue-create/close/delete/merge on observation/errors | #509, #492 |
| F07 | Strict consolidated v2 declaration | Regression + Smoke: defaults, unknown/duplicate keys, invalid bounds/paths, v1 rejection, endpoint precedence and no partial writes | #511 |
| F08 | Native target/default inspection | Regression + Live on both forges: feature to default valid; dev/preview/custom non-default warning; changed native default and target mismatch re-read | #511 |
| F09 | Native settings configuration | Code + Live: authorized selected setting write/readback; denied/unknown settings honest; protection/default/unrelated settings unchanged | #511 |
| F10 | en/zh presentation | Regression + Smoke: builtin content/guidance/hooks match chosen language; JSON/codes/closing syntax stable; user prose preserved on refresh | #511, #512 |
| F11 | Title/body validation | Regression: every issue/request, missing vs invalid evidence, optional rules, required sections and placeholders, fenced content, first-write preflight | #512 |
| F12 | Label modes/vocabulary | Regression + Live: off/kind/project, scoped conflicts, existing pool, seed missing selected label, unknown name, GitLab color, partial write recovery | #512 |
| F13 | Template selection and precedence | Regression + Smoke: builtin/repository/inline and final body file, explicit candidate choice, reported source, unknown variable/nonrecursive substitution | #511, #512 |
| F14 | Native template interoperability | Code + Live: selected native Markdown template, inherited/ambiguous sources, unsupported issue forms reported, GitLab quick-action effects cannot exceed authorization | #511, #512 |
| F15 | Global setup outside Git | Smoke on supported OS: isolated user root install/update/uninstall, complete manifest/skills, no project or remote writes | #510 |
| F16 | Project harness generation | Regression + Smoke: declaration-derived AGENTS block, optional selected CLAUDE mirror, same version/language/rules; no hidden CI/merge-guard installation | #511 |
| F17 | Owned asset preservation | Regression + Smoke: foreign files/unknown JSON/outside-marker bytes preserved, symlink ancestor, concurrent edit, partial failure/rollback, damaged marker | #510, #511, #513 |
| F18 | Native issue creation/adoption | Regression + Live: duplicate WHY inspection, exact IDs, complete specs/labels, two issues, no same-title-only or wrong-repository adoption | #512 |
| F19 | Binding before code without dummy commits | Smoke: selected issues exist before tracked edit; no-diff pending_request; real push creates draft; no binding-only commit | #512 |
| F20 | Many issues associated with one PR/MR | Regression + Live on both forges: all refs/native associations read back, custom body and language, local locator disagreement, removed refs | #512 |
| F21 | Interrupted bootstrap/body concurrency | Regression + Live: lose response after issue/push/request writes, resume exact object, ambiguous candidates stop, concurrent edited body retained | #512 |
| F22 | Repository/worktree/fork identity | Regression + Smoke: linked worktrees, detached/dirty/existing branch, remote source project, unsupported fork writes, no ref overwrite | #509, #512 |
| F23 | Fresh-clone/branch-deletion recovery | Smoke + Live: adopt exact native request/issues without original local checkpoint; source deletion never erases associations or reopens issues | #512 |
| F24 | Offline local status | Regression + Smoke: no network child, healthy unbound vs invalid/stale locator, unknown remote facts explicit, pending subscriptions visible | #509, #512 |
| F25 | Read-only fresh finish | Code + Regression + Live: current issue/body/head/target/rules/checks; candidate cannot self-exempt; initial adoption explicit; no mutation | #512 |
| F26 | Native check/review generations | Regression + Live: complete pagination, duplicate names, retries/latest attempt, cancelled/neutral/pending/missing, snapshot changes, unknown protection | #509, #512 |
| F27 | No-CI and native scheduling | Regression + Live: proved no-CI vs failed empty query; metadata/product/mixed/deletions applicability; absent required check rejected | #473 |
| F28 | No repeated unchanged product CI | Code + Live: ready/body-only updates refresh assessment, do not by themselves restart unchanged business suite; changed actual inputs get necessary checks; record counts/time | #473 |
| F29 | Explicit protected native merge | Code + Live: draft/pending/blocked rejects; authorized native queue/auto-merge request reports queued; changed head refuses stale action; no bypass/direct fallback | #512 |
| F30 | Native-only issue closure | Code + Live on both forges: default-target multi-issue closure; non-default/disabled/unprovable settings yield merged_issues_open; no close endpoint in fallback | #511, #512 |
| F31 | Native-only source cleanup | Code + Live: configured native delete, disabled/protected/fork unsupported state; independently reported present/absent/unknown; no manual delete fallback | #511 |
| F32 | Bounded background observation | Regression + Smoke: hook returns while watcher runs, deadline/backoff/cancel, stalled subprocess, no daemon or generic job scheduling | #492 |
| F33 | Subscription/event identity | Regression + Smoke: duplicate sessions/two worktrees/head-target changes, stable event IDs, no cross-conversation delivery, stale lease PID reuse | #492 |
| F34 | Durable inbox/restart | Regression + Smoke: kill at persistence/delivery boundaries, fresh process re-reads before success, at-least-once dedupe, retention expiry reported | #492 |
| F35 | Claude hook framing and relevance | Regression + installed Smoke: bounded stdin, event-specific stdout/exit mapping, SessionStart/Pre/Post/Stop, irrelevant repo silent, recursion excluded | #510 |
| F36 | Actual host notification | Live: exact host import/event/context path, material state change, failure and completed; manifest/stdout alone never counted as delivered | #510, #492 |
| F37 | Wake-up versus next-turn fallback | Live: claimed idle wake tested separately; unsupported host retains and presents inbox next turn; no invented Codex capability or endless Stop loop | #510, #492 |
| F38 | Promotion association evidence | Regression + Live: two feature requests into intermediate then default; custom names; already closed, reverted/unpromoted/partial/duplicate/squash/cherry-pick limits explicit | #477 |
| F39 | Migration inventory and rollback | Code + Smoke: exact v1 declarations/assets/writers, owned/unprovable inventory, backups, apply/rollback, no unrelated CI/protection/private-fixture loss | #513 |
| F40 | Major-version authority and removed flags | Regression + Smoke: one active integration per project, v1 old draft preserved, obsolete closure/scope/reuse flags actionable, no silent reinterpretation | #513 |
| F41 | Real Windows performance and coverage | Smoke + CI: green same-workload baseline/candidate per-file/process timings, complete applicable test accounting, no timeout/skip trick | #474 |
| F42 | Public precompiled distribution | Smoke: credential-free public-registry install on target matrix, no Rust/private GitHub requirement, libc/architecture errors, disabled scripts where supported | #514 |
| F43 | Release integrity/recovery/privacy | Code + Regression + qualification Smoke: wrapper/binary versions/checksums, partial platform publish/tag/registry lag, no private paths/source; explicit authorized publication separately Live | #514 |
| F44 | Private-source publishing capability | Code + qualification evidence: actual configured OIDC path and private-repo provenance limitation; no fake provenance or source-visibility change | #514 |
| F45 | All shipped surfaces agree | Code + Smoke: help/schema/skills/generated guidance/README/reference/migration/install/release docs match actual 2.0 artifact; historical prose marked | #513 |
| F46 | No retired orchestration survives | Code + Regression: enumerate runtime/installed assets/remote owned workflows; no repair-creator, custom close/delete completion worker or cross-head receipt engine active | #513 |
| F47 | Historical regression disposition completeness | Review + Regression: all 296 history rows have evidence or explicit historical/retired reason; no old 1.x run substitutes for Rust behavior | #493 |
| F48 | Programme versus delivery/publication | Review + Live readback: every required implementation delivery merged/issues closed with feature evidence; one delivery/version/fixture cleanup never completes 2.0 | #493 |

## Mandatory journeys

Run these after component evidence passes, against the exact candidate artifact:

1. Clean install outside Git, then initialize an existing GitHub project with its
   native template, selected language and rules. Bind two complete specs before
   editing, push real work, create a draft, verify, ready, request authorized
   native merge, observe closure and cleanup, and receive the host result.
2. Repeat the applicable journey on GitLab, including selected missing-label
   creation and default-target behavior. Do not use GitHub success as GitLab proof.
3. Deliver into a non-default intermediate target. Confirm that original issues
   remain associated and any open state is reported without compensation; then
   verify the supported promotion association flow into the actual default.
4. Interrupt a watcher/bootstrap, change head/target or user body while stopped,
   resume from another process/worktree, and verify current identity, preserved
   edits and correctly scoped notification. Exercise timeout and failed auth.
5. Upgrade a representative v1 project with owned and foreign assets, preview and
   apply migration, verify no old writers remain active, then prove rollback.
6. Install the candidate through its actual npm packaging on Linux/macOS/Windows,
   invoke JSON/hooks/child cancellation, and execute the declared host smoke path.

## Independent final audit

The implementation task must leave a feature evidence report keyed F01–F48 and
history row references. It must not pre-mark unfinished cases as passed.
The original task then:

1. Confirms the design revision, exact final source/artifact, tracker state and
   current-head CI; inventories changes from the pre-rewrite base.
2. Traces each feature to actual code and identifies missing behavior, broadened
   authority, stale docs or unsupported claims. Reconciles every history row.
3. Runs the relevant installed smoke/regression scenarios and independently
   checks required real platform/host readbacks. Reuses current trustworthy test
   results where sufficient, repeating them only for a concrete gap or change.
4. Records findings by feature ID with severity, reproduction, expected/actual
   behavior and the repair issue. Verifies repairs and resulting current CI.
5. Reports feature acceptance, programme completion and publication separately.
   Missing live host/forge/Windows/distribution evidence keeps the associated
   feature and 2.0 acceptance unfinished. No permission or test result is invented.

This design/planning delivery can be complete while every implementation row is
still pending. Actual public publication is a separate action requiring explicit
release intent; the implementation task must report publication-only evidence as
pending authorization rather than manufacturing it.
