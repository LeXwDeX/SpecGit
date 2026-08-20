---
"specgit": patch
---

### GitLab evidence gates: committed ledger, version-qualified policy, nested-origin diagnostic accuracy

Closes the GitLab evidence-gate delivery (#93–#100). No provider code — the
only production change is a bounded diagnostic fix; everything else is
committed evidence and version-qualified documentation.

- Nested-group GitLab origins (`group/subgroup/project`, depth ≥ 2) on a
  declared host or a `*gitlab*` host now report `gitlab_unsupported` with
  platform-neutral fix text instead of `origin_unresolvable` with
  GitHub-pointing advice (#95). GitHub parsing, suffix-spoof hardening, and
  the explicit-port fail-closed rejection are unchanged.
- New committed evidence ledger `docs/evidence/gitlab-19.2.md`: every GitLab/
  glab behavioral claim pinned to an official anchor (docs.gitlab.com,
  gitlab-org/gitlab @ `v19.2.4-ee`, gitlab-org/cli @ `v1.113.0`) with CE
  applicability, confidence, and status; the unprobed CI-job-token live cell
  is recorded as BLOCKED-live-cell, never invented (#94, #96, #97, #99).
- `docs/gitlab-support.md` rewritten version-qualified: self-managed support
  exactly `>= 19.2.4 < 19.3.0` CE/Free (fail-closed outside; GitLab.com by
  capability probing), the `-ee` channel-marker comparison rule, glab floor
  1.113.0, planned `SPECGIT_GLAB`/`SPECGIT_GLAB_TIMEOUT_MS`, the full
  12-method provider map including `getOpenIssueNumbers`, and the Phase-2
  selection rule — only a `providers.yaml` declaration grants GitLab;
  `classifyPlatform` never grants capability (#100).
- `docs/reference.md` (`gitlab.insecure_ssl` per-host semantics, nested-group
  classification) and `docs/troubleshooting.md` (`gitlab_unsupported`)
  version-qualified against the ledger.
- Redacted GitLab 19.2.4 CE API payload fixtures committed under
  `test/specgit-e2e/fixtures/gitlab/` (data only; two-pass redaction, no
  tokens, no PII) for the future adapter's contract tests (#96).
