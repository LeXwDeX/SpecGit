# Contributing to SpecGit

Thanks for helping build SpecGit. This repository runs on its own product:
every change is a delivery bound to issues and judged by evidence.

```text
  specgit issue "<type>: <title>"   bootstrap this change as a delivery
        |                           (issues + branch + draft PR + record)
        v
  TDD slices, commit, push --> CI (quality loop: REVIEW -> DEBUG -> FIX)
        |
        v
  gh pr ready <n> -> specgit finish --exit 0--> merge -> release
        '-- exit 1/3 -> fix what the verdict names; never weaken the gate
```

## Getting set up

- **Prerequisites:** Node.js ≥ 20.19, `pnpm` (the only package manager), `git`,
  and `gh` authenticated (`gh auth status`).
- **Install and verify:**

  ```bash
  git clone https://github.com/LeXwDeX/SpecGit.git
  cd SpecGit
  pnpm install
  pnpm run build
  pnpm test
  ```

- **Everyday checks:** `pnpm run lint` (ESLint over `src/`), `pnpm exec tsc
  --noEmit` (typecheck), `pnpm test` (Vitest, single run). CI runs all of
  these plus the SpecGit Acceptance gate; a PR is not done until they are
  green.

## How changes happen (the delivery workflow)

This repo dogfoods SpecGit — you will use it to change it:

1. **Check for duplicates first.** Before proposing work, search the
   [issue tracker](https://github.com/LeXwDeX/SpecGit/issues) for an open
   issue covering the same WHY. Continue that issue instead of opening a new
   one; when unsure, ask.
2. **One issue = one independently verifiable WHY.** If a deliverable cannot
   be verified on its own evidence, split it before binding.
3. **Bootstrap the delivery:**

   ```bash
   specgit issue "feat: <english title>"
   ```

   This creates the issue, the branch, the draft PR (with `Closes #n`), and
   the record; re-running resumes.
4. **Work in slices.** Commit early, push often; CI — including SpecGit
   Acceptance — runs on every push.
5. **Gate on the verdict.** `specgit finish` must exit `0` before you request
   review/merge. If it names failures, fix the delivery, not the gate: never
   weaken `spec_git/policy.yaml` or edit `.specgit.yaml` to flip a verdict.
6. **Every user-visible PR carries a changeset.** Run `pnpm exec changeset`
   and commit the `.changeset/*.md` file with your change. Releases are
   version-PR based; a PR without a changeset ships nothing.

## What we look for in reviews

- **Contract discipline.** The exit codes (`0/1/2/3` + the `130` interruption
  exception), the `--json` envelope, and the ten commands are public
  contract — see the [Product Baseline v1](docs/baseline-v1.md). Changes to
  them update the baseline and docs first.
- **Docs move with code.** README, `docs/cli.md`, and `docs/reference.md` must
  agree with runtime behavior in the same PR that changes it.
- **Fail-closed everything.** Evidence problems are `unknown`, never
  `accepted`. New evidence paths need tests proving they fail closed.
- **No secrets, no tokens.** GitHub evidence flows only through the
  authenticated `gh` CLI; nothing logs credentials.
- **Style:** ESLint is the arbiter; otherwise follow the surrounding code.

## Provider module layout (#170)

Two directories share the word "github" and each has exactly one role:

- **`src/github/`** is the canonical home of the platform-neutral provider
  port — `port.ts` defines `ForgeProvider` (#169) and its member inventory.
  Its other files: `pr-scaffold.ts` and `closing-refs.ts` are real
  implementations (the draft-PR scaffold renderer, #87/#118, and the
  closing-reference grammar, #115); `gh-cli.ts` and `protection-merge.ts`
  are `@deprecated` alias modules that re-export the canonical GitHub
  adapter and never contain implementation.
- **`src/providers/github/`** is the canonical home of the GitHub adapter
  (`GhCliGitHubProvider`, #113), beside the glab adapter under
  `src/providers/gitlab/` and the shared transport `cli-spawn.ts`.

Migration intent: new code imports the adapter from
`src/providers/github/`, never through the `src/github` aliases. The aliases
stay importable — the contract test
(`test/specgit/provider-port-contract.test.ts`) pins their referential
equality and their `@deprecated` headers — until a dedicated delivery
removes them, following the deprecation path in
[docs/providers.md](docs/providers.md).

## Reporting bugs and security issues

- Bugs and feature requests: use the issue templates
  ([bug](.github/ISSUE_TEMPLATE/bug_report.md) /
  [feature](.github/ISSUE_TEMPLATE/feature_request.md)).
- Security: do **not** open a public issue — follow [SECURITY.md](SECURITY.md).

## Code of Conduct

By participating you agree to uphold the [Code of Conduct](CODE_OF_CONDUCT.md).
Need help? See [SUPPORT.md](SUPPORT.md).
