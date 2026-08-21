---
"specgit": minor
---

## GitLab 19.3 rebaseline

- Widen the self-managed GitLab support window from `>= 19.2.4 < 19.3.0`
  to `>= 19.2.4 < 19.4.0` (#236): 19.3 instances such as `git.ycgame.com`
  (19.3.0 CE, probed live) no longer fail closed with
  `gitlab_version_unsupported` (exit 3) at preflight
- Evidence chain: release tag anchor `v19.3.0-ee` @ `8f83039b` (tagged
  2026-08-20, protected), Metadata API shape unchanged at the pinned tag,
  fixtures verified unchanged on the live instance, and one real dogfood
  delivery whose `specgit finish` exited 0 on 19.3.0 — see
  [docs/evidence/gitlab-19.3.md](docs/evidence/gitlab-19.3.md)
- Fake-glab test double now enforces GitLab method routing (#234): known
  paths with unrouted verbs return a GitLab-shaped 404, guarding against
  regressions like the #229 PATCH-vs-PUT bug
