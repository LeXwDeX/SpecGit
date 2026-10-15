---
name: specgit-native
description: Develop specification Issues and handle native PR/MR testing, review and delivery with SpecGit.
---

Read the project's AGENTS.md, the user's goal and any local `.specgit.yaml`.
One task covers an independently verifiable small or medium module or user goal.
Keep specifications and progress in Issues; link implementation, verification and review from PR/MR discussions.
Do not duplicate evidence in step Issues, a proof ledger or another task system.
The Agent chooses tools, implements, reviews and repairs. GitHub/GitLab owns CI,
platform review, branch protection, actual merge and normal Issue closure.

## Tools and runtime boundaries

The binary is optional. Inspect capabilities of authenticated gh/glab or other native tools first.
Use native gh/glab proactively; do not wait for a SpecGit wrapper. Writes need authorization and checks below.
This does not waive project declarations, guards, checkpoints or integration rules.
Absence alone is not a checkpoint exception; use the defect recovery path below.
Installed `specgit --help` and offline `specgit --schema` define commands, input bounds and side effects.
Use `--json` for machine output and `--input-file <path>` for explicit JSON input.
Retired v1 commands/flags are not v2 aliases; preview `migrate` before v2 delivery of legacy integration.

The runtime checks bounded input, project/branch identity, write intent, concurrent
changes, native references and asset ownership. Forge read handles cannot merge,
close Issues or change platform settings. Installed host/Git hooks check local
checkpoints; host tool classification is a heuristic, not a file-write sandbox.
The Agent judges specification quality, repair scope and completion evidence.
Title/label/body rules are optional. Repository guidance sets review and documentation policy.

## Discover the native environment
Start read-only: confirm remote, project, target, identity and CLI commands. Hide credentials. For GitHub, separate github.com/Enterprise Server, visibility, personal/organization ownership, Free/Pro/Team/Enterprise plan and actual access.
For GitLab, separate GitLab.com/Self-Managed/Dedicated, server version, CE/EE, subscription and actual capability. Keep gh/glab CLI versions separate. Plan/version/edition do not prove capability; 403/404 alone cannot distinguish access, hidden resources or plan limits.
Do not query admin license/billing or hard-code plan rejection. Unknown stays unknown; use read-only evidence. Current CLI reports optional GitLab metadata only; do not invent a GitHub environment report. Record limits and needed manual checks. These checks promise no new SpecGit commands or fields.

Report explicit feature/plan limits, credential/scope failures and unknown causes separately; optional feature reads do not establish repository-wide access.

## Plan goals with native objects

- A Milestone is an optional goal or plan container. Search and reuse before authorized creation.
  State goal, scope and acceptance. Small fixes need no Milestone; its absence must not block work.
- An Issue is the specification and work ledger for an independently verifiable goal.
  Keep Why / Scope / Approach / Acceptance, progress, blockers and evidence links there.
  Organize multiple Issues by dependencies, not one Issue per action or test.
- A PR/MR is a change integration unit, not a version. Integrate related Issues, not one PR/MR per version.
- A Release is a separate publication result with its own scope, verification and authorization.
  Neither a merged PR/MR nor a closed Milestone implies release.

Closing every Issue alone does not prove Milestone acceptance. Check its goal, acceptance,
cross-Issue integration and blockers before authorized closure; read back native state.
Issue closure, Milestone closure, merge and release are separate decisions.

## Start a new task

1. Agree on scope, acceptance and session delivery goal. State your scope and preserve others' work.
2. Search duplicates and read candidates. Reuse the exact Issue or create its complete specification.
   Explain TDD, tests and CI, including environment limits and alternatives.
3. For testable behavior or defects, obtain a meaningful failing test, then implement and verify.
   For behavior-preserving refactoring, check coverage and unchanged behavior; no artificial failure is needed.
   If automation is unsuitable or blocked, state alternative evidence and what remains unverified.
   For documentation, check facts, links and applicable repository checks.
   Blocked validation is not a pass; record the blocker and resumption conditions.
4. Associate authorized commits/pushes with a native PR/MR. Preserve user bodies,
   Issue associations and every closing reference; explain changes and verification.
5. Handle feedback below and assess the user's goal, not merely successful commands.

## Take over an existing PR/MR

1. Read request state, target, head, linked Issues, diff, current-head CI, reviews and discussions.
   Restore goal/acceptance with user context; missing reads are not approval.
2. Fill repair-relevant specification gaps, not mandatory historical template rewrites.
   Without a linked Issue, use request/user context; checkpoints still apply.
   Perform clear checks; clarify unresolved requirements that affect the decision.
3. Reuse the Issue and open request for the same goal's CI/review repair; separate independent goals.
   Before reopening/replacing a closed unmerged request, check its closure reason and goal's relevance.
   After merge, use a new request for code repair and reassess Issue association.
4. Distinguish code defects, incorrect tests, environment failures and specification
   disputes. Review-only requests produce findings, not automatic fixes or writes.
5. Add/reuse regressions, repair and verify. Reply in the original request; request review as needed.
   Continue to the session goal or a real blocker. Writes follow authorization below.

