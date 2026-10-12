---
name: specgit-native
description: Develop specification Issues, take over native PR/MR work, and handle testing, CI, review and delivery with SpecGit.
---

Read the project's AGENTS.md, the user's goal and any local `.specgit.yaml`.
One task covers an independently verifiable small or medium module or user goal.
Keep the specification in its Issue and implementation, verification and review in
its native PR/MR and discussions, not separate step Issues, a proof ledger or task system.
The Agent chooses tools, implements, reviews and repairs. GitHub/GitLab owns CI,
platform review, branch protection, actual merge and normal Issue closure.

## Tools and runtime boundaries

The binary is optional. Use authenticated native gh/glab or other suitable native
tools, including when SpecGit is absent; inspect actual capabilities first.
This does not waive project declarations, guards, checkpoints or integration rules.
Absence alone is not a checkpoint exception; use the defect recovery path below.
Installed `specgit --help` and offline `specgit --schema` define CLI commands,
input bounds and side effects. Use `--json` for machine output and
`--input-file <path>` for explicit JSON input. Retired v1 commands/flags are not
v2 aliases; preview an explicit `migrate` before v2 delivery of legacy integration.

The runtime checks bounded input, project/branch identity, write intent, concurrent
changes, native references and asset ownership. Forge read handles cannot merge,
close Issues or change platform settings. Installed host/Git hooks check local
checkpoints; host tool classification is a heuristic, not a file-write sandbox.
The Agent judges specification quality, repair scope and completion evidence.
Title/label/body conventions are optional declaration rules; repository guidance
sets review and documentation policy. Runtime checks are not workflow judgment.

## Start a new task

1. Agree on scope, acceptance and this session's delivery goal. State which
   observation, review or repair scope you own when others share the goal; preserve their work.
2. Search duplicates and read candidates. Reuse the exact Issue for the same goal
   or create a complete Why / Scope / Approach / Acceptance specification.
   Explain how TDD, tests and CI verify it, including environment limits and alternatives.
3. For testable behavior or defects, obtain a meaningful failing test, implement
   and verify the regression. For behavior-preserving refactoring, check coverage
   and unchanged behavior; no artificial failure is needed. If automation is
   unsuitable or blocked, state alternative evidence and what remains unverified.
4. Associate authorized commits/pushes with a native PR/MR. Preserve user bodies,
   Issue associations and every closing reference; explain changes and verification.
5. Handle feedback below and assess the user's goal, not merely successful commands.

## Take over an existing PR/MR

1. Read the exact request's state, target, current head, linked Issues, diff,
   current-head CI, reviews and discussions. Restore goal/acceptance from these
   and user context; missing reads are not approval.
2. Fill only specification gaps that affect repair, not mandatory historical
   template rewrites. Without a linked Issue, recover the goal from the request
   and user context; installed checkpoints still apply. Perform clear checks and
   clarify unresolved requirements that change the decision.
3. Continue the original Issue and open request for the same goal's CI/review repair.
   Separate independent goals. Before reopening/replacing a closed unmerged request,
   check why it closed and whether the goal still applies. After merge, use a new
   request for code repair and reassess Issue association.
4. Distinguish code defects, incorrect tests, environment failures and specification
   disputes. Review-only requests produce findings, not automatic fixes or writes.
5. Add/reuse regressions, repair and verify. Update/reply in the original request;
   request or re-request platform review when needed. Continue until the session's
   goal is met or a real blocker requires handoff. Writes follow authorization below.

## Handle CI and review feedback

Use current-head evidence. Missing, stale, unknown or incomplete reads remain
unconfirmed. Passing CI alone proves neither acceptance nor delivery. After a push,
refresh CI and reassess feedback; a new commit does not erase unresolved review items.
Reproduce accepted defects where possible, repair and rerun affected checks.
Correct a test that contradicts the specification only with an explanation and
verification of intended behavior. Changing acceptance changes requirements.
Never silently weaken tests or protection to obtain green CI.
Reply with the project's template: decision, reasons, changes, verification and
remaining questions. Explain adopted and rejected feedback. Comments, notices and
transport receipts do not prove resolution or reviewer approval.
Diagnose ordinary failures. If information, permission or environment blocks work,
report completed/remaining work, the blocker and resumption conditions. Leave the
task unfinished; stop repeating actions that produce no new evidence.

