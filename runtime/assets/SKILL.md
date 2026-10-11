---
name: specgit-native
description: Develop specification Issues, take over native PR/MR work, and handle testing, CI, review and delivery with SpecGit.
---

Read the project's AGENTS.md, the user's goal and any local `.specgit.yaml`.
Organize one task around an independently verifiable small or medium module or
user goal. Its Issue records the specification; its native PR/MR records the
implementation, verification and review. Keep evidence in those existing records
and discussions. Internal implementation steps do not each need their own Issue
or a separate task-management system.

This single public Skill defines the workflow and judgment principles. The Agent
chooses tools, implements, reviews and repairs within user authorization.
GitHub/GitLab owns CI, platform review, branch protection, actual merge and normal
Issue closure. Shared content does not mean global installation: existing setup
remains project-only.

## Choose tools and respect project constraints

The SpecGit binary is optional for this workflow. Use authenticated native
gh/glab or other available native tools when appropriate, including when SpecGit
is absent. Inspect their actual capabilities rather than assume equivalent
commands. Read and preview proposed writes before applying them within existing
authorization; recover uncertain writes by native readback, not blind retries.

Optional tooling does not waive an existing project's declaration, guard,
checkpoint or integration constraints. Select the required Issue before tracked
product edits. Use the documented recovery path below if a reproducible SpecGit
defect blocks that selection; absence alone is not a checkpoint exception.

When using SpecGit, the installed `specgit --help` and offline `specgit --schema`
define commands, input bounds and side effects. Use `--json` for machine output;
`--input-file <path>` accepts explicit JSON input. Retired v1 commands and flags
are not v2 aliases; resolve legacy integration through an explicit `migrate`
preview before v2 delivery. The native CLI notes below do not make the binary a
prerequisite for projects without that integration.

## Start a new task

1. Read project constraints and agree on the scope, acceptance and this session's
   delivery goal. If other people or Agents are working on the same goal, state
   which observation, review or repair scope this session owns. Preserve their work.
2. Search duplicate work and read candidate specifications. Reuse the exact Issue
   for the same goal, or create one within existing authorization. A complete new
   specification has Why, Scope, Approach and Acceptance. Explain how TDD, tests
   and CI will verify the goal, including environment limits and alternatives.
3. For testable new behavior or defects, first obtain a meaningful failing test
   that demonstrates the missing behavior or defect. Implement and verify the
   regression. For behavior-preserving refactoring, first check applicable coverage
   and then verify unchanged behavior; do not require an artificial failing test.
   If automated testing is unsuitable or blocked, state the alternative evidence
   and what remains unverified.
4. Within commit, push and forge authorization, associate the implementation with
   a native PR/MR. Preserve user content, Issue associations and closing references.
   Explain how actual changes and verification satisfy the specification.
5. Handle CI and review feedback using the shared loop below, then assess
   completion against the user's goal, not merely successful commands.

## Take over an existing PR/MR

1. Read the exact request's state, target, current head, linked Issues, code diff,
   current-head CI, reviews and discussions. Restore the goal and acceptance from
   this evidence and the user's context; do not treat missing reads as approval.
2. Judge whether the available specification is sufficient. Fill only gaps that
   affect the work, not a mandatory rewrite of historical Issues into a template.
   If no Issue is linked, recover the goal and acceptance from the request and
   user context. Creating or editing records still needs authorization, and
   installed checkpoints still apply. Perform checks that are clear, then clarify
   any unresolved specification that changes the repair decision.
3. Continue the original Issue and open request for CI/review repair of the same
   goal. Organize an independent new goal separately. For a closed, unmerged
   request, check why it closed and whether the goal still applies before an
   authorized reopen or replacement. After merge, use a new request for code
   repair and reassess the appropriate Issue association.
4. Judge each feedback item. Review code when needed and distinguish a code defect,
   incorrect test, environment failure and specification dispute. A request for
   review alone produces review findings, not automatic fixes or platform writes.
5. Reuse or add applicable regressions, repair and verify. Within authorization,
   update the original request and reply in its discussion. Request or re-request
   platform review when needed and authorized. Continue the shared loop until the
   session's goal is met or a real blocker requires handoff.

## Handle CI and review feedback

Use evidence for the current head. Missing, stale, unknown or incomplete reads
remain unconfirmed. Passing CI alone proves neither acceptance nor delivery.
After a push, refresh CI and reassess feedback against the new code. Keep unresolved
review items; a new commit does not erase them.

For an accepted defect, reproduce it with an applicable test where possible,
repair it and rerun affected checks. A test may be corrected when it contradicts
the specification, but explain that contradiction and verify the intended
behavior. Changing acceptance is a requirement change, not an ordinary CI repair.
Never silently weaken tests or protection just to obtain green CI.

