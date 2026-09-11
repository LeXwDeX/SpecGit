# Retired engine test disposition

- `finish.rs::both_native_forges_accept_complete_current_head_evidence_without_remote_writes` — Preserved native observation subset in native_status.rs; acceptance assertions removed.
- `finish.rs::candidate_cannot_remove_approved_required_check_and_initial_adoption_is_explicit` — Retired: approved declaration/required-check and initial-adoption acceptance engine.
- `finish.rs::current_rerun_masks_old_green_and_missing_native_protection_remains_unknown` — Preserved native observation subset in native_status.rs; acceptance assertions removed.
- `finish.rs::complete_requires_native_merge_and_every_referenced_issue_closed` — Preserved native observation subset in native_status.rs; acceptance assertions removed.
- `finish.rs::native_edits_and_stale_head_pipeline_never_accept` — Preserved native observation subset in native_status.rs; acceptance assertions removed.
- `finish.rs::incomplete_jobs_counts_unknown_suites_and_wrong_apps_cannot_accept` — Preserved native observation subset in native_status.rs; acceptance assertions removed.
- `finish.rs::approvals_and_clean_local_head_are_required_and_native_settings_are_not_exposed` — Preserved native observation subset in native_status.rs; acceptance assertions removed.
- `finish.rs::native_downstream_pipeline_failure_blocks_an_otherwise_successful_parent` — Preserved native observation subset in native_status.rs; acceptance assertions removed.
- `finish.rs::removed_selected_associations_block_acceptance_and_completion` — Preserved native observation subset in native_status.rs; acceptance assertions removed.
- `finish.rs::a_successful_trigger_with_hidden_downstream_evidence_is_unknown` — Preserved native observation subset in native_status.rs; acceptance assertions removed.
- `merge.rs::native_merge_checks_head_and_reports_real_closure_without_fallback` — Retired: core merge writes, gate or recovery; replaced by public rejection/no-write boundary.
- `merge.rs::auto_merge_and_lost_response_recover_only_from_native_readback` — Retired: core merge writes, gate or recovery; replaced by public rejection/no-write boundary.
- `merge.rs::denied_or_opaque_success_never_resubmits_or_falls_back` — Retired: core merge writes, gate or recovery; replaced by public rejection/no-write boundary.
- `merge.rs::draft_failed_checks_dirty_tree_and_changed_request_refuse_before_write` — Retired: core merge writes, gate or recovery; replaced by public rejection/no-write boundary.
- `merge.rs::gitlab_unverified_train_routing_and_rebase_have_no_write_capability` — Retired: core merge writes, gate or recovery; replaced by public rejection/no-write boundary.
- `merge.rs::explicit_gitlab_strategy_overrides_native_squash_default` — Retired: core merge writes, gate or recovery; replaced by public rejection/no-write boundary.
- `merge.rs::glab_no_pipeline_auto_and_unenforceable_squash_are_rejected_before_intent` — Retired: core merge writes, gate or recovery; replaced by public rejection/no-write boundary.
- `merge.rs::glab_consumed_pipeline_must_match_the_current_head_pipeline` — Retired: core merge writes, gate or recovery; replaced by public rejection/no-write boundary.
- `promotion.rs::both_forges_preserve_two_source_associations_and_closed_issues_after_branch_cleanup` — Retired: promotion inference engine; replaced by public rejection/no-write boundary.
- `promotion.rs::full_revert_is_excluded_and_later_partial_change_is_unverified` — Retired: promotion inference engine; replaced by public rejection/no-write boundary.
- `promotion.rs::unknown_cherry_pick_and_unpromoted_native_anchors_are_not_inferred_from_titles` — Retired: promotion inference engine; replaced by public rejection/no-write boundary.
- `promotion.rs::dirty_or_wrong_source_promotion_cannot_offer_associations` — Retired: promotion inference engine; replaced by public rejection/no-write boundary.
- `promotion.rs::complete_squash_is_supported_without_treating_a_partial_one_parent_commit_as_complete` — Retired: promotion inference engine; replaced by public rejection/no-write boundary.
- `promotion.rs::native_association_read_failure_and_shallow_history_never_become_empty_success` — Retired: promotion inference engine; replaced by public rejection/no-write boundary.
- `promotion.rs::fresh_clone_recovers_merge_associations_after_source_branches_are_deleted` — Retired: promotion inference engine; replaced by public rejection/no-write boundary.
- `promotion.rs::local_replacement_objects_cannot_fake_retained_native_postimages` — Retired: promotion inference engine; replaced by public rejection/no-write boundary.
- `promotion.rs::default_and_external_grafts_cannot_hide_source_merges_from_the_native_range` — Retired: promotion inference engine; replaced by public rejection/no-write boundary.

## Native checks simplification

- `current_rerun_masks_old_green_without_reading_protection_policy` -> `native_latest_pending_check_is_not_replaced_by_old_actions_green`: retain current native pending evidence; retire inferred Actions run/job attempt ownership.
- `incomplete_jobs_counts_and_unknown_suites_remain_unavailable` -> `incomplete_pages_duplicate_ids_and_malformed_current_checks_remain_unavailable` and `current_checks_require_complete_consistent_pages`: retain complete pages/head/object identity; retire unknown-suite and missing-job cross-API matching.
- `native_downstream_pipeline_failure_is_reported_with_successful_read` -> `native_head_pipeline_failure_is_reported_without_job_or_downstream_reads`: retain native MR pipeline failure; retire child/DAG expansion and inferred aggregate failure.
- `a_successful_trigger_with_hidden_downstream_evidence_is_unknown` -> `missing_pipeline_identity_is_unknown_but_explicit_null_is_unobserved`: retain missing-vs-null facts; retire mandatory trigger/child discovery.
- `native_commit_status_context_uses_latest_id_and_rejects_duplicate_objects`: preserve context latest status plus duplicate-page/object safety.
- `CheckLineage`, `DownstreamIdentity`, `PipelineIdentity`, `PipelineLink`: removed with obsolete DAG proof engine. Exact head/project/positive-ID validation remains; workflow attempt reconstruction is retired.
- Source contracts: https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference ; https://docs.gitlab.com/api/pipelines/#get-a-single-pipeline . Latest check results and MR head pipeline facts do not claim complete workflow/downstream coverage.

## Pure assessment tests

- `pure_acceptance_rejection_and_initial_adoption`: retire local acceptance and adoption eligibility; native lifecycle normalization lives in `observation` tests.
- `missing_and_changed_snapshots_never_become_empty_success`: preserve unavailable/malformed observations.
- `native_required_app_and_optional_failures_remain_distinct`: retire required-check policy; retain native check identities and failed/neutral/pending outcomes.
- `completed_requires_merge_and_all_associated_issues_closed`: preserve native merge plus nonempty known closed associations.
- `pure_preflight_rejects_identity_authority_and_unresolved_selection`: retire acceptance authority; preserve invalid identity and missing-association observation checks.
- `pure_core_rejects_stale_heads_wrong_projects_and_conflicting_attempts`: retain native current-head/project/object identity checks without reconstructing workflow attempts.
- `pure_check_outcomes_are_independent_of_cli_exit_and_blocker_text`: preserve typed native outcomes independently of successful read exit status.
