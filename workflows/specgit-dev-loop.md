# SpecGit Development Loop

How a delivery-bound issue becomes a merged PR in this repository. The loop
is binding for agents and humans alike; the tracker that drives it is defined
in [docs/agents/issue-tracker.md](../docs/agents/issue-tracker.md).

## Trigger

A **delivery-bound issue** — a GitHub issue on `LeXwDeX/SpecGit`, labeled
`delivery` and assigned for work — starts the loop. Nothing else does: no
verbal requests, no drive-by fixes, no self-filed TODOs.

## Slice discipline (TDD)

Every delivery is cut into slices small enough to be proven individually.
Per slice, in order:

1. **Red** — write a failing test that pins the slice's observable
   behavior. Run it and confirm it fails for the expected reason.
2. **Minimal green** — make the smallest production change that passes the
   failing test. Nothing speculative rides along.
3. **Mutation revert-check** — revert the production change, confirm the
   test fails again, re-apply it. A test that never failed without the fix
   proves nothing.
4. **Targeted checks** — run the slice's focused tests plus
   `pnpm exec tsc --noEmit` and `pnpm run typecheck:test`. The full gate
   set runs at PR time.

## Branch and binding

- `specgit issue "<type>: <title>"...` bootstraps the delivery in one
  command: it creates/reuses the issues, branches as
  `<type>/<first-issue#>-<slug>` (e.g. `feat/123-add-login`; `<type>`
  mirrors the CLI's fixed type whitelist — see
  [docs/cli.md](../docs/cli.md); the title body may be any language
  (#118), and a title that yields no ASCII slug asks for a
  `--delivery <slug>` name instead of inventing one),
  opens the draft PR (body carries `Closes #N` for every bound issue),
  writes the record, commits, and pushes. Re-run the same command to
  resume an interrupted bootstrap; `specgit bind` remains as the
  script alias for record surgery.

## PR and gates

One PR per delivery, targeting `main`. Merge is blocked until every gate is
green at the PR head commit:

- red-green test suite (`pnpm test`)
- `pnpm exec tsc --noEmit` and `pnpm run typecheck:test` (test tree)
- `pnpm run lint`
- CI green — every check named in `spec_git/policy.yaml`

## Push-right: one checkpoint

The single human checkpoint is the **PR brief**, approved once, prepared
only when the gates are green:

- **what** changed — slice-by-slice summary
- **why** — the issue(s) the delivery closes
- **links** — issue(s), PR, CI run at the PR head

No intermediate plan sign-offs, status pings, or approvals before it. After
the brief is approved, do not push decisions upward again.

## Pre-merge quality loop

Between the local gates going green and the merge, the change runs the
quality loop — its **clean** definition (four criteria), two-axis
review with the harness-first principle, capped rounds, and the
cap-breach escalation brief are binding:
[quality-loop.md](quality-loop.md).

## Machine verdict

`specgit finish` is the machine verdict and the only definition of done
(`specgit accept` is the script alias running the same evaluation):

- exit `0` → the human may merge;
- exit `1` → fix exactly what the gates named and re-run;
- exit `3` → evidence is missing; run `specgit doctor`, fix the
  environment, then re-run.

Human merge happens **after** `finish` exits `0` — never instead of it.

## Merge method and lifecycle (the traceability triple)

The delivery triple — branch ↔ issues ↔ PR — must stay mutually navigable
after the merge, so the merge method is pinned:

- **Merge commit only.** Squash and rebase merges are disabled at the
  repository level: squash collapses the branch topology and makes the
  delivery commits untraceable to their branch (the `fix/155` duplicate
  delivery escaped notice exactly because squash hid it).
- **Auto-delete the branch.** `delete_branch_on_merge` is on: once the PR
  merges, the delivery branch is deleted by GitHub; its commits remain
  reachable through the merge commit.
- **Issues close via the scaffold.** The `Closes #n` closing references
  the bootstrap wrote close every bound issue at merge time.
- **Issue-side link.** The bootstrap comments the delivery branch and PR
  number on every bound issue (#160), so the triple is navigable from
  the issue side too — including while the PR is still open.
