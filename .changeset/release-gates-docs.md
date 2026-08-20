---
"specgit": patch
---

### Release gates committed: invariant core, red-line closure list, GA completion vocabulary

Documents the 1.0.0 definition of done in `docs/release-gates.md` (#108),
superseding the session-local release-order plan. The document carries the
provider-neutral, falsifiable invariant core I0–I5 (I3a implemented; I3b in
flight via #120), the red-line closure checklist for the four 1.0 blockers
(#119 duplicate check-run semantics, #120 evidence completeness, #121 detection
trust boundary, #122 draft verdict dimension) with evidence slots, the GA five
gates as the only authoritative completion vocabulary (G-FINAL subsumed), the
gate-7 protocol (`workflow_dispatch` acceptance run on the release tag, run
URL archived), and the growth discipline (every ticket cites an invariant or a
seam; otherwise an explicit accept-or-defer — first exercised by #118,
deferred-to-last).

Riding the same slice, per the wave brief:

- **F-1 micro docs fix**: `AGENTS.md` and `docs/baseline-v1.md` no longer
  assert a GitHub-only v1 scope; both now carry the incremental dual-platform
  narrative ratified in `docs/gitlab-support.md` (D-1=A).
- **PR template time bomb defused**: `.github/PULL_REQUEST_TEMPLATE.md` no
  longer carries the literal `Closes #123` — the placeholder is now
  `Closes #<issue-number>`, so an unedited template can never auto-close a
  real issue.
- `test/docs-consistency.test.ts` pins all of the above (red-first: all four
  assertions failed on the pre-change tree).
