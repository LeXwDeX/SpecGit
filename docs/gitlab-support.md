# GitLab (glab) Support Roadmap

**v1 scope: GitHub.com only.** SpecGit derives acceptance from GitHub evidence in v1: issues, pull requests, and check runs flow exclusively through the authenticated `gh` CLI ([the provider seam](../src/github/port.ts)). This document is the plan for extending the same evidence model to GitLab through the `glab` CLI.

## Current behavior (deliberate)

A GitLab origin is **recognized, not silently misread**:

- The platform is declared, not guessed: `specgit init --gitlab-host <hostname>` (or the interactive platform question) persists the declaration in `spec_git/providers.yaml`, committed so the team shares it. A `github.com` origin defaults to GitHub with no declaration needed.
- `parseRepoRef` honors the declared host: a matching origin (and `gitlab.com`) fails with `gitlab_unsupported` instead of the generic `origin_unresolvable` — the diagnostic names the actual gap. Undeclared non-github origins stay `origin_unresolvable` with a `platform_undecided` warning.
- `specgit doctor` surfaces `gitlab_unsupported` on the `origin` probe while still probing `gh`, so the report shows both facts.
- `specgit init` already classifies the platform from the origin URL (`github | gitlab | unknown`, no network), reads `.gitlab-ci.yml` job keys when no GitHub workflows exist, and reports `glab` presence on PATH (reported only). Policy generation therefore already works for GitLab CI.

## Design principles

1. **Mirror the seam, do not fork the gates.** Acceptance evaluation
   (record → policy → completeness → context → origin → provider → issues →
   pr → closing → checks) is platform-agnostic. Only evidence *collection*
   is platform-specific.
2. **One CLI per platform, authenticated, no tokens in state or logs.**
   GitHub evidence flows through `gh`; GitLab evidence will flow through
   `glab`. No direct REST clients.
3. **Fail-closed carries over.** Missing glab, unauthenticated glab, or an
   unreachable GitLab yields `unknown`, never `accepted`.

## Phases

### Phase 1 — recognition and diagnostics (shipped)

- Dedicated `gitlab_unsupported` diagnostic for GitLab origins.
- `doctor` reports it; `init` reports platform + glab presence.

### Phase 2 — GlabProvider

Implement `GitLabProvider` mirroring `GitHubProvider`:

| GitHubProvider method | glab equivalent |
| --- | --- |
| `preflight` | `glab auth status` |
| `getIssue` | `glab api projects/:id/issues/:iid` |
| `getPr` | `glab api projects/:id/merge_requests/:iid` |
| `getCheckRuns` | `glab api projects/:id/pipelines` + per-pipeline jobs |
| `createIssue` | `glab api projects/:id/issues -f ...` |
| `createDraftPr` | `glab mr create --draft` (GitLab: WIP/draft MRs) |
| `listOpenPrsByHead` | `glab mr list --source-branch` |
| protection/automerge | protected branches + merge checks API |

Selection rule: `classifyPlatform(originUrl)` picks the provider at wiring
time; `unknown` platforms stay on the GitHub path and fail closed at the
origin gate exactly as today.

Check-run mapping: a GitLab pipeline job maps to a check whose name is the
job name; `policy.required_checks` continues to hold exact names discovered
from `.gitlab-ci.yml`, so `spec_git/policy.yaml` stays the single contract.

### Phase 3 — parity and harness

- The acceptance workflow template gains a GitLab CI variant running
  `specgit finish` as a pipeline job.
- `specgit issue` bootstrap works against GitLab: draft MR closing keywords
  (`Closes #n`, `Fixes #n`) — GitLab honors the same closing syntax.

## Non-goals

- No cross-platform deliveries (one delivery, one platform, one PR/MR).
- No token storage: `glab` owns credentials, same as `gh` today.
