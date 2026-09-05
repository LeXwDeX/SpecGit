# Team Workflow

## Agree on the policy

`spec_git/policy.yaml` records the team's exact required-check names and optional
language, labels, templates, body validation, and merge automation. The fields
`validation.titles`, `validation.labels`, and `validation.bodies` enable their
respective rules. Policy is reviewed as a team contract; do not weaken a correct
check to turn a failed delivery green.

Use a stable verification aggregate that succeeds only when all applicable work
passes. An intentionally empty required-check list means no business CI; the
platform acceptance integration remains. On GitHub, require SpecGit Acceptance
through branch protection and keep it out of its own `required_checks` list.

## Match work to verification

| Change | Appropriate work |
| --- | --- |
| README, Wiki, or ordinary manual guidance | One relevant content review and lightweight checks |
| CLI, generator, schema, executable workflow, or distributed skill | Applicable product tests and review |
| Mixed documentation and source | Product verification for the complete delivery |
| Explicitly authorized package release | Release gates in addition to delivery checks |

In SpecGit's source repository, prose-only work runs
`node scripts/ci-metadata-check.mjs`; it does not build the product or enter
repeated code-review rounds. Lightweight remote metadata validation and acceptance
still protect merge. Adopting projects define their own business-CI scope.
Keep unrelated dirty files and speculative improvements outside a small edit.

## Deliver and close

Start or reuse one issue per independently verifiable WHY, keep the PR/MR body
complete, preserve every closing reference, and push the final reviewed change.
Mark the request ready, then obtain `specgit finish --json` acceptance on its
current head. Pending checks are a wait state. An ordinary documentation edit
does not authorize an npm release.

Only the user can enable automatic merge and choose its target. Once enabled,
the trusted completion workflow continues after CI; `specgit pr --merge --json`
recovers an interrupted completion using fresh evidence. Confirm merge before
closing issues. Confirm every issue closure before reporting completed.

Create a repair issue for an independently confirmed terminal delivery failure;
reuse an existing issue for the same cause. Draft requests, pending CI, and
superseded heads do not justify new repair work. Pre-existing unrelated defects
are reported separately rather than silently expanding the requested change.

[Team contract](https://github.com/LeXwDeX/SpecGit/blob/main/docs/team-workflow.md) · [中文](Team-Workflow-zh)