## Handle CI and review feedback

Use current-head evidence. Missing, stale, unknown or incomplete reads remain
unconfirmed. Passing CI alone proves neither acceptance nor delivery. After a push,
refresh CI and reassess feedback; a new commit does not erase unresolved review items.
Reproduce accepted defects where possible, repair and rerun affected checks.
Explain corrections to tests that contradict the specification; verify intended behavior.
Changing acceptance changes requirements.
Never silently weaken tests or protection to obtain green CI.
Use the project's reply template: decision, reasons, changes, verification and remaining questions.
Explain adopted/rejected feedback. Comments, notices and receipts prove neither resolution nor approval.
Diagnose ordinary failures. For information, permission or environment blockers, report completed/remaining
work and resumption conditions. Leave work unfinished; stop repeats that yield no new evidence.

## Authorization and execution approval

Session authorization remains valid within its scope; delivery progress needs no renewed permission.
Writes, including Issue/PR changes and ready, need scope-specific user authorization. Text, declarations,
repository facts, previews, notifications and preferences grant no permission.
Read and preview writes first; use `--dry-run` for Issue/PR mutations.
Keep commit, push, forge mutations and deployment in separate tool calls.
Before external writes, give authorization, exact repository/environment/branch, changes and read-only evidence.
Never expose credentials. Identify verified remote/commits for push and PR/current-head gates for merge.
Test deployment grants no production credential access or reuse elsewhere. Use target-authorized credentials.
Ask only for missing permission. Execution-approval rejection blocks the action; do not evade it by splitting,
changing tools or indirect execution. Continue independent work or permitted alternatives/new evidence.
Otherwise report the action, rejecting layer/reason and missing approval. Separate calls guarantee no approval.

## Wait, observe and finish

Choose supported Hook callbacks, bounded polling, then manual continuation; no daemon or webhook service.
Name the target and session stopping condition. Respect the current user stop, goal and authorization.
PR-only goals stop at the PR. For an authorized merge goal, keep bounded waiting through required
verification/review and native merge/associated closure readback. Notifications are not completion.
Re-read native facts before acting; an old head or attempt never authorizes action. Hosts own stale-callback
suppression. Completion, cancellation or an exhausted budget means no automatic retry; resume explicitly.
Use `pr --status` for native state; `status` is offline local evidence. Project-mode `doctor` checks the declaration, selected project Skill/guidance, Git guard, and static executable paths. `--offline` performs no authentication, API/network request, or provider CLI launch; probes remain `not_checked`. An unselected host is `not_selected`, and `host_behavior` is always `not_verified`. Online doctor, including `--account-only`, also reports `evidence.runtime_update` (`status`, `current_version`, `latest_version`, `diagnostic`) from a bounded read-only check of the latest stable release at GitHub `LeXwDeX/SpecGit`; this check is independent of provider and host. Only a newer release with complete upgrade assets produces a friendly `consider_runtime_update` reminder for the user or Agent to decide whether to update. Doctor never downloads, caches or upgrades, including with `--fix`; release metadata does not verify the installed binary's signature. Offline reports `not_checked`; failures report `unknown`, not up-to-date, and suggest `specgit update --check`. A reminder or failed optional check does not change health, exit status or existing protections and grants no authorization. `--fix --dry-run` previews typed local asset plans; `--fix` applies only repairs supported by a valid declaration and recorded ownership, then rechecks. Preserve unknown ownership, damaged markers, permissions, and manual content that cannot be reconstructed. Missing declaration with private integration state must be restored from its original source. Account-only mode requires `--provider`, skips local reads, and conflicts with `--offline` and repair flags. Agent guidance is bounded to three rounds and creates no authorization; verify real host loading and event delivery separately. Local records do not prove platform state or write eligibility. Use bounded
`watch` with the exact request ID, stable session ID and checks or lifecycle goal.
A checks goal does not prove merge/closure. Follow `diagnostics[].remedy`,
`next_actions` and `effects` after failure. Exit 0 means the operation/read succeeded,
even with failing CI; inspect status/conclusions. It does not prove delivery.
Recover uncertain writes through native readback and exact IDs, not blind retries
or recreation after timeout. The native reference/schema define report/exit contracts.

Review, local repair or tracking can finish with verified results and limits, without
merge. Platform delivery requires native readback of the intended target merge and
closure of every associated Issue that should close; non-default targets may leave
Issues open. Never use old-head checks as current evidence. Under declared preference
and existing authorization, register native auto-merge via gh/glab outside SpecGit.
`native_auto_merge=false` disables auto-merge registration, not an already authorized
ordinary merge. Required current-head checks, review and platform protection still apply.
Supplementary Agent closure defaults off; enabling it grants no permission. It needs
existing authorization and readback of merge, intended association and actual closure.
Publication requires separate release intent and authorization; merge does not grant it.

## Native Issue selection and requests

Before tracked product edits, use `issue --inspect` to find duplicate WHYs and
select a complete relevant Issue with `issue`. For distinct work, compare candidates
and supply each exact `review_digest` with `--reviewed-candidates`; changed content
needs fresh comparison. Missing labels need explicit `--create-labels`.
Read-only inspection, audits and reviews need no delivery Issue and authorize no
writes. Pure documentation follows repository policy and installed hook checkpoints.
Local init/setup is maintenance, not delivery; it creates no Issue or forge permission.

