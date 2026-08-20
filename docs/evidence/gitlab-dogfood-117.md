# GA-4 dogfood evidence — nested-group GitLab delivery (#117)

The GA gate-4 condition (release-gates §3.4): rc dogfood `specgit finish`
exits `0` on a real nested-group GitLab delivery. Executed 2026-08-21 on
`git.ycgame.com` (**19.2.4 CE**, `enterprise: false`, revision `06e8d813296`
— in the supported window, ledger row 5) as an **isolated disposable
probe** (prefix `specgit-evidence-probe-`), deleted after archival per the
isolation discipline — the URLs below were live at archival time; the
committed artifacts in this file are the durable record.

## The delivery

| Fact | Value |
| --- | --- |
| Project (depth-3 nested group) | `specgit-evidence-probe-20260821/specgit-evidence-probe-20260821-nested/specgit-evidence-probe-20260821-app` (project id 1314; group 1390 → subgroup 1391) |
| Issue | `#1` — `feat: nested-group dogfood delivery`, created by `specgit issue` |
| Merge request | `!1` — created as `Draft:` by `specgit issue`, marked ready via API; description = the deterministic scaffold (`Closes #1`) — https://git.ycgame.com/specgit-evidence-probe-20260821/specgit-evidence-probe-20260821-nested/specgit-evidence-probe-20260821-app/-/merge_requests/1 |
| Delivery branch | `feat/1-nested-group-dogfood` (branch-context record, committed) |
| Head SHA | `9839d096d2d229b3f3a14ccbaa1a7e2dc716baee` |
| Policy | `required_checks: [build-app]` (explicit `--required-check`, excluding the acceptance job — the same self-exclusion semantics as the GitHub harness's `SpecGit Acceptance`) |
| Platform declaration | `spec_git/providers.yaml`: `gitlab.host: git.ycgame.com` |
| CLI under test | the #117 build (routing: `PlatformRoutingProvider` → `GlabProvider`) |

## The verdicts (two independent `specgit finish` runs, both exit 0)

1. **Local verdict** (`specgit finish --json` from a plain clone of the
   delivery branch, authenticated via the operator's `glab` keyring):

   ```json
   {
     "tool": "specgit",
     "command": "finish",
     "status": "ok",
     "state": "accepted",
     "verdict": {
       "classification": "accepted",
       "exitCode": 0,
       "complete": true,
       "evidence": {
         "repo": "specgit-evidence-probe-20260821/specgit-evidence-probe-20260821-nested/specgit-evidence-probe-20260821-app",
         "delivery": "nested-group-dogfood",
         "branch": "feat/1-nested-group-dogfood",
         "headSha": "9839d096d2d229b3f3a14ccbaa1a7e2dc716baee",
         "dirty": false,
         "upstreamDrift": { "behind": 0, "ahead": 0 },
         "context": { "kind": "branch" },
         "issues": [1],
         "pr": 1,
         "prHead": "9839d096d2d229b3f3a14ccbaa1a7e2dc716baee"
       }
     }
   }
   ```
   All eleven gates `pass`: record · policy · completeness · context ·
   origin · provider · issues · sequence · pr · closing · checks. Exit
   code `0`.

2. **CI verdict — FU-5 applied** (the `specgit-acceptance` pipeline job at
   the same head, pipeline
   https://git.ycgame.com/specgit-evidence-probe-20260821/specgit-evidence-probe-20260821-nested/specgit-evidence-probe-20260821-app/-/pipelines/29621,
   job 46852): the job checks out the branch by name (`git checkout
   "$CI_COMMIT_REF_NAME"` — HEAD on the branch for the context gate),
   installs the packed #117 CLI from the committed tarball, installs
   `glab` v1.113.0, authenticates with the **FU-5 read-only project
   access token** (project access token id 167, `scopes: [read_api]`,
   role Developer, expiry 2026-09-20 — supplied as the masked CI variable
   `SPECGIT_GLAB_TOKEN`; the CI-job-token path stays BLOCKED-live-cell per
   ledger row 10b), and runs `npx --no-install specgit finish --json`:
   trace records `"status": "ok"`, `"state": "accepted"`,
   `"classification": "accepted"`, every gate `pass`, job succeeded.
   The sibling required check `build-app` (job 46851) is green in the
   same pipeline.

## Teardown (verified)

Project 1314 deleted — first `DELETE /projects/1314` (202, async), then
the admin `permanently_remove=true` flush once the scheduled rename
landed; verified hard-gone immediately after:

```
$ glab api projects/1314
{"message":"404 Project Not Found"} (HTTP 404)
```

Everything the delivery touched lived inside the project — issue #1,
MR !1, pipelines 29617–29621 with both finish traces, the FU-5 access
token (id 167) and its masked `SPECGIT_GLAB_TOKEN` variable — all gone
with it. The two probe groups (1390, 1391) were deleted next
(`DELETE /groups/…` → 202 each); the instance placed both in
`deletion_scheduled` tombstone state (renamed
`specgit-evidence-probe-20260821-deletion_scheduled-1390/…`, top group
`marked_for_deletion_on 2026-08-20`) — empty, unreachable as
namespaces, awaiting the instance's background deletion worker, which
flushes scheduled tombstones on its own schedule. The local probe clone
was removed after archival.

## What this proves

- The routing seam end to end on real infrastructure: declaration →
  nested-group grammar → `PlatformRoutingProvider` dispatch → glab
  evidence (issue, MR, pipelines→jobs) → eleven-gate verdict.
- The GitLab closing dialect on a real MR description (`Closes #1`
  scaffold — the common subset).
- Checks-gate truth from pipeline jobs (`build-app` success), with the
  acceptance job excluded from the policy (self-reference exclusion).
- FU-5's decided degradation path works in CI: a read-only
  (`read_api`) project access token authenticates glab for the
  evidence-gathering finish — no job-token fabrication, no write scope.
- The bootstrap idempotency note from #114 re-confirmed on GitLab: MR
  creation needs the branch pushed first (`source_branch 不存在`), then
  `specgit issue` resumes and adopts cleanly — and the harness files
  (policy, providers.yaml, hooks) are part of the delivery commit set
  the human pushes (I5: committed state).
