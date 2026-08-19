<!-- SpecGit delivery PR: the bound issues below are verified against the PR
     body, the PR head, and required CI by the SpecGit Acceptance gate. -->

## WHY

Closes #123
<!-- Replace #123 with the bound issue number(s), one "Closes #n" line each.
     Required: the acceptance gate fails `closing_refs_incomplete` without
     them. -->

One sentence per issue: the independently verifiable need this delivery
serves.

## What changed

- …
- …

## Evidence

- `specgit finish` on this branch exits `0` (paste the verdict summary or the
  `--json` `status`/`verdict.accepted` fields if non-obvious)
- CI (including SpecGit Acceptance) green at the PR head

## Checklist

- [ ] The PR body closes every bound issue (`Closes #n`)
- [ ] A changeset (`.changeset/*.md`) is included for user-visible changes
- [ ] Docs updated in the same PR where behavior changed
      (README / docs/cli.md / docs/reference.md / docs/baseline-v1.md)
- [ ] No public-contract drift: exit codes, `--json` envelope, command set —
      changes update [docs/baseline-v1.md](../docs/baseline-v1.md) first
- [ ] No secrets, no tokens, no telemetry added
- [ ] `pnpm run lint`, `pnpm exec tsc --noEmit`, `pnpm test` all pass
