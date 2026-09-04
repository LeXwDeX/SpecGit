---
"specgit": patch
---

Wait for current-head CI to settle before finalizing automatic failure or repair issues, preserve the original PR change scope when resuming completion after a merge, and give acceptance enough bounded time for supported sibling CI. Final non-success checks remain blocking, and metadata-only completion never falls back to product compilation.
