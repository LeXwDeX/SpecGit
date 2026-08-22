---
"specgit": patch
---

Document the `gitlab-mirror` remote as the GitLab live-test and release-sync target in AGENTS.md: GitLab live testing and release syncing go through `git@git.ycgame.com:suntao/specgit.git` (glab-authenticated), and a release counts as done only after `main` and every version tag are pushed to it and verified ([#271](https://github.com/LeXwDeX/SpecGit/issues/271)).
