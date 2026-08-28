---
"specgit": minor
---

`specgit issue` now refuses to bind a new delivery under a stale harness: before any forge contact, a fast local probe compares the repository's generated assets against what the running CLI would generate, and proven drift (stale, conflicting, or partially present) exits 2 with `harness_stale` naming `specgit init --force`. Fresh adopts (no assets yet) and uninspectable environments proceed unchanged.
