# SpecGit Development Loop

For documentation-only or manual project-guidance edits, follow the
[documentation short path](../docs/ci-scope.md#documentation-short-path).
The TDD slices and product quality loop below apply to product changes.

How a delivery-bound issue becomes a merged PR in this repository. The loop
is binding for agents and humans alike; the tracker that drives it is defined
in [docs/agents/issue-tracker.md](../docs/agents/issue-tracker.md).

```text
  specgit issue "<type>: <title>"   one command bootstraps the delivery:
        |                           issues + branch + draft PR (Closes #n)
        |                           + record, committed and pushed
        v
  TDD slices: red -> minimal green -> mutation -> targeted tests + tsc
        |
        v
  push --> CI on the PR head (SpecGit Acceptance runs finish --json)
        |
        v
  gh pr ready <n> -> CI green -> specgit finish --(exit 0)--> accepted
        |                    (exit 1/3: repair and retry)
        v
  enabled specgit pr --merge -> confirmed merge + bound issue closure
        |                     (current head, configured target, all CI)
        v
  next delivery
```

## Trigger

A user-authorized intended tracked product or shared-rule change starts the
loop. Reuse or create its tracker issues with `specgit issue` before implementing
that change; the conversation's agreed scope supplies the issue bodies.
Read-only questions and local CLI installation, upgrade or init/setup refresh
need no binding when no tracked change is intended for delivery. Review their
tracked diffs before deciding to share them. [CI scope](../docs/ci-scope.md)
defines the binding verification classification; ignore rules grant no exemption.

## Slice discipline (TDD)

Behavior-changing deliveries are cut into slices small enough to be proven individually.
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
   set runs at PR time for product changes. Metadata-only changes use lightweight
   validation and review; do not add synthetic tests or build the product solely
   for prose or local entry-point refreshes.

## Branch and binding

- Before bootstrap, prepare one `--body-file` per new issue and a
  `--pr-body-file` when selected body validation or required sections must
  pass at creation.
- `specgit issue "<type>: <title>"...` bootstraps the delivery in one
  command: it creates/reuses the issues, branches as
  `<type>/<first-issue#>-<slug>` (e.g. `feat/123-add-login`; `<type>`
  mirrors the CLI's fixed type whitelist — see
  [docs/cli.md](../docs/cli.md); the title body may be any language
  (#118), and a title that yields no ASCII slug asks for a
  `--delivery <slug>` name instead of inventing one), writes the binding,
  commits and pushes it, opens the draft PR/MR (body carries `Closes #N` for
  every bound issue), then records and pushes the request number. Re-run the
  same command to resume an interrupted bootstrap; `specgit bind` remains as
  the script alias for record surgery.
- When creation-time body rules are disabled, fill each created issue's Why /
  Scope / Approach / Acceptance immediately after bootstrap, then implement.
  Update the PR/MR body with delivered changes and evidence, retaining every
  bound closing reference.

## PR and gates

One PR per delivery, targeting `main`. Select the applicable local checks using
[CI scope](../docs/ci-scope.md). Product changes require:

- red-green test suite (`pnpm test`)
- `pnpm exec tsc --noEmit` and `pnpm run typecheck:test` (test tree)
- `pnpm run lint`
- CI green — every check named in `spec_git/policy.yaml`

Metadata-only changes require lightweight validation instead of installing
project dependencies or compiling. Required CI check names still report a
result for the PR head, and `specgit finish` must pass before any delivery merges.

Mark the PR ready after the final push (`gh pr ready` on GitHub,
`glab mr update <number> --ready` on GitLab); a draft fails the verdict
(`pr_draft`). Follow CI to completion, repair failures or retry a transient
failure within the existing authorization, and run `specgit finish --json`.
With automation enabled, `specgit pr --merge --json` then rechecks acceptance,
the configured target branch, and all CI at the current head before submitting
the merge with that head SHA. Platform protection remains in force.

## Authorization and the PR brief

The **PR brief** records the reviewable result:

- **what** changed — slice-by-slice summary
- **why** — the issue(s) the delivery closes
- **links** — issue(s), PR, CI run at the PR head

Existing user authorization remains valid through issue and PR edits,
readiness, CI repair or retry, acceptance, and the authorized merge. The brief
does not create another approval checkpoint. If authorization or platform
permission is missing, name that gap with the prepared result.

Automation defaults to no. The user must personally choose yes for
`specgit init --automation yes --merge-target main`; an agent cannot answer
on their behalf. `init --force` preserves it unless the user explicitly changes it.
Without enabled automation, `pr --merge` refuses; these workflow instructions
do not enable it or grant platform permissions.

## Pre-merge quality loop

Between the local gates going green and the merge, the change runs the
quality loop — its **clean** definition (four criteria), two-axis
review with the harness-first principle, capped rounds, and the
cap-breach escalation brief are binding:
[quality-loop.md](quality-loop.md).

## Machine verdict

`specgit finish` is the read-only acceptance verdict
(`specgit accept` is the script alias running the same evaluation):

- exit `0` → accepted; continue the authorized merge with configured automation;
- exit `1` → fix exactly what the gates named and re-run;
- exit `3` → evidence is missing; follow the reported `errors[].fix`. Run
  `specgit doctor` only when the failure is one of its git, repository,
  origin, forge-CLI, authentication, or policy probes, then re-run.

`finish` remains read-only. A merge requires its exit `0`; automated merge
also requires all CI checks to pass and the target branch to match policy.
Local maintenance without a delivery ends with its relevant verification;
it does not need a delivery verdict. A merge does not imply a package release:
publication requires explicit release intent under [CI scope](../docs/ci-scope.md).

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
- **Issues close after merge.** The scaffold retains `Closes #n` for every
  bound issue. Configured automation confirms the merge before closing those
  issues explicitly; existing closed issues make a retry idempotent.
- **Issue-side link.** The bootstrap comments the delivery branch and PR
  number on every bound issue (#160), so the triple is navigable from
  the issue side too — including while the PR is still open.

A completed delivery requires a platform-confirmed merge and all bound issues
closed. Terminal failures on a ready PR/MR create repair issues per independent
cause; recurring unresolved causes reuse their repair issue. Keep original
business issues open, preserve the PR and branch, and bind the repair work before
editing. Draft, pending, and superseded evidence are not terminal failures.
