# Quality Loop — REVIEW → DEBUG → FIX until clean, then merge, then release

The pre-merge quality loop for a delivery branch. It nests inside
[specgit-dev-loop.md](specgit-dev-loop.md): it starts where a slice's local
gates go green and ends after the version is on npm. Zero human checkpoints;
the loop either converges to a clean review or fails closed.

## Trigger

An **event**, never a schedule: the delivery branch carries new commits and
the local gate set is green (`pnpm exec tsc --noEmit`,
`pnpm run typecheck:test`, `pnpm run lint`, `pnpm test`). CI is not waited
for — the review axes need only the diff; CI green is a merge gate, not a
review gate.

## The loop

Two review tiers, in order:

1. **Fast review** — a quick pass over the changes since the last review
   round (first round: all commits on the branch). Findings are fixed
   immediately, lightweight: direct edits, run the affected tests plus the
   full local gate set, then fast-review again. No TDD red-green ritual
   inside the loop — the delivery's own slices already proved the
   behaviour; the loop proves the changes didn't break their neighbours.
2. **Full code review** — when a fast review round finds nothing, run one
   two-axis `/code-review` over the **whole diff** against the fixed point
   (merge-base with `main` or the user-pinned ref): Standards and Spec as
   parallel sub-agents. Hard findings go back to step 1 (fix, fast-review
   to convergence, then another full review). A clean full review exits
   the loop.

### Exit criteria

- **Hard findings** (documented-standard violations, spec gaps, wrong
  implementations): must reach zero.
- **Judgement calls** (baseline smells, weak items): triaged one by one —
  fix it, or explicitly defer with a one-line reason recorded in the final
  brief. Deferred is a decision, not an oversight.
- **Caps**: at most 3 fast rounds between full reviews, at most 2 full
  reviews total. A cap breach is fail-closed: the loop stops, no merge,
  and the brief lists the unresolved findings. Silent convergence is
  never faked.

### DEBUG discipline

CI red after local green: reproduce locally first. A locally reproducible
failure is fixed and verified locally before another push; a flaky
failure gets one `gh run rerun --failed` before it is investigated as
real. The 8-minute Windows job never sets the loop's pace.

## Merge and release (push-right, zero checkpoints)

1. CI all green → `gh pr ready` → SpecGit Acceptance green →
   `specgit finish` — exit 0 is the only merge licence.
2. `gh pr merge --merge --delete-branch`, then `specgit unbind --yes`.
3. Release follows [CONTRIBUTING.md](../CONTRIBUTING.md) §6: changeset PR
   (bump level by change nature — feat/fix → minor, chore/refactor/
   docs-only → patch) → version PR → approve the workflow runs → merge →
   `npm view specgit version` confirms publication.

## Final brief

One brief closes the run: rounds per tier, every finding with its
disposition (fixed / deferred + reason), the `specgit finish` exit code,
and the published version with its npm check. Fail-closed runs present
the same brief with the unresolved findings at top.
