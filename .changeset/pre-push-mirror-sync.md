---
"specgit": patch
---

The git pre-push guard no longer blocks post-release mirror sync: a push of a commit that is already contained by `origin/main` (PR-merged, CI-green, released history) is allowed through, while a direct push of an unmerged tip to `main` stays blocked. Legacy unmarked pre-push guards from any earlier generation are now upgraded by signature line instead of byte-equality with one frozen body, so `init --force` converges them instead of double-guarding.