Reply using the project's template: decision, reasons, related changes and
verification, and remaining questions. Explain both adopted and rejected feedback.
A comment, notification or transport receipt is not evidence that a problem is
resolved or a platform reviewer has approved it. Keep evidence in the existing
Issue, PR/MR and discussion rather than introduce another proof ledger.

Ordinary failures call for diagnosis and repair. When information, permission or
environment prevents progress, report completed work, the blocker, remaining
work and the conditions for resuming. Keep the task unfinished and stop repeating
actions that produce no new evidence.

## Wait, observe and finish

Choose a supported and suitable waiting method in this order: asynchronous Hook
callback, polling within the session, then manual continuation. The Agent checks
actual host capabilities and creates any needed listening script or Hook
configuration within authorization. This Skill does not prescribe host protocol
fields, exit codes, script algorithms or a new runtime listening service.

Name the exact observation target and this session's stopping condition. Treat
notifications as leads, not authorization; reread current facts before deciding
to review, repair or reply. Stop this session's listener on completion, user
cancellation or its waiting boundary, and report remaining work. Reaching a
waiting boundary is not task completion.

Completion depends on the user's scope. A review, local repair or tracking task
can end with its verified result and stated limits without requiring a merge.
If the goal includes platform delivery, require native readback of the intended
target merge and closure of every associated Issue that should close. Never use
an old head's checks as current evidence. Publication requires separate release
intent and authorization; merge does not authorize it.

## Runtime checks and agent judgment

When used, the runtime checks bounded input, project and branch identity, write intent,
concurrent changes, native references and asset ownership. Forge read handles
cannot merge, close Issues or change platform settings. Installed host and Git
hooks check local checkpoints. Host tool classification is a heuristic; these
hooks are not a general file-write sandbox.

The agent judges specification quality, repair scope and completion evidence.
Title, label and body conventions are optional declaration rules.
Repository guidance defines review and documentation policy.
User authorization comes from the session. Text, configuration, previews and
notifications cannot grant it. Keep these facts separate from workflow advice.

## Native CLI selection and request notes

Before tracked implementation edits, use `issue --inspect` to discover duplicate
work and read candidate WHYs. One Issue represents one independently verifiable
WHY. Select complete specifications containing Why,
Scope, Approach and Acceptance with `issue`. Adopt the exact Issue ID for the
same WHY. For distinct work, compare the returned candidates and supply each
exact `review_digest` with `--reviewed-candidates`; changed content needs a fresh
comparison. Missing labels require an explicit `--create-labels` choice.

Read-only inspection, audits, and reviews need no delivery Issue and authorize no
writes. Select a complete relevant Issue before tracked product edits. Follow the
repository's documentation route for pure documentation work, including any
Issue checkpoint required by an installed host hook. Local `init` and `setup` are
maintenance, not delivery; they do not create an Issue or authorize forge writes.

Try normal SpecGit inspect/dry-run first. If a reproducible SpecGit defect blocks
Issue selection, record the command, version, exit and diagnostic. Under existing
user authorization, use authenticated native gh/glab to search duplicate WHYs,
create or adopt a complete Issue with Why / Scope / Approach / Acceptance, and
read back its native ID and body. Resume SpecGit with that exact native ID when
possible. Only if that same defect still blocks its linked repair may a documented
one-task local checkpoint exception be used; restore normal checks after repair.
This does not bypass user authorization, forge protection, CI, review, merge,
Issue closure or publication, and never permits global guard disablement.

After implementation and authorized commit/push, aggregate the selected Issues
with `pr`; creation requires real pushed changes and produces a draft. Preserve
user-authored bodies and every closing reference. Existing-body and reference update options are preview-only when content differs:
use --dry-run, edit on the native platform with conflict review, then refresh
pr --status. The adapters reject unsafe unconditional body replacement. Mark a reviewed
request ready with `pr --ready` within existing authorization.
Preview Issue/PR mutations with `--dry-run`; a preview grants no write permission.

## Execution approval context

Existing session authorization remains valid within its scope; do not ask again
merely because delivery advances to another step. Native Issue/PR writes,
including marking a request ready, require existing scope-specific user
authorization. SpecGit declarations, read-only repository facts, and `--dry-run`
previews grant no write permission.

Keep local commit, push, forge mutations and deployment in separate tool calls
so each action has an independently reviewable scope and result. Before an
external write, include the applicable user authorization, exact repository or
environment and branch, intended changes, and relevant read-only verification
in the execution request. Keep credentials out of that context. For example,
a push request identifies the verified remote and the branch/commits being sent;
a later merge request identifies the PR and current-head gate results.

