# Release Gates — the authoritative definition of done for 1.0.0

This document is the committed definition of what "done" means for SpecGit
1.0.0. It **supersedes the session-local release-order plan** (the gitignored
`.opencode/workflow-reports/` checklists); the vocabulary in §3 is from here on
the only completion authority. Delivered by
[#108](https://github.com/LeXwDeX/SpecGit/issues/108), re-anchored on the
product macro-audit (§4 invariants, §5 release blockers) and the 2026-08-20
user rulings recorded there and on
[the re-anchor comment](https://github.com/LeXwDeX/SpecGit/issues/108#issuecomment-5356359065).

Language follows [README.md](../README.md) and [docs/cli.md](cli.md); the
versioned platform contract is [docs/baseline-v1.md](baseline-v1.md).

## 1. The invariant core (I0–I5)

Provider-neutral and falsifiable: each invariant names the observation that
would refute it, so it holds for the GitHub port today and the GitLab port per
the [Phase-2 roadmap](gitlab-support.md) without re-derivation. Every ticket in
this repository serves at least one invariant or one of the four seams —
**git facts** (local git), **forge evidence** (the authenticated provider CLI),
**delivery record** (the committed binding), **harness environment** (generated
workflow and agent surface) — see the growth discipline in §5.

| Invariant | Statement | Falsifier (what would refute it) | Status |
| --- | --- | --- | --- |
| **I0 exit-code contract** | Every command exits `0` (success / accepted), `1` (rejected, with complete evidence), `2` (usage error), `3` (fail-closed unknown — no verdict possible), or `130` (interrupt; outside the `--json` envelope). `1` vs `3` is contractual. | Any run with incomplete evidence exiting `1`, or reporting `accepted` on a non-zero exit, on any provider port. | Holds; exit-1 "complete evidence" is bounded by I3b below |
| **I1 binding closure** | One issue carries one independently verifiable WHY; one delivery binds N issues to one PR whose closing references close them all; a delivery is done if and only if `specgit finish` exits `0`. | An accepted delivery whose merge leaves a bound issue open, or closes an issue that was never bound. | Holds (forward direction enforced; stance decisions tracked via the growth discipline) |
| **I2 real evidence** | Every gate reads live git and forge facts — branch state, the PR, check runs, issue state; the record is a claim, never truth. | Any gate outcome decided by the record file where live evidence disagrees. | Holds |
| **I3 fail-closed, both branches** | **I3a (errors):** any failure to gather evidence degrades the verdict to `unknown` / exit `3`, never `accepted`. **I3b (silent incompleteness):** every list-shaped evidence input is paginated to exhaustion or signals truncation and degrades the verdict to exit `3` — a truncated list is unknown evidence, not a pass. | Missing or truncated evidence producing exit `1` ("complete evidence") or `accepted`. | I3a implemented and e2e-pinned; **I3b is being implemented by [#120](https://github.com/LeXwDeX/SpecGit/issues/120)** |
| **I4 idempotent resume** | Re-running any bootstrap/resume command converges on the same delivery — same issues, branch, PR, and record — without duplication. | A resume that forks a second PR or branch for one delivery, or resurrects a merged one, or adopts an unrelated same-title issue. | Holds in the happy path; post-merge no-args resurrection closed by [#75](https://github.com/LeXwDeX/SpecGit/issues/75) (merged record → `issue_delivery_merged` exit 2, mergedness probe fails closed); same-title adoption corner closed by [#77](https://github.com/LeXwDeX/SpecGit/issues/77) via [#140](https://github.com/LeXwDeX/SpecGit/pull/140) (one title-carrying exhaustive scan, scaffold-body disambiguation, `issue_title_ambiguous` exit 2 on unresolved collisions) |
| **I5 single-record state** | Persistent state is exactly the three file tiers — authoritative committed files (the policy `spec_git/policy.yaml` and the record `.specgit.yaml`), the derived committed harness, and local integration assets; a conflicting or unparseable record fails closed with diagnostics. | State that lives outside the tiers, or a record conflict silently resolved. | Holds |

## 2. Red-line closure checklist (1.0 blockers)

A red-line defect is any situation where `specgit finish` exits `0` but the
evidence says no — or the harness is stillborn for a whole repo class. Four are
open today; **1.0.0 does not ship while any row is open.** Closure = the closing
PR merged behind the SpecGit Acceptance gate, with its evidence link pasted
into the row.

| Blocker | Red-line it closes | Evidence (paste on closure) |
| --- | --- | --- |
| [#119 — unify duplicate check-run semantics](https://github.com/LeXwDeX/SpecGit/issues/119) | Re-run with old-green/new-red: the verdict, the wait step, and the docs each read a different same-name run; acceptance over stale evidence. | _open_ — PR link + merged SHA (+ Actions run URL if runtime-pinned) |
| [#120 — fail closed on silently truncated evidence lists (I3b)](https://github.com/LeXwDeX/SpecGit/issues/120) | >100-item evidence lists truncate silently today; the sequence gate and issue adoption can false-pass on a partial list. | _open_ — PR link + test names pinning paginate-or-exit-3 |
| [#121 — init detection trust boundary](https://github.com/LeXwDeX/SpecGit/issues/121) | Push-filtered and scheduled workflows are detected as required PR checks → permanent `checks_missing`; the "never weaken policy" iron rule then blocks the only correct repair — a stillborn harness. | Closed by [#130](https://github.com/LeXwDeX/SpecGit/pull/130): classification trigger-inclusion (`pull_request`/`pull_request_target` only), init warning `checks_not_pr_visible` + `detected.nonPrWorkflows` (pinned by init tests "classifies by PR trigger … #121"); repair path in [cli.md](cli.md) (detection trust boundary), [reference.md](reference.md) (wrong at birth vs weakening), [troubleshooting.md](troubleshooting.md) (`checks_missing`) |
| [#122 — draft PR state is a verdict dimension](https://github.com/LeXwDeX/SpecGit/issues/122) | A draft PR (platform-level unmergeable) can be accepted as done and never re-verdicts on ready-for-review. | _open_ — PR link + updated gate table in [reference.md](reference.md) |

## 3. The GA five gates — the only completion vocabulary

The G-FINAL wording of the superseded session-local plan is subsumed by this
list. Nothing outside it counts as "done for 1.0.0".

1. **Issue tracker empty** — the issue tracker holds zero open issues: every
   WHY is delivered or explicitly disposed.
2. **Zero review residue** — no review observation without a recorded
   disposition.
3. **No undisposed red in CI** — every red or semantics-ambiguous check
   (green-by-skip included) carries an owner and a disposition.
4. **RC dogfood** — rc dogfood `specgit finish` exits `0` on a real
   nested-group GitLab delivery (or the user-revised wording of this gate).
5. **Evidence archived** — every condition above is met with
   **archived evidence** per §4 (the archive table there is the record).

## 4. Evidence protocol and the gate-7 binding

Every condition names where its proof lives before it can be claimed:

- **Machine verdicts** — `specgit finish` exit code at a named commit; proof =
  the command + commit SHA (the merged PR records both).
- **CI states** — GitHub Actions run URLs (never screenshots or prose claims).
- **Releases** — the git tag and its GitHub Release link.

**Gate-7 protocol** (decided 2026-08-20): when the tracker is empty there is no
live delivery to finish, so the final acceptance verdict is a
`workflow_dispatch` run of the acceptance workflow
([.github/workflows/specgit-accept.yml](../.github/workflows/specgit-accept.yml))
**on the release tag** `v1.0.0`; its run URL is archived below. The workflow
already carries the `workflow_dispatch` trigger for exactly this purpose.

Archive (filled at the 1.0.0 cut; entries are immutable once written —
superseding one requires an explicit edit with rationale):

| Gate | Evidence slot |
| --- | --- |
| GA-1 tracker empty | `gh issue list --state open` = 0 at commit `________` |
| GA-2 zero review residue | disposition map at `________` |
| GA-3 no undisposed red in CI | CI rollup run `________` |
| GA-4 rc dogfood (nested-group GitLab) | `specgit finish` exit 0, PR/run `________` |
| GA-5 evidence archived | this table complete |
| Gate-7 | acceptance `workflow_dispatch` run on tag `v1.0.0`: `________` |

## 5. Growth discipline

Every new ticket cites the invariant (I0–I5) or the seam (git facts · forge
evidence · delivery record · harness environment) it serves. A ticket citing
neither gets an explicit **accept-or-defer** ruling before work starts — growth
is chosen, not accumulated. First exercised:
[#118](https://github.com/LeXwDeX/SpecGit/issues/118) (scaffolding language
configurability) — ruled deferred-to-last, 2026-08-20.

## 6. Known CI dispositions

Gate 3 requires every red or semantics-ambiguous check — green-by-skip
included — to carry an owner and a recorded disposition; this table is that
record for the checks that live outside a delivery PR's own gates. A row
leaves the table only when its disposition resolves (the check turns green
and stays green, or the exemption is lifted) — never by silent edit. The
Nix job's path-filter skip is self-documenting in-workflow (the
`required-checks` job prints it; green-when-run proven by
[#85](https://github.com/LeXwDeX/SpecGit/issues/85)).

| Check | Where it shows | Disposition (owner · terms) |
| --- | --- | --- |
| `Test (self-hosted-linux)` | CI · main pushes | Red on main runs. Infrastructure-side root cause and manual runner-container actions recorded on [#105](https://github.com/LeXwDeX/SpecGit/issues/105); terms: retirement line = end of W2 without two consecutive green main runs of this leg. |
| Version-PR auto-merge | Release workflow | Armed off ([#102](https://github.com/LeXwDeX/SpecGit/pull/102)): zero `--auto` occurrences on main; every version PR is the manual batch-decision point. The re-arm decision is re-evaluated after 1.0.0 ships (user ruling 2026-08-20; [#107](https://github.com/LeXwDeX/SpecGit/issues/107)). |
| GitHub Advanced Security (dynamic) | PR branches only, never main | Exempt-with-rationale ([#109](https://github.com/LeXwDeX/SpecGit/issues/109)): GitHub-side GHAS agent whose session creation fails on a provider model-entitlement 400 (`claude-opus-4.6`), not repo-fixable, not a required check; optional owner escalations recorded on the issue. |
| `Validate Release Tracking` | CI | Event-gated: runs only on `pull_request` and `merge_group` — never on `push` or `workflow_dispatch` — so it is skipped on main-push runs **by design**. Its green predicate is read on the delivery or version PR / merge-group run at the threshold, never on a bare main-push run. When it runs it is green either way: with changed `.changeset/*.md` it validates them (`changeset status --since=origin/main`); without changes it reports the normal release cadence ([#110](https://github.com/LeXwDeX/SpecGit/issues/110)). |
