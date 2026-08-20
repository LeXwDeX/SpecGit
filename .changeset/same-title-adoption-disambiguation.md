---
"specgit": patch
---

### Same-title adoption: title-carrying scan, scaffold disambiguation, bounded probe cost (#77)

Closes #77. The bootstrap adoption probe — the remotely discoverable
idempotency marker that lets `specgit issue` adopt an issue a previous
run created but failed to record — had three defects in one mechanism:
**trust** (an unrelated pre-existing open issue with the same title was
silently adopted and bound), **coverage** (adoption read titles through
a per-issue `getIssue` fan-out over the open list), and **cost** (every
bootstrap with a pending title argument cost O(open issues) provider
calls). The completeness face (paginate-or-exit-3 across all list
consumers) landed with #120; this delivery closes the adoption face.

- New required port member `getOpenIssues` (`OpenIssueFact`: number,
  optional title/body): one paginated title-carrying search — complete
  to exhaustion under the #120 I3b contract, `evidence_truncated` on
  `incomplete_results` or the 1000-result cap — replaces the per-issue
  fan-out. `getOpenIssueNumbers` derives from the same scan: one
  pagination implementation, one completeness contract. Probe cost is
  bounded by pages, not open-issue count; a provider-level call-budget
  test pins it (250 open issues ⇒ 3 search calls, zero per-issue GETs).
- Same-title collisions are disambiguated, never silently adopted: a
  single exact-title open match is adopted; multiple matches resolve to
  a sole candidate carrying the deterministic scaffold body this tool
  writes (the boundary an unrelated human issue does not carry); an
  unresolvable collision is the new usage diagnostic
  `issue_title_ambiguous` (exit 2) listing every candidate, with the fix
  to adopt explicitly by number — zero side effects, never a guess.
- Fail-closed behavior is unchanged and pinned: probe failures pass
  through (exit 3), numeric-only arguments skip the probe, closed
  issues are invisible by construction (the search pins
  `is:issue+is:open`).
- TDD: red first — disambiguation, >100-open-issues adoption beyond the
  first page, and budget pins failed against the silent-`.shift()`
  probe (12 red), then green via the seam change; the existing
  exactly-once fault-injection suite (lost durability, title drift,
  PR adoption, zero-side-effect drift refusals) migrated to the new
  seam and passes unchanged in behavior.
