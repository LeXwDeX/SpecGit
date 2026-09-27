# Team Workflow

Inspect duplicate WHYs and select complete Issues before implementation. Verify, commit and push real changes. Replace the example IDs below with native IDs. Every write needs existing scope-specific authorization; a preview grants none.

```sh
specgit issue 21 22 --dry-run --json
specgit issue 21 22 --json
# Implement, verify, commit and push actual changes before creating a request.
specgit pr --title 'feat: implement selected specs' --body-file request.md --dry-run --json
specgit pr --title 'feat: implement selected specs' --body-file request.md --json
specgit pr --status --request 42 --json
specgit pr --ready --request 42 --dry-run --json
specgit pr --ready --request 42 --json
specgit watch --request 42 --session task-42 --goal lifecycle --timeout-seconds 300 --json
specgit pr --status --request 42 --json
```

Mark a draft ready only after review preparation. The forge manages CI, approvals and merge. A watch timeout does not complete delivery; resume using the same session. `--goal checks` covers observed checks only, not merge or Issue closure. After merge, verify every associated Issue.

Use explicit `pr --status --request <id>` for cross-branch reads; watch stays worktree-bound. Each project owns its CI; [SpecGit repository CI](https://github.com/LeXwDeX/SpecGit/blob/main/docs/ci-scope.md) is not a mandatory check list for all users.
