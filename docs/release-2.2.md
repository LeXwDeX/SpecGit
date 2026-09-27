# SpecGit 2.2.0

This release addresses the nine findings from the 2026-09-27 product-design audit.
GitHub/GitLab continue to own review, protection and merge. No notification or
declaration grants mutation permission.

| Issue | Change | Regression evidence |
| --- | --- | --- |
| [#633](https://github.com/LeXwDeX/SpecGit/issues/633) | Reject unsafe automatic replacement of existing PR/MR bodies; retain reference-preserving previews | `pr::explicit_body_update_previews_all_refs_but_never_overwrites_native_content` |
| [#634](https://github.com/LeXwDeX/SpecGit/issues/634) | Persist adopted native specifications independently of creation intents; share Guard/Hook checkpoint validation | `design_regressions::adopted_specs_enable_guard_and_edit_hook_without_creation_intents` |
| [#635](https://github.com/LeXwDeX/SpecGit/issues/635) | Revalidate same-head execution identities and results; exclude proven superseded GitHub workflow suites | `design_regressions::same_head_check_rerun_invalidates_the_observation` and workflow supersession cases in `native_status` |
| [#636](https://github.com/LeXwDeX/SpecGit/issues/636) | Offer actionable async check events without waiting for lifecycle completion | `design_regressions::async_hook_offers_prepare_review_before_lifecycle_timeout` |
| [#637](https://github.com/LeXwDeX/SpecGit/issues/637) | Recheck branch, commit, declaration and native project before Issue writes | Branch and declaration change tests in `design_regressions` |
| [#638](https://github.com/LeXwDeX/SpecGit/issues/638) | Serialize Issue candidate reads and creation across checkouts sharing the user data root | `design_regressions::concurrent_checkouts_share_issue_creation_lock` |
| [#639](https://github.com/LeXwDeX/SpecGit/issues/639) | Keep guidance visible across linked worktrees instead of inferring shared ignore rules from one worktree | Both initialization orders in `design_regressions` |
| [#640](https://github.com/LeXwDeX/SpecGit/issues/640) | Enforce checkpoints for staged deletions and type changes | Deletion and Unix type-change tests in `guard` |
| [#641](https://github.com/LeXwDeX/SpecGit/issues/641) | Validate GitLab merged-result commit parents and expose the actual tested SHA | `design_regressions::gitlab_merged_result_requires_both_current_parents_and_retains_tested_sha` |

Publication and artifact qualification are tracked in
[#642](https://github.com/LeXwDeX/SpecGit/issues/642), now closed after publication.
[PR #643](https://github.com/LeXwDeX/SpecGit/pull/643) merged at
`ce54ea6f6c047f5a422225312bc132283866cb17`; [main CI](https://github.com/LeXwDeX/SpecGit/actions/runs/36313672563)
and [signed release build](https://github.com/LeXwDeX/SpecGit/actions/runs/36314760042)
passed for [v2.2.0](https://github.com/LeXwDeX/SpecGit/releases/tag/v2.2.0).
Downloaded ZIP digests/signature and the macOS installed regression were verified.
These are 2.2.0 facts, not qualification for a later source revision.

## Migration notes

- Existing PR/MR bodies are preserved. Use `--update-body --body-file <file>
  --dry-run` or `--update-references --dry-run` to prepare the exact proposal.
  Apply reviewed changes through the native platform with conflict review, then
  refresh `pr --status`. A differing body without dry-run returns
  `unsupported_operation`; the REST adapters have no qualified conditional-write
  mechanism. Creation and ready operations remain supported.
- Old adoption-only checkpoints need one explicit reselection of their native
  Issue IDs. Created-Issue checkpoints remain valid. New adoption records are
  local verified snapshots, not authority to skip future native readback.
- `init` removes SpecGit-owned guidance exclusions from the shared exclude block.
  Generated guidance can therefore become visible in `git status`. Preserve
  manual guidance and review generated hunks before committing.
- Issue creation coordination is limited to the same OS user, host and shared
  data root. It is not a distributed uniqueness guarantee; native search can lag
  writes. Review and reconcile any duplicate WHYs on the platform before resuming.
- GitHub observations require native workflow-run identity reads (Actions read
  access for private repositories). Supersession is scoped to workflow, event,
  branch and associated PR IDs. Missing identities or not-yet-visible replacement
  checks remain unknown; independent suites and actual pending checks are kept.
- GitLab merged-results evidence must prove both current source and target
  parents. Unknown ancestry and unsupported merge-train shapes remain unknown,
  rather than being accepted as successful current evidence.

The GitLab parser regression uses synthetic native responses. A real GitLab
merged-results deployment remains a separate platform qualification; this file
does not claim it was exercised. Async CLI tests similarly do not substitute for
real host consumption evidence.
