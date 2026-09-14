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

## Observe and complete

Use `pr --status` for current native state; `status` is offline local evidence.
Use bounded `watch` with the exact request ID, a stable session ID and a checks
or lifecycle goal. A checks goal does not prove merge or Issue closure.
Follow `diagnostics[].remedy`, `next_actions` and `effects` after failure. Exit 0
means the operation succeeded, not delivery completion; 1 is rejected evidence,
2 is invalid input or a required choice, 3 is an unresolved/unknown result, and
130 is cancellation. Inspect uncertain writes and adopt exact native IDs before
retrying; never blindly recreate an Issue or request after a timeout.

The Agent supervises implementation and CI repairs. Observe the current request
head after pushes. GitHub/GitLab owns CI, reviews, protection and actual merge;
do not weaken required checks to complete delivery. When the declared preference
and existing user authorization permit it, register native auto-merge through
gh/glab outside SpecGit. Existing authorization remains valid for its agreed scope.

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
