---
"specgit": patch
---

### init detection hardening

- Job names containing matrix placeholders (e.g.
  `Unit Tests (${{ matrix.settings.name }})`) never appear in real
  check-runs; detection now falls back to the stable job id instead of
  writing an unmatchable name into `spec_git/policy.yaml`.
- `workflow_dispatch`-only workflows never run on a PR head, so their jobs
  are excluded from detection (a workflow counts when any trigger other
  than `workflow_dispatch` is present; YAML 1.1's boolean-`true` parsing of
  the `on` key is handled).
- Release workflow: when the bot cannot create the version PR, the
  fallback edit only reuses a PR that is still open — a closed one is now
  a hard error instead of silently masking the failure.
