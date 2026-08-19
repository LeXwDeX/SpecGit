---
"specgit": minor
---

### Platform-mode model for GitHub and GitLab

Self-hosted GitLab origins (git.ycgame.com, git.corp.example, …) are no
longer misclassified as generic `origin_unresolvable`:

- `specgit init` resolves a platform mode: a `github.com` origin defaults
  to GitHub; any other origin asks on an interactive terminal (GitHub or
  GitLab) or is declared explicitly with `--gitlab-host <hostname>` (bare
  hostname, validated against the origin host).
- The declaration persists in `spec_git/providers.yaml`
  (`gitlab.host`, `gitlab.insecure_ssl` for self-signed certificates) —
  committed to the repository, shared by the whole team.
- `parseRepoRef`, the acceptance evaluator, `doctor`, and `status` all
  consult the declared host: matching origins report the dedicated
  `gitlab_unsupported` diagnostic (the glab-provider roadmap stays in
  docs/gitlab-support.md); everything else keeps `origin_unresolvable`.
- Evidence providers remain the official CLIs only — `gh` for GitHub,
  `glab` for GitLab (once implemented); no third-party API clients.
- The `--json` envelope gains a `platform` section
  (`{ mode: github | gitlab | undecided, gitlabHost? }`), and an undeclared
  non-github origin warns `platform_undecided`.
