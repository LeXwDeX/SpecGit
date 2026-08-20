---
"specgit": patch
---

### GitLab checks-gate semantics: allow_failure truth and the Free-tier requiredChecks (#116)

Decided per D-4″ (job-level truth + pipeline-level verdict) and pinned by
new ledger rows 25/26 (`docs/evidence/gitlab-19.2.md`, anchored at
`v19.2.4-ee`):

- `CheckRunInfo.allowFailure?` (provider port): a GitLab `allow_failure`
  job reports its truthful `conclusion: 'failure'` with the platform
  boolean, and the checks gate passes the run per pipeline semantics —
  a failed `allow_failure` job keeps the pipeline green (ledger row 17).
  Failure only: every other conclusion (cancelled, …) still fails,
  allowed or not. The GitHub adapter never sets the flag, so GitHub
  verdicts are byte-for-byte unchanged.
- `GlabProvider#getCheckRuns` maps the full job-status vocabulary
  (pinned "Job status values" list): final states complete the run
  (`success`/'success', `failed`/'failure', `canceled`/'cancelled'),
  `skipped` jobs contribute no check-run at all (intentionally not run —
  a required name reads `checks_missing`), `manual` and every other
  non-final status stay pending (fail-closed). Retried jobs stay omitted
  (`include_retried` never passed, row 16).
- `GlabProvider` gains a `requiredChecks` constructor option (the
  policy's list): `getBranchProtection`/`enableBranchProtection` now
  report the **verified pipeline-gate intersection** — the policy names
  that exist as CI job names of the branch's latest pipeline
  (`?ref=` filter, `order_by` id `desc` default — row 25) when
  `only_allow_merge_if_pipeline_succeeds` is on; off ⇒ `[]`. The
  Ultimate-only status-checks primitive is never touched (row 22), and
  without the policy injected the list stays honestly empty.
- Open sub-mappings resolved in the ledger: `manual`⇒pending,
  `skipped`⇒absent (rationale recorded); the `WIP:`-prefix deferral is
  re-affirmed.
- Unit tests pin the whole mapping table (allow_failure / retry /
  locked / skipped) and the intersection (gate on/off, no pipeline,
  slash-ref encoding, rename fail-closed, witness pagination I3b);
  existing GitHub checks-gate tests are unchanged and green.

Not routed: evaluation still runs the gh path (`gitlab_unsupported`
guard) until #117.
