---
'specgit': patch
---

Docs: release-bot approval and auto-merge policy (#356, #357). The README release section names the version PR's bot-pushed head, the approval its workflow runs need, and the `RELEASE_BOT_TOKEN` remedy. The binding workflows make "enable auto-merge (`gh pr merge --auto --merge`) right after `gh pr ready`" the documented merge policy, with the safety rationale: the SpecGit Acceptance verdict is a required check, so auto-merge fires only when the machine verdict is green — it cannot merge a delivery `finish` would reject.
