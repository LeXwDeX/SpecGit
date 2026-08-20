---
"specgit": patch
---

### GlabProvider: the 12-method GitLab mirror (#114)

Implements `GlabProvider` (`src/providers/gitlab/glab-cli.ts`) — the
second `GitHubProvider` adapter, mirroring the gh adapter method-for-method
through the `glab` CLI: per-host auth (`glab auth status --hostname`), every
api call host-scoped, `SPECGIT_GLAB`/`SPECGIT_GLAB_TIMEOUT_MS` honored
(timeout ⇒ `glab_transport`, exit 3), version discovery via
`glab api /metadata` with the `>= 19.2.4 < 19.3.0` self-managed window
(`gitlab_version_unsupported` outside; GitLab.com never version-pinned),
offset pagination to exhaustion with the I3b completeness guard
(`evidence_truncated` at the cap), `createDraftPr` via the REST create with
the `Draft: ` title prefix and `iid`/`web_url` JSON mapping (zero stdout
scraping), `listOpenPrsByHead` via the MR-list `source_branch` filter
(pinned FU-4, ledger row 24 — all 12 map cells now anchored), project
identity verified by `path_with_namespace` against rename redirects (row 5),
and tokens never read, stored, or logged. Read endpoints plus exactly the
four documented write endpoints (issues, merge_requests,
protected_branches, project PATCH). The shared CLI transport (spawn seam,
shebang resolution, sanitization) moved to
`src/providers/cli-spawn.ts`; the GitHub adapter re-exports it unchanged.
Scripted-glab contract tests mirror `gh-provider.test.ts` across all
methods (success / unauthenticated / timeout / bad JSON / pagination >100),
and the provider contract test pins the adapter to
`GITHUB_PROVIDER_MEMBERS`. Not routed: evaluation stays gh-only until the
Phase-2 routing slices (#115/#116) — the `gitlab_unsupported` guard holds.
