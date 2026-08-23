---
"specgit": minor
---

Converge the three forked copies of the sibling-check wait step into one shared generator (#300): `src/cli/wait-step.ts` now renders the step for both workflow templates (REST for the self template, `gh api` for the external one) and — through the byte-exactness pin — this repository's own live workflow, so transport, retry, and #119 truth-run semantics can never diverge again. The wait step also pages the check-runs listing to exhaustion (`per_page=100` until a short page): on a head with more than 100 check-runs the required names were invisible before and the gate timed out after 15 minutes. The dead `retryAfterHeader` variable is gone.
