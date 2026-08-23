---
"specgit": minor
---

Close the local/CI verdict fork on record repairs (#299): `specgit pr` and `specgit bind` now carry the rewritten record into git on the delivery branch — the same force-staged, pathspec-limited binding commit the bootstrap uses, followed by `git push -u` — so the CI verdict on the PR head reads the same record the local verdict does. A local commit failure exits 3; a push failure downgrades to `record_carry_push_failed` (offline/sandboxed environments stay usable, the warning names the stale-verdict consequence); an off-branch repair skips the carry with `record_carry_skipped` instead of silently forking.
