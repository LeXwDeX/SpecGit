---
"specgit": patch
---

### CI dispositions recorded; auto-merge re-arm re-scoped to after 1.0.0

Adds the "Known CI dispositions" section to `docs/release-gates.md` — the
gate-3 record for checks that live outside a delivery PR's own gates: the
self-hosted-linux leg (#105, retirement line), the version-PR auto-merge
arm-off (#107), the GHAS dynamic-workflow exemption (#109), and Validate
Release Tracking's event-gate semantics (#110: runs only on `pull_request`
and `merge_group`, skipped on main-push runs by design; its green predicate
is read on the PR or merge-group run at the threshold). The re-arm comment
in `release-prepare.yml` now names the actual decision — re-evaluated after
1.0.0 ships (user ruling 2026-08-20) — replacing the satisfied-but-unmet
rc.1 condition. Both changes are pinned red-first in
`test/specgit/release-gates.test.ts` and `test/docs-consistency.test.ts`.
