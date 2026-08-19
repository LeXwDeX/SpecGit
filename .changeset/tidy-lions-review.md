---
"specgit": patch
---

### Review findings addressed

- `specgit init` interactive prompts (platform select, protection confirm)
  render to stderr, keeping the `--json` stdout contract (exactly one JSON
  document) intact on interactive terminals.
- `--gitlab-host` on a github.com origin is rejected (`gitlab_host_invalid`)
  instead of silently writing a nonsensical declaration.
- The wiring evaluate wrapper no longer clobbers a caller-supplied
  `gitlabHost`; provider discovery only fills the gap.
- Docs updated for the platform-mode model: `--gitlab-host` in the init flag
  table, the `platform` envelope section, and the `spec_git/providers.yaml`
  schema in the reference.
- Acceptance workflow: `workflow_dispatch` runs now work (the sibling-wait
  SHA falls back to `github.sha`); the dead bootstrap step on the hosted job
  is removed; the CI bootstrap condition keys on the stable
  `matrix.label == 'self-hosted-linux'` instead of the runner machine name.
- Tests pin the github.com-rejection branch and suffix-host spoof immunity.