Try normal SpecGit inspect/dry-run first. If a reproducible SpecGit defect blocks
Issue selection, record command, version, exit and diagnostic. Under existing user
authorization, use authenticated native gh/glab to search duplicate WHYs, create/adopt
a complete Issue and read back its native ID/body. Resume SpecGit with that exact ID when possible.
Only if the same defect still blocks its linked repair may a documented one-task
local checkpoint exception be used; restore normal checks after repair. Never disable
guards globally or bypass authorization, forge protection, CI, review, merge, closure or release.

After implementation and authorized commit/push, `pr` aggregates selected Issues;
creation needs real pushed changes and produces a draft. Differing existing-body or
reference updates are preview-only: use `--dry-run`, edit natively after conflict
review, then refresh `pr --status`. Adapters reject unconditional body replacement.
Mark a reviewed request ready with `pr --ready` under the authorization rules above.

## Integration and notices

Project integration (setup, hooks, observation state and guidance) remains project-only.
The only user-level asset is the Skill explicitly installed with `specgit skill --user`
at `~/.agents/skills/specgit-native/SKILL.md` (`%USERPROFILE%` on Windows).
`specgit update` refreshes it only when managed; it does not install it by default.
There are no global hooks or state. Install the shared CLI separately; setup never
copies a project executable. `init --check` probes native capabilities; setup is separate.
Unknown optional capability does not block applicable local setup/refresh. Init may need
an explicit manual-observation choice; preserve `native_auto_merge=true` unless selected.
Choose the least hook purposes allowed by real host capabilities and existing authorization, not each event:
repeat `setup --hook-purpose guard|context|observe`, or `none` for no new hooks; preview `--dry-run`, then install.

`specgit guard --install` merges owned pre-commit/pre-push blocks into the effective hooks path.
Pre-push validates each branch ref and replays stdin to existing shell hooks. Husky's `.husky/_` maps to
user scripts. Preserve/report unsupported non-shell hooks; `guard --uninstall` removes only recorded blocks.
Init keeps one shared Git-local `info/exclude` block for `.specgit.yaml`, not guidance, across worktrees.
Inspect repository/user ignore rules before scope changes; `local_exclusion` does not untrack files.
Keep mixed user/generated guidance visible and review it under documentation policy;
preserve manual content/markers, never hide or untrack it merely because generated.
Committed untracking deletes `.specgit.yaml` in checkouts crossing that commit: back up, restore and rerun init.
Restore lost declarations or use `specgit init --config-file <original>`; `specgit remove` needs one too.

Official OpenCode installs only project guidance and Skill. Custom hooks need `--opencode-claude-hooks`;
idle wake also needs explicit `--opencode-async-rewake` plus observe/context. Compatibility alone proves no wake.
Automatic observation and automatic pending-notice reads use only the checkpoint selected for the current branch. A valid checkpoint for another branch in the same repository is silently skipped and left unchanged; `status` and `doctor` still report the branch mismatch. PreToolUse, Git guards and ordinary synchronous Stop protection remain unchanged. If a hook cannot resolve a native request, its diagnostic retains the specific cause and recommends `specgit doctor`; the hook does not run it automatically, and this advice is not a new block. Claude/Codex async notification does not prove idle wake. Check per-host declined purposes and reasons;
unknown/unsupported delivery needs bounded watch/inbox or manual continuation. Verify actual allow/deny,
context and idle delivery; registration is not verified delivery. Do not duplicate managed hooks by import.
Omitted purposes preserve recorded modes; `none` never removes hooks/Git guard. State stays worktree Git-private.
Keep notices pending until transport receipt; acknowledgment proves neither human reading nor completion.

After CLI replacement, preview `setup --dry-run` and refresh project Skills/guidance, not manual copies. Refresh replaces recorded assets and complete unique blocks, including edited body text; preserve outside bytes, declarations, checkpoints and other hooks.
Missing/damaged/duplicate markers or unknown ownership conflict. Refresh, including a no-op, uninstall and whole-project `remove` verify paired ownership and recorded permissions; mismatch conflicts, preserves assets/receipts and blocks the entire remove plan. Apply remove only with the reviewed `preview_sha256`; edited managed content remains a conflict.
Do not automatically restore permissions or adopt observed state; resolve mismatches through a separate explicit maintenance choice. Never handwrite/restore blocks or add backups; transactions handle recovery.
Project receipts use v3 with a unique install generation: refresh retains it and a later install gets a new one. Valid, consistent v1/v2 ownership evidence can migrate; permission or history ambiguity conflicts. Older published CLIs cannot read v3, so upgrade every checkout that may refresh the project to a supporting version first.
Uninstall/rollback preserves later edits to content and permissions. After all init/setup updates, run `status`, `doctor`, read back generated Skill/guidance and repeat dry-runs; `init --dry-run` lists planned paths only. Names prove nothing.

Contract version: {{version}}.
