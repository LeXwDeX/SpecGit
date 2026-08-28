---
'specgit': minor
---

Safe branch-protection default and adoption hand-off on fresh init (#352). The interactive protection confirm now defaults to NO on a fresh adoption — the acceptance harness is not on the default branch yet, and requiring a check no PR can pass locks out non-admin merges; the default flips to YES only once the acceptance workflow is tracked (the adoption PR landed). A fresh init also emits structured `nextActions` in the JSON envelope (`adoption_branch` → `adoption_commit` with `git add -f spec_git/policy.yaml` (the policy is gitignored by default; a plain add silently skips it) → `adoption_pr` → `adoption_protect` (`specgit init --force --protect`) → optional `adoption_setup`), rendered in short form in the human summary, so `init` succeeding hands off how to complete the adoption.
