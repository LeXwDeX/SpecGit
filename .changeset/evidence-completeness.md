---
"specgit": patch
---

### Evidence-completeness rule I3b: fail closed on silently truncated evidence lists (#120)

Closes #120. The fail-closed promise had one branch implemented — errors
(ungatherable evidence ⇒ exit 3) — and one unwritten: silent
incompleteness. `getOpenIssueNumbers` fetched a single search page of 100
while the same provider paginated `getCheckRuns`: with `ordered_issues:
true` and more than 100 open issues, an earlier open issue on page 2 was
invisible to the sequence gate and a delivery could exit 0 over a
violated policy; same-title adoption missed adoptable issues beyond
page 1.

- The rule is now contract, written as the second fail-closed branch in
  [docs/baseline-v1.md](../docs/baseline-v1.md): every list-shaped
  evidence input is paginated to exhaustion or signals truncation, and a
  truncation signal degrades the verdict to `unknown`
  (`evidence_truncated`, exit 3) — never a complete-evidence exit 1.
- `getOpenIssueNumbers` pages the issue search to exhaustion
  (per_page=100, deduplicated across page-boundary shifts);
  `incomplete_results: true` and the 1000-result search cap (10 full
  pages) fail `evidence_truncated`. `getCheckRuns` now signals
  truncation at its 10-page cap instead of returning a possibly partial
  list. The sequence gate and issue adoption consume the complete list
  through the same seam; the provider port documents the completeness
  contract (`ok` means exhausted).
- `specgit pr` discovery stays as-is, disclosed: its bounded probe
  refuses on zero/several matches, so truncation cannot flip an outcome
  (≥2 always refuses with the candidate list).
- The GitLab provider plan's `rel="next"` continuation
  ([docs/gitlab-support.md](../docs/gitlab-support.md)) is confirmed to
  carry the same rule from day one: continuation to exhaustion, full
  page without a usable link ⇒ `evidence_truncated`, exit 3.
- TDD: a >100-issues scripted-provider fixture pins the sequence gate's
  false pass before the fix (red: 5 failed / 115 passed) and the correct
  complete-evidence rejection after; revert-verified (src/ reverted ⇒
  the same 5 reds return). Gates table, sequence semantics, provider
  seam rules, and `issue` diagnostics updated in docs.
