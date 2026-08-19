---
"specgit": minor
---

### Merged-delivery lifecycle

- `specgit finish` on a merged delivery's record (e.g. on main after the PR merged) now returns **accepted** with a `record_of_merged_delivery` warning suggesting `specgit unbind --yes` — previously it mis-reported `branch_mismatch`. The merge is verified against PR evidence; a provider failure keeps the fail-closed mismatch.
- `specgit issue` replaces a merged-delivery record automatically instead of failing with `issue_resume_drift` until a manual unbind — the merge is verified the same fail-closed way.
