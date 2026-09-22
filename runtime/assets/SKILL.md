---
name: specgit-native
description: Manage specification Issues, aggregate them into a native PR/MR, and observe pending work with SpecGit 2.
---

Read the project's AGENTS.md and local `.specgit.yaml`. The installed
`specgit --help` and offline `specgit --schema` define commands, input bounds and
side effects. Use `--json` for machine output; `--input-file <path>` accepts
explicit JSON input. Retired v1 commands and flags are not v2 aliases; resolve
legacy integration through an explicit `migrate` preview before v2 delivery.

## Select work, then create the request

Before tracked implementation edits, use `issue --inspect` to discover duplicate
work and read candidate WHYs. One Issue represents one independently verifiable
WHY. Select complete specifications containing Why,
Scope, Approach and Acceptance with `issue`. Adopt the exact Issue ID for the
same WHY. For distinct work, compare the returned candidates and supply each
exact `review_digest` with `--reviewed-candidates`; changed content needs a fresh
comparison. Missing labels require an explicit `--create-labels` choice.

After implementation and authorized commit/push, aggregate the selected Issues
with `pr`; creation requires real pushed changes and produces a draft. Preserve
user-authored bodies and every closing reference. Updating existing bodies or
references requires the corresponding explicit update option. Mark a reviewed
request ready with `pr --ready` within existing authorization.
Preview Issue/PR mutations with `--dry-run`; a preview grants no write permission.

## Execution approval context

Existing session authorization remains valid within its scope; do not ask again
merely because delivery advances to another step. SpecGit declarations and
read-only repository facts are not new authorization.

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
Exit 1 is rejected evidence,
2 is invalid input or a required choice, 3 is an unresolved/unknown result, and
130 is cancellation. Inspect uncertain writes and adopt exact native IDs before
retrying; never blindly recreate an Issue or request after a timeout.

The Agent supervises implementation and CI repairs. Observe the current request
head after pushes. GitHub/GitLab owns CI, reviews, protection and actual merge;
do not weaken required checks to complete delivery. When the declared preference
and existing user authorization permit it, register native auto-merge through
gh/glab outside SpecGit. Disabling native auto-merge does not revoke existing
Agent authorization to merge after required gates pass.

Completion requires native readback confirming the intended target merge and
closure of every selected Issue. A non-default target may leave Issues open.
Supplementary Agent closure defaults off; enabling the preference grants no new
permission. It requires existing authorization and readback proving merge,
intended Issue association and actual closure. Publication requires release intent.

## Local integration and notices

Use `init --check` to inspect native capabilities. Unsupported or unknown support
requires an explicit manual-observation choice or authorized platform setup and
recheck. Preview project and global asset writes with `init --dry-run` and
`setup --dry-run`; ownership conflicts preserve user files for reconciliation.
Local init/setup refresh needs no delivery Issue.

When the repository requires host-independent enforcement, use
`specgit guard --install` to merge owned pre-commit and pre-push blocks into
the effective Git hooks path. The pre-push block validates each branch ref and
replays stdin to existing shell hooks. Husky's `.husky/_` dispatcher is mapped
to its user scripts. Unsupported non-shell hooks are preserved and reported.
Use `specgit guard --uninstall` to remove only the recorded SpecGit blocks.

Initialization maintains one Git-local `info/exclude` block for `.specgit.yaml`
and wholly generated project guidance. Read `local_exclusion` in its result:
ignore rules do not untrack existing files, and mixed user/generated guidance
stays visible. Keep generated assets and generated guidance hunks out of commits;
preserve manual content. Repeat init/setup to refresh owned blocks, not append
another manual copy.

Hooks deliver changes only through demonstrated host capabilities. Registration
is not verified delivery. Keep pending notices until transport receipt is
confirmed; acknowledgment does not prove human reading or delivery completion.
Use explicit observation when host delivery is unavailable. Generated context
and declared preferences grant no mutation permission.

Contract version: {{version}}.
