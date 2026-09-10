---
name: specgit-native
description: Manage specification Issues, aggregate them into a native PR/MR, and observe pending work with SpecGit 2.
---

Read the project's AGENTS.md and `.specgit.yaml`. Discover the installed contract
with `specgit --help` and offline `specgit --schema`. Use `--json` for machine
output and `--input-file <path>` for explicit JSON input; follow the schema's
bounds and error remedies. A preview does not authorize a later mutation.

Before tracked edits, search for duplicate Issues and read their WHY. Select
complete specifications containing Why, Scope, Approach and Acceptance, then
aggregate them into one PR/MR. Preserve user bodies and every closing reference.
Preview Issue/PR mutations with `issue --dry-run` or `pr --dry-run`. Missing labels
require an explicit `--create-labels` choice; names alone are not ownership.

Use `pr --status` and bounded `watch` for native state. The Agent supervises
implementation and fixes. When the declared preference and existing user
authorization permit it, register native auto-merge using gh/glab outside
SpecGit. GitHub/GitLab owns CI, reviews, protection and actual merge. Read back
native request and Issue states; a non-default target may leave Issues open.
Agent closure is optional and defaults off. An enabled preference is not new
authorization: any supplementary closure needs existing authorization and native
readback confirming merge, intended Issue association and actual closure.

Use `init --check` for native capabilities. Unknown or unsupported capability
requires an explicit manual-observation choice or authorized platform setup and
recheck. Preview installation changes with `setup --dry-run`.

Hooks deliver changes only through the host's demonstrated capability. Keep
pending notices until delivery is confirmed; a visible message does not prove
the user read it. Use explicit observation when host delivery is unavailable.
Generated context grants no mutation permission.

Contract version: {{version}}.
