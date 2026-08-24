# Quality Loop — REVIEW → DEBUG → FIX until clean, then merge, then release

The pre-merge quality loop for a delivery branch. It nests inside
[specgit-dev-loop.md](specgit-dev-loop.md): it starts where a slice's local
gates go green and ends after the version is on npm.

**Standing principle ([NOTES](../NOTES.md)): the harness is the
product.** Every review weighs findings in this order — product usage
first, harness contract second, architecture third, code last.
Architecture and code exist to serve *spec bound to git, verified
through the harness*; a finding at a higher layer always outranks a
defence mounted at a lower one.

## Trigger

An **event**, never a schedule. Any one of these fires a loop run:

1. New commits landed on the delivery branch AND the local gate set is
   green (`pnpm exec tsc --noEmit`, `pnpm run typecheck:test`,
   `pnpm run lint`, `pnpm test`). CI is not waited for — the review
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
3. **Local gate set green** — build, both typechecks, lint, full
   tests.
4. **CI green on all platforms** and `specgit finish` exits 0 — the
   harness verdict is the outermost gate and is never bypassed or
   weakened to make it pass.

## The loop

Two review tiers, in order:

1. **Fast review** — a quick pass over the changes since the last
   review round (first round: all commits on the branch). Findings
   are fixed immediately, lightweight: direct edits, run the
   affected tests, then the full local gate set before pushing, then
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
     story truer? The sub-agent **runs the product**, not just
     reads: the README quick-start fragment touched by the diff,
     exercised through the built CLI (`node bin/specgit.js …`) in
     this repository's real environment. Boundary: no sandboxed
     adopting-repo construction here — that scenario is owned by
     the e2e suites inside `pnpm test`; the loop never rebuilds
     what the suites already prove. A finding at this layer needs
     **two pieces of evidence** — the documented promise
     (file:line) and the observed run (command + the output line
     that disagrees) — to count as hard; a single piece makes it a
     judgement call.
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
no merge, and the human is asked exactly once — **late, with
everything prepared**. The escalation brief contains:

- Rounds spent per tier; which cap broke.
- Every unresolved finding, each already dispositioned into one of
  the decision options below.
- The clean-criteria checklist showing exactly which of the four
  still fails.

The human picks one, and only one:

1. **Grant more rounds** — one bounded extension (e.g. one more full
   review + its fast rounds), with a stated reason.
2. **Defer findings** — each unresolved finding becomes a tracker
   issue; the loop re-enters with them recorded in the PR body's
   `Deferred` section.
3. **Abandon the delivery** — close the PR, record why in the final
   brief, unbind.

Silent convergence is never faked; neither is an unbounded loop.

### DEBUG discipline

CI red after local green: reproduce locally first. A locally
reproducible failure is fixed and verified locally before another
push; a flaky failure gets one `gh run rerun --failed` before it is
investigated as real. The Windows job never sets the loop's pace.

## Merge and release (the merge licence, not a checkpoint)

1. All four clean-criteria hold → `gh pr ready` → CI green →
   `specgit finish` — exit 0 is the only merge licence (a gate, not a
   question; never bypassed).
2. `gh pr merge --merge --delete-branch`, then `specgit unbind --yes`.
3. Release follows [CONTRIBUTING.md](../CONTRIBUTING.md) §6: changeset
   PR → version PR → approve the workflow runs → merge →
   `npm view specgit version` confirms publication.

## Final brief

One brief closes the run: rounds per tier, every finding with its
disposition (fixed / deferred + reason, linked from the PR body),
the `specgit finish` exit code, and the published version with its
npm check. Fail-closed runs present the same brief with the
unresolved findings at top.
