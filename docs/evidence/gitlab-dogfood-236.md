# Rebaseline dogfood evidence — real GitLab 19.3.0 delivery (#236)

The Rebaseline SOP step-3 witness: one real probe delivery on the new target
version whose `specgit finish` exits 0. Executed 2026-08-22 on
`git.ycgame.com` (**19.3.0 CE**, `enterprise: false`, revision
`2c30df7828b` — outside the old window `>= 19.2.4 < 19.3.0`, inside the
widened `>= 19.2.4 < 19.4.0`) with **glab 1.113.0** (gitlab-org/cli tag
`v1.113.0`, commit `d6288130`). Unlike the isolated disposable probe of
[gitlab-dogfood-117.md](gitlab-dogfood-117.md), this is the operator's real
delivery (already merged and released); the committed envelope below is the
durable record.

## The delivery

| Fact | Value |
| --- | --- |
| Project (depth-3 nested group) | `ycgame/General-Framework-Background-Operations/main_art-ai` (project id 1278) |
| Issue | `#2` — closed by MR auto-close on merge |
| Merge request | `!2` — merged into `main` (merge commit `2902ee3`); MR head `39a8c8cb55757f50bd8ed1e8ba3c3466645f85bd` |
| Delivery branch | `feat/2-issue2` (branch-context record) |
| Record repair | `specgit pr 2` bound the missing `pr: 2` (the binding commit `c5fea9e` never reached `main`) |
| Policy | `required_checks: []` |
| Platform declaration | `spec_git/providers.yaml`: `gitlab.host: git.ycgame.com` |
| CLI under test | the #236 build (window `>= 19.2.4 < 19.4.0`; package version 1.1.1 pre-bump) |

## The verdict (`specgit finish --json`, exit 0)

Before the rebaseline the same command failed closed with
`gitlab_version_unsupported` (exit 3) at preflight. After widening the
window, every gate passes against the live 19.3.0 instance:

```json
{
  "tool": "specgit",
  "command": "finish",
  "status": "ok",
  "exit": 0,
  "state": "accepted",
  "verdict": {
    "accepted": true,
    "classification": "accepted",
    "exitCode": 0,
    "complete": true,
    "gates": [
      { "id": "record", "status": "pass" },
      { "id": "policy", "status": "pass" },
      { "id": "completeness", "status": "pass" },
      { "id": "context", "status": "pass" },
      { "id": "origin", "status": "pass" },
      { "id": "provider", "status": "pass" },
      { "id": "issues", "status": "pass" },
      { "id": "sequence", "status": "pass" },
      { "id": "pr", "status": "pass" },
      { "id": "closing", "status": "pass" },
      { "id": "checks", "status": "pass" }
    ],
    "evidence": {
      "repo": "ycgame/General-Framework-Background-Operations/main_art-ai",
      "delivery": "issue2",
      "branch": "feat/2-issue2",
      "headSha": "c5fea9ef545522f40679b1039ac867ac9531878c",
      "dirty": false,
      "upstreamDrift": { "behind": 0, "ahead": 0 },
      "context": { "kind": "branch" },
      "issues": [2],
      "pr": 2,
      "prHead": "39a8c8cb55757f50bd8ed1e8ba3c3466645f85bd"
    },
    "warnings": [
      {
        "severity": "warning",
        "code": "local_head_stale",
        "message": "The local HEAD is not the PR head; acceptance is about the PR."
      }
    ]
  }
}
```

The single warning is informational (the binding commit sits on the delivery
branch, not on the merged MR head); acceptance evaluates the PR, so the
verdict stands. The evidence pass exercised the live 19.3.0 surfaces behind
every gate — metadata (preflight), issue state, MR detail/state, closing
references, and the pipeline/jobs witness read — with no recorded shape
changing versus the 19.2 fixtures (ledger row 4).
