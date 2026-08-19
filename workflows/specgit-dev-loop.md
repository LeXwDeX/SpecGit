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
   `pnpm exec tsc --noEmit`. The full gate set runs at PR time.

## Branch and binding

- `specgit issue "<type>: <title>"...` bootstraps the delivery in one
  command: it creates/reuses the issues, branches as
  `<type>/<first-issue#>-<slug>` (e.g. `feat/123-add-login`; `<type>`
  mirrors the CLI's fixed type whitelist — see
  [docs/cli.md](../docs/cli.md); titles must be English),
  opens the draft PR (body carries `Closes #N` for every bound issue),
  writes the record, commits, and pushes. Re-run the same command to
  resume an interrupted bootstrap; `specgit bind` remains as the
  script alias for record surgery.

## PR and gates

One PR per delivery, targeting `main`. Merge is blocked until every gate is
green at the PR head commit:

- red-green test suite (`pnpm test`)
- `pnpm exec tsc --noEmit`
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

## Machine verdict

`specgit finish` is the machine verdict and the only definition of done
(`specgit accept` is the script alias running the same evaluation):

- exit `0` → the human may merge;
- exit `1` → fix exactly what the gates named and re-run;
- exit `3` → evidence is missing; run `specgit doctor`, fix the
  environment, then re-run.

Human merge happens **after** `finish` exits `0` — never instead of it.
