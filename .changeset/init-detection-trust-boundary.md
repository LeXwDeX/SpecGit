---
"specgit": patch
---

### init detection trust boundary: only PR-triggered workflows become required checks (#121)

Closes #121. The required-checks detection predicate classified any
non-`workflow_dispatch` workflow as PR-running, so push-triggered deploy
workflows with branch filters and scheduled jobs landed in
`policy.required_checks` at `specgit init`. Those checks never report on a
PR head — permanent `checks_missing`, every delivery exits 1 forever — and
the "never weaken the policy" iron rule made the only correct repair a
forbidden act. Stillborn harness for affected repo classes.

- `src/cli/detect-checks.ts`: classification is trigger-inclusion now — a
  workflow contributes required-check candidates only when its triggers
  include `pull_request` or `pull_request_target` (both report check runs
  on a PR head). An omitted `on` key keeps GitHub's default triggers
  (push and pull_request) and still qualifies. Push (filtered or not),
  schedule, dispatch, and every other trigger never qualify.
- `specgit init` warns (`checks_not_pr_visible`) when workflows with jobs
  but no PR trigger exist, lists them in `detected.nonPrWorkflows`, and
  the fix text names the legitimate repairs: explicit `--required-check`
  for a job that genuinely reports on PR heads, and `init --force`
  re-detection after CI changes.
- Iron rule re-worded in the docs to distinguish **weakening a true
  policy** (forbidden) from **correcting a wrong-at-birth one**
  (required): docs/cli.md (detection trust boundary), docs/reference.md
  (wrong at birth vs weakening), docs/troubleshooting.md (`checks_missing`
  structural cause), docs/baseline-v1.md (non-goal wording).
- TDD: init fixture with push-filtered + schedule + `pull_request`
  workflows pins the classification, the warning, and the envelope;
  `pull_request_target` and trigger-less workflows pinned as qualifying;
  dispatch-only workflows now surface in `nonPrWorkflows` too.
