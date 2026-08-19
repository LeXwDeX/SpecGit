---
"specgit": minor
---

### Init detection: platforms, GitLab CI, --force, --no-detect

- `specgit init` now reports a `detected` JSON section: platform classified from the origin URL (github / gitlab / unknown, no network), the CI files the checks came from, and gh/glab presence on PATH (reported only)
- Required-check discovery extends to `.gitlab-ci.yml` top-level job keys (reserved keys excluded) when no GitHub workflows exist
- `--force` rebuilds `spec_git/policy.yaml` even when it exists (default stays the `policy_exists` usage error)
- `--no-detect` keeps the strict legacy path: without explicit `--required-check` it exits 2 instead of detecting
