---
"specgit": minor
---

init's opencode guard hook now also gates file-mutation tool calls: the hooks.json matcher grows from `Bash` to `Bash|Edit|Write`, and the guard script blocks `edit`/`write` calls on a branch with no delivery binding (`.specgit.yaml` recording that branch) — the start gate. Re-running `specgit init --force` upgrades an existing install's matcher in place instead of appending a second guard entry; the generated agent guidance and the `specgit-issue` entry points now bind the issue-first trigger to the decision to start and order bootstrap-time issue-body fill from the conversation before implementation.
