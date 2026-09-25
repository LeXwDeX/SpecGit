# Team Workflow

Select complete Issues, preview and apply their association through `specgit issue`, then implement, verify, commit and push. Preview and create or adopt the request with `specgit pr`. Preserve every closing reference.

After the request is pushed, prepare it for review with `specgit pr --ready --request <id> --json` under existing authorization. Review and merge happen on GitHub or GitLab; bounded `specgit watch` only observes current evidence. After the platform reports a merge, re-read the native request and Issue state with `specgit pr --status --request <id> --json`. Exit zero means the read succeeded, not that delivery is complete. See [repository CI scope](https://github.com/LeXwDeX/SpecGit/blob/main/docs/ci-scope.md).
