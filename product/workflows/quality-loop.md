# Product Quality Loop

This loop applies to product changes. Documentation-only and manual
project-guidance changes use the [documentation short path](../docs/ci-scope.md#documentation-short-path)
and finish after one relevant review and lightweight validation. They do not
enter the review rounds or spawn the review agents described below.

```text
  fast rounds (per slice): REVIEW -> findings -> FIX -> targeted gates
        |
        v
  one full two-axis review (standards + spec) -> disposition every finding
        |
        v
  four clean criteria hold -> PR/MR ready -> specgit finish
         |-- exit 0 --> enabled specgit pr --merge (all CI + target match)
         |             -> confirmed merge -> configured bound issue closure
         |             -> authorized release when a changeset declares intent
         |             -> next specgit issue (replaces the completed
         |                record atomically, #351)
         '-- exit 1/3 -> back to FIX; never weaken a gate to pass
```

The pre-merge quality loop for a delivery branch. It nests inside
[specgit-dev-loop.md](specgit-dev-loop.md): it starts where a slice's applicable
local gates go green and ends after the authorized merge. A package release
continues only with explicit release intent. Local installation, upgrades and
init/setup refreshes with no intended tracked delivery do not enter this loop.
[CI scope](../docs/ci-scope.md) defines the required verification per change class.

**Standing principle: the harness is the product.** Every review weighs findings in this order — product usage
first, harness contract second, architecture third, code last.
Architecture and code exist to serve *spec bound to git, verified
through the harness*; a finding at a higher layer always outranks a
defence mounted at a lower one.

## Trigger

An **event**, never a schedule. Any one of these fires a loop run:

1. New commits landed on the delivery branch AND the applicable local gate set
   is green for a product change. CI is not waited for — the review
   axes need only the diff; CI green is a merge gate, not a review
   gate.
2. CI red after a push (the DEBUG discipline below).

## Clean — the definition of "no findings"

The loop may converge only when ALL four hold. Anything less is not
clean, no matter how many rounds ran:

1. **Full two-axis review, zero hard findings** — Standards axis and
   Spec axis, run as parallel sub-agents over the whole diff against
   the merge-base with `main`.
2. **Every judgement call dispositioned** — each is either fixed, or
   deferred with a one-line reason recorded in the PR body's
   `Deferred` section. Deferred is a decision, not an oversight.
3. **Applicable local gate set green** — product changes require build, both
   typechecks, lint and full tests; metadata-only changes require the lightweight
   checks in [CI scope](../docs/ci-scope.md).
4. **Required CI green at the current PR head** and `specgit finish` exits 0 — the
   harness verdict is the outermost gate and is never bypassed or
   weakened to make it pass.

## The loop

Two review tiers, in order:

1. **Fast review** — a quick pass over the changes since the last
   review round (first round: all commits on the branch). Findings
   are fixed immediately, lightweight: direct edits, run the
   affected tests, then the applicable local gate set before pushing, then
   fast-review again. No TDD red-green ritual inside the loop — the
   delivery's own slices already proved the behaviour; the loop
   proves the changes didn't break their neighbours.
2. **Full code review** — when a fast round finds nothing, run one
   two-axis review over the **whole diff**. Hard findings go back to
   step 1 (fix, fast-review to convergence, then another full
   review). A clean full review satisfying all four clean-criteria
   exits the loop.

### The two axes and their report contract

Both sub-agents return one report of at most 400 words, shaped so
the briefs can be assembled mechanically from them. Every report
ends with a one-line `worst: <finding>` summary. The escalation and
final briefs are composed from the two reports without rewriting
their judgements.

- **Spec axis (runs first in priority, per the standing principle).**
  The sub-agent verifies the diff serves the bound issue's WHY,
  reporting findings grouped by four layers, highest first:
  1. *Product usage* — does the change make the documented user
     story truer? For product changes the sub-agent **runs the product**, not just
     reads: the README quick-start fragment touched by the diff,
     exercised through the built CLI (`node bin/specgit.js …`) in
     this repository's real environment. Boundary: no sandboxed
     adopting-repo construction here — that scenario is owned by
     the e2e suites inside `pnpm test`; the loop never rebuilds
     what the suites already prove. A finding at this layer needs
     **two pieces of evidence** — the documented promise
     (file:line) and the observed run (command + the output line
     that disagrees) — to count as hard; a single piece makes it a
     judgement call. Metadata-only reviews inspect the relevant documents/data
     and run their lightweight checks; they do not build the product to review
     prose. Generated template source remains product code even when its output
     is Markdown or a local hook.
  2. *Harness contract* — the eleven gates, exit-code semantics,
     fail-closed rules, the `--json` envelope. Weakening, bypassing,
     or reconfiguring the harness to make a verdict pass is never
     acceptable — this layer is non-negotiable.
  3. *Architecture* — ports/adapters discipline, module boundaries:
     only insofar as they serve the evidence flow.
  4. *Code* — repo conventions; a Fowler-smell baseline as judgement
     calls only.
- **Standards axis.** The documented repo standards (AGENTS.md,
  CONTRIBUTING.md, test/AGENTS.md, docs) plus the smell baseline.
  Findings grouped per file/hunk; every finding labelled `hard`
  (citing the standard's file and rule) or `judgement` (quoting the
  hunk). Tool-enforced matters are skipped.

### Caps and the escalation brief (push right)

At most **3 fast rounds** between full reviews, at most **2 full
reviews** per loop run. A cap breach is fail-closed: the loop stops,
no merge. If existing user authorization covers a bounded extension or
deferral, apply it and record the decision; otherwise present the missing
decision with everything prepared. The escalation brief contains:

- Rounds spent per tier; which cap broke.
- Every unresolved finding, each already dispositioned into one of
  the decision options below.
- The clean-criteria checklist showing exactly which of the four
  still fails.

The decision resolves one of these paths:

1. **Grant more rounds** — one bounded extension (e.g. one more full
   review + its fast rounds), with a stated reason.
2. **Defer findings** — each unresolved finding becomes a tracker
   issue; the loop re-enters with them recorded in the PR body's
   `Deferred` section.
3. **Abandon the delivery** — close the PR, record why in the final
   brief, unbind.

Silent convergence is never faked; neither is an unbounded loop.

### DEBUG discipline

CI red after local green: reproduce locally first. Fix and verify a locally
reproducible failure before another push. A transient failure gets one
authenticated CLI retry before investigation. Use existing delivery
authorization for repairs and retries; if the platform requires a permission
the current session lacks, report that specific blocker. Every CI result is
a merge input, including Windows jobs.

## Merge and release (the merge licence, not a checkpoint)

1. Complete the authorized PR body and ready transition, wait for CI, and
   run `specgit finish --json`. Exit 0 supplies acceptance; `finish` is
   read-only. Once all four clean criteria hold and automation is enabled,
   continue with `specgit pr --merge --json`. It requires the configured
   target branch and all current-head CI checks to pass, submits the expected
   SHA, and confirms the platform merge before closing bound issues when
   configured. Existing user authorization needs no repeat approval.
2. Automation defaults to no and requires the user's own yes during
   `init --automation yes --merge-target main`; `init --force` preserves the choice unless explicitly changed. Agents cannot answer yes for the user. Platform permissions and
   protection remain binding. After the confirmed merge, the record on `main` is
   completed history (#351): the next `specgit issue` replaces it
   atomically — `unbind` is only for abandoning or resetting, never the
   post-merge step.
3. A release with explicit release intent follows
   [release guidance](../docs/ci-scope.md#required-verification):
   the delivery PR carries a changeset, merging it creates or updates the
   generated version PR, normal CI and configured merge automation gate that
   PR, and registry, tag, and GitHub Release evidence confirm publication.

## Final brief

One brief closes the run: rounds per tier, every finding with its
disposition (fixed / deferred + reason, linked from the PR body),
the `specgit finish` exit code, and, only when publication was part of the
authorized scope, the published version with its npm check. Fail-closed runs present the same brief with the
unresolved findings at top.

Terminal ready-PR CI or acceptance failures are tracked by repair issues, one
per independently verifiable cause. Reuse an open repair issue for a recurring
cause. Keep the original business issues open until the merged delivery is
confirmed; a red check does not automatically abandon its branch or PR. Drafts,
pending checks, and superseded heads do not create failure work.
