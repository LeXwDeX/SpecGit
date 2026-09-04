# GitLab completion routing evidence (#427)

Validated on 2026-09-04 through authenticated `glab` against the existing
`suntao/specgit` mirror, project 1309 on `git.ycgame.com`. No token values
were read, stored or included in the evidence.

## CI compiler evidence

An isolated `codex/427-gitlab-routing-probe` branch at
`db3b17027688b5325fb82e95565adc0cf308b149` contained the generated root router,
generated standalone completion configuration, and a small business-check
fixture. It was pushed with `[skip ci]` to validate configuration before a
compatible runtime was published; this is a compiler probe, not delivery
acceptance or an executed completion claim.
The temporary remote branch was removed after capture; its local commit and
the summarized compiler results remain available for the audit.

- `GET projects/1309/ci/lint?content_ref=codex%2F427-gitlab-routing-probe&include_jobs=true`
  returned `valid: true`, no errors, and resolved the business include at that
  exact commit. The compiled jobs were `business-check` in `test` and
  `specgit-request-completion` in `.post`.
- The compiler warned that the fixture's unconditional business rule can create
  both push and MR pipelines. That rule belongs to the explicit fixture;
  SpecGit preserves the adopting project's business rules.
- `POST projects/1309/ci/lint` with the generated standalone completion content
  returned `valid: true`, no errors or warnings, and exactly one job,
  `specgit-complete` in the ordinary `test` stage.

The runtime version in this compiler probe was 1.12.0. Runtime compatibility is
checked separately; the probe does not claim that 1.12.0 provides the new
completion protocol.

## Platform response shapes

Read-only queries against existing pipeline 29645 confirmed:

- Project identity: `id: 1309`, `path_with_namespace: suntao/specgit`,
  `default_branch: main`, `ci_config_path: null`.
- Pipeline detail includes numeric `id` and `project_id`, `source`, `ref`, `sha`,
  and the boolean `tag: false`.
- Job 46921 includes `pipeline.id`, `pipeline.project_id` and `pipeline.sha`.
- The `/trigger_jobs` endpoint is available and returned an empty array for
  this existing push pipeline.

These reads verify the API fields consumed by completion identity checks.
They do not prove a new MR-to-completion trigger relationship. Focused automated
tests cover the valid relationship and rejection of wrong projects, heads,
default refs, source pipelines, jobs, extra children and unproven exclusions.
An executed MR completion remains a separate live integration check.
