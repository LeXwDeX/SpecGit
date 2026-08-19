---
"specgit": patch
---

### Harness template sync + retry hardening

- The acceptance-workflow template source now matches the repository's own
  evolved `specgit-accept.yml` (workflow_dispatch trigger, WAIT_SHA fallback
  to `github.sha`, hosted-pool rationale): re-running `specgit init` no
  longer regresses these fixes. An anti-drift test locks the template to
  the repo file byte-for-byte.
- The wait-for-sibling-checks script retries transient check-runs API
  failures (5xx, 429, network errors) with bounded exponential backoff
  (5 attempts, 2s→30s ladder) — a platform blip no longer fails the
  acceptance gate.
