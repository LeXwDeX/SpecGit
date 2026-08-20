# GitLab provider fixtures (recorded evidence payloads)

Redacted API response payloads recorded from a self-managed **GitLab 19.2.4 CE**
instance on 2026-08-20, part of the GitLab evidence-gate delivery
(#93–#100; ledger: [`docs/evidence/gitlab-19.2.md`](../../../docs/evidence/gitlab-19.2.md)).
They are data only — the `GlabProvider` contract tests
(#114, [`test/specgit/glab-provider.test.ts`](../../specgit/glab-provider.test.ts))
build their scripted-glab payloads on these shapes (iid/state/draft/source_branch/
sha/description, job status/allow_failure/started_at, project
`only_allow_merge_if_pipeline_succeeds`/`path_with_namespace`, metadata
version/revision/enterprise), and since #117 the offline GitLab e2e
([`test/specgit-e2e/gitlab-delivery.e2e.test.ts`](../gitlab-delivery.e2e.test.ts))
drives its fake-glab rule tables from these files directly — cloning the
recorded shapes and pinning the local delivery state (shas, branches,
iids) onto them.

## Provenance

| Directory | Source | Method |
| --- | --- | --- |
| `nested/` | Real 3-segment nested-group project `…/group/subgroup/project` (the #95 nested-origin reproducer; project id 1278) | Read-only `glab api` GETs (`metadata`, project, issues, merge request list/detail, pipelines list/detail, pipeline jobs, job detail) |
| `probe-project/` | Disposable probe project `specgit-evidence-probe-*` (created fresh for the probe, deleted after; `tp_*` files are its job-token-probe pipeline) | Same read-only GETs after the probe completed |

Notable evidence content: a 7-job Auto-DevOps pipeline mixing hard-failed,
`allow_failure`-failed, and `skipped` jobs (the `allow_failure`/skip mapping
surface); a `Draft:`-prefixed merge request (`draft: true`,
`work_in_progress: true`); an opened issue; `detailed_merge_status` values
(`checking`, `not_open`); pipeline `id` vs project-scoped `iid` fields.

## Redaction

Two deterministic passes, in order:

1. **Bundle pass (G6 probe block)** — user objects neutralized
   (`username`/`name`/emails/avatars/URLs → `REDACTED_*`), token patterns and
   long secret-looking strings scrubbed (`<REDACTED_SECRET>`,
   `<REDACTED_JWT>`, `<REDACTED_TOKEN>`); this is why some URL path
   components appear as `<REDACTED_SECRET>`.
2. **Commit pass (this repository)** — fields the first pass did not cover:
   commit `author_name`/`committer_name` → `REDACTED_NAME`,
   `author_email`/`committer_email` → `REDACTED_EMAIL`, profile `location` →
   `REDACTED_LOCATION`, `local_time` → `null`, and any free-text string
   containing Han script (titles, descriptions, commit messages) →
   `REDACTED_TEXT`. No usernames, personal names, emails, tokens, or
   organizational free text remain; the `git.ycgame.com` host and structural
   ids/paths survive because the evidence requires them (the host and
   project paths are already part of the public delivery record).

Capture logs were not committed (data only).