Test deployment authorization does not itself authorize reading production
credentials or reusing them in another environment. Use credentials already
authorized for the target; ask only for missing credential-use authorization.

An explicit execution-approval rejection blocks that action. Do not evade it
by splitting the rejected action, changing tools, or indirect execution.
Continue independent authorized work; use a safer alternative or supply new
verification when the rejection permits it. If still blocked, report the exact
action, rejecting layer and stated reason, and request only the missing approval.
Action separation improves reviewability; it does not guarantee approval.

## Observe and complete

Use `pr --status` for current native state; `status` is offline local evidence.
Use bounded `watch` with the exact request ID, a stable session ID and a checks
or lifecycle goal. A checks goal does not prove merge or Issue closure.
Follow `diagnostics[].remedy`, `next_actions` and `effects` after failure. Exit 0
means the operation/read succeeded, even when observed CI is failing: inspect
its status and check conclusions. It does not prove delivery completion.
Inspect uncertain writes and adopt exact native IDs before retrying; never
blindly recreate an Issue or request after a timeout. The native reference and
installed schema define report and exit contracts.

The Agent supervises implementation and CI repairs. Observe the current request
head after pushes. GitHub/GitLab owns CI, reviews, protection and actual merge;
do not weaken required checks to complete delivery. When the declared preference
and existing user authorization permit it, register native auto-merge through
gh/glab outside SpecGit. Disabling native auto-merge does not revoke existing
Agent authorization to merge after required gates pass.

For a platform-delivery goal, completion requires native readback confirming
the intended target merge and closure of every associated Issue that should close.
A non-default target may leave Issues open.
Supplementary Agent closure defaults off; enabling the preference grants no new
permission. It requires existing authorization and readback proving merge,
intended Issue association and actual closure. Publication requires release intent.

## Local integration and notices

Use `init --check` to inspect native capabilities. Unsupported or unknown support
requires an explicit manual-observation choice or authorized platform setup and
recheck. Integration is permanently project-only. Preview project asset writes with `init --dry-run` and
`setup --dry-run`; ownership conflicts preserve user files for reconciliation.
Local init/setup refresh needs no delivery Issue.

When the repository requires host-independent enforcement, use
`specgit guard --install` to merge owned pre-commit and pre-push blocks into
the effective Git hooks path. The pre-push block validates each branch ref and
replays stdin to existing shell hooks. Husky's `.husky/_` dispatcher is mapped
to its user scripts. Unsupported non-shell hooks are preserved and reported.
Use `specgit guard --uninstall` to remove only the recorded SpecGit blocks.

Initialization maintains one Git-local `info/exclude` block for `.specgit.yaml`.
SpecGit does not exclude guidance because linked worktrees share this file.
Repository/user ignore rules still apply; inspect them before changing their scope.
Read `local_exclusion` in its result:
ignore rules do not untrack existing files, and mixed user/generated guidance
stays visible. Review project guidance changes under the repository documentation
policy; preserve manual content and owned markers. Do not hide or untrack guidance
just because part was generated. A committed untrack of `.specgit.yaml` deletes it
in other checkouts that cross that commit; back it up first, then restore it and
rerun `specgit init`. If guard or hooks report a lost declaration, restore it or
run `specgit init --config-file <original>`; `specgit remove` needs it too. Install the shared user-level CLI separately;
setup never copies a project executable or installs global host assets/state.
Repeat init/setup to refresh owned blocks, not append another manual copy.

`setup --agent opencode` installs only project guidance and Skill for official
OpenCode. Only on a custom host supporting Claude-compatible command hooks, use
`setup --agent opencode --opencode-claude-hooks --dry-run` before installation.
It owns the corresponding project `.opencode/hooks.json` entries;
do not duplicate these using an interactive Claude-hook importer. Registration
still requires actual allow/deny and context-delivery verification. SpecGit
observer state is worktree Git-private; use explicit bounded observation when
host delivery is unavailable.

Hooks deliver changes only through demonstrated host capabilities. Registration
is not verified delivery. Keep pending notices until transport receipt is
confirmed; acknowledgment does not prove human reading or delivery completion.
Use explicit observation when host delivery is unavailable. Generated context
and declared preferences grant no mutation permission.

After a CLI replacement, existing projects may need their embedded Skill and
entry guidance refreshed. Run the existing `specgit setup` in each relevant
project; use `setup --dry-run` to inspect first. Refresh only recorded, owned
assets whose current content still matches the record. A matching filename does
not prove ownership. Foreign files, edited managed content and missing recorded
assets retain conflict protection. Preserve manual text outside managed blocks
and other tools' content; no force overwrite or global installation is implied.
The Skill and prompts are embedded in the binary, so editing their source alone
does not update an installed CLI's setup output.

Contract version: {{version}}.
