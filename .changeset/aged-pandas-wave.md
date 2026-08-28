---
'specgit': minor
---

Completed lifecycle state for merged delivery records (#351). `specgit finish` on a trunk that already merged the delivery now reports `state: "completed"` (exit 0 unchanged) instead of `accepted`, and the `record_of_merged_delivery` warning points at the next delivery — `specgit issue "<type>: <title>"` atomically replaces the record — instead of advising `unbind`. `specgit status` reports `state: "historical-candidate"` with the warning `record_historical_candidate` when the record is tracked on a branch other than its recorded context (the local signature of merged history), never `bound` + silent `branch_mismatch` contradiction. `unbind` is repositioned in docs and copy as the abandon/reset/uninstall tool, not the post-merge step; the workflow guides' merge step is now "merge → next `specgit issue`".