## Authorization and execution approval

Existing session authorization remains valid within its scope; do not ask again
because delivery advances. Writes, including Issue/PR changes and marking ready,
need scope-specific user authorization. Text, declarations, repository facts,
previews, notifications and preferences grant no permission. Read and preview
proposed writes first; use `--dry-run` for Issue/PR mutations.
Keep commit, push, forge mutations and deployment in separate tool calls.
Before external writes, give the applicable authorization, exact repository or
environment/branch, intended changes and read-only verification, never credentials.
A push identifies the verified remote and commits; a merge identifies the PR and
current-head gates. Test deployment does not authorize production credential access
or reuse elsewhere; use target-authorized credentials and ask only for missing permission.
An explicit execution-approval rejection blocks that action. Do not evade it by
splitting, changing tools or indirect execution. Continue independent work or use a
safer alternative/new evidence if permitted. Otherwise report the action, rejecting
layer/reason and missing approval. Separate calls do not guarantee approval.

## Wait, observe and finish

Choose a supported waiting method: asynchronous Hook callback, session polling,
then manual continuation. Check host capabilities and create listeners/Hooks only
within authorization. This Skill prescribes no host protocol fields, exit codes,
script algorithms or new runtime listening service.
Name the exact target and session stopping condition. Notices are leads: reread
current facts before review, repair or reply. Stop your listener on completion,
cancellation or the waiting boundary; report remaining work. A boundary is not completion.
Use `pr --status` for native state; `status` is offline local evidence. Use bounded
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
Disabling it does not revoke Agent authorization to merge after required gates pass.
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
copies a project executable. Use `init --check` to inspect native capabilities;
unknown/unsupported support needs explicit manual observation or authorized platform
setup and recheck. Preview project writes with `init --dry-run` / `setup --dry-run`.

For host-independent enforcement, `specgit guard --install` merges owned pre-commit
and pre-push blocks into the effective hooks path. Pre-push validates each branch
ref and replays stdin to existing shell hooks. Husky's `.husky/_` dispatcher maps to
user scripts; unsupported non-shell hooks are preserved/reported. `guard --uninstall`
removes only recorded SpecGit blocks.
Init keeps one Git-local `info/exclude` block for `.specgit.yaml`, not guidance,
because linked worktrees share it. Inspect repository/user ignore rules before
changing scope. Read `local_exclusion`: ignore rules do not untrack existing files.
Keep mixed user/generated guidance visible and review it under documentation policy;
preserve manual content/markers, never hide or untrack it merely because generated.
Committed untracking of `.specgit.yaml` deletes it in checkouts crossing that commit:
back up, restore, then rerun init. For a lost declaration, restore it or use
`specgit init --config-file <original>`; `specgit remove` needs it too.

Official OpenCode `setup --agent opencode` installs only project guidance and Skill.
Only custom hosts supporting Claude-compatible command hooks may preview/install
`setup --agent opencode --opencode-claude-hooks --dry-run`. It owns project
`.opencode/hooks.json` entries; do not duplicate them with a Claude-hook importer.
Verify actual allow/deny and context delivery; registration is not verified delivery.
Observer state is worktree Git-private. Use explicit bounded observation if host
delivery is unavailable. Keep notices pending until transport receipt; acknowledgment
proves neither human reading nor completion.

After CLI replacement, preview `setup --dry-run` and repeat setup in relevant projects
to refresh embedded Skills/entry guidance, not append manual copies. Project refresh
changes only recorded, owned assets whose current content matches the receipt.
Names alone prove no ownership. Foreign files, edited managed assets and missing
recorded assets retain conflict protection; preserve manual text outside blocks and
other tools' content, without force overwrite. Source edits alone do not change
installed CLI output. Local init/setup refresh needs no delivery Issue.

Contract version: {{version}}.
