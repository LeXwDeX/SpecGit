# AGENTS.md — SpecGit

SpecGit (package and CLI: `specgit`) is a delivery binding and acceptance
harness: bind a branch or worktree to GitHub issues and one pull request, then
derive acceptance from real git, PR, and CI evidence. Repository:
https://github.com/LeXwDeX/SpecGit. All persistent state is two committed
files: the policy `spec_git/policy.yaml` and the record `.specgit.yaml`.

## Product contract (never break)

- Nine commands. Human story: `specgit issue` (one-command bootstrap,
  idempotent resume) → `specgit finish` (verdict; the CI gate runs this
  in `.github/workflows/specgit-accept.yml`), with `specgit pr`
  (repair the PR binding: auto-discover by head branch) and `specgit
  init` / `status` / `doctor` for setup and diagnostics. Machine
  aliases for scripts: `bind`, `unbind`, `accept` — nothing else is
  public surface.
- Exit-code contract: `0` success/accepted · `1` rejected with complete
  evidence · `2` usage error · `3` fail-closed unknown. Exit `1` vs `3` is
  contractual: `1` = evidence gathered and it says no; `3` = no verdict
  possible.
- With `--json`, stdout is exactly one valid JSON document (the envelope in
  [docs/cli.md](docs/cli.md)); every human-readable line goes to stderr.
- Fail-closed acceptance: if evidence cannot be gathered, the verdict is
  `unknown`, never `accepted`. A delivery is done if and only if
  `specgit finish` exits `0` (`accept` is the alias running the same
  evaluator).
- One issue = one independently verifiable WHY; one delivery binds N
  issues to one PR that closes them all.
- Provider seams: git facts come from **local git** (`src/gitfacts`);
  GitHub evidence (issues, PR, checks) flows exclusively through the
  authenticated **`gh` CLI** (`src/github`). No direct REST client, no
  stored or logged tokens.

## Build, test, lint

- Build: `pnpm run build`
- Typecheck: `pnpm exec tsc --noEmit`
- Lint: `pnpm run lint` (ESLint over `src/`)
- Tests: `pnpm test` (Vitest, single run)
- Node ≥ 20.19; pnpm is the only package manager.

## Working discipline

- Development loop (binding): [workflows/specgit-dev-loop.md](workflows/specgit-dev-loop.md)
  — TDD slices, PR to `main`, single push-right checkpoint at the PR brief.
- Issue tracker: [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md)
  — GitHub Issues on `LeXwDeX/SpecGit`, operated via `gh`.
- Docs must stay consistent with the language of [README.md](README.md) and
  [docs/cli.md](docs/cli.md); when the contract changes, change those first.

<!-- specgit:block:start -->
## SpecGit delivery harness

Managed by `specgit init`. Everything between the markers is rewritten on
re-init; keep manual guidance outside them.

### The delivery story

- Start with `specgit issue <title-or-number>...`: it creates or reuses
  the issues, branches, opens the draft pull request that closes every
  bound issue, and writes `.specgit.yaml`. Re-running resumes; it is
  idempotent.
- Finish with `specgit finish`: the verdict, derived from real git, PR,
  and CI evidence. Exit code 0 is the only "done".

### Repair and diagnostics

- `specgit pr` repairs the pull-request binding: with no arguments it
  auto-discovers the pull request for this head branch, errors with a fix
  when none is found, and refuses with a list when several match.
- `specgit status` shows local evidence only: record, state, drift,
  origin. `specgit doctor` probes git, repository, origin, gh, and
  policy.

### Issue granularity

One issue = one independently verifiable WHY. If a deliverable cannot be
verified on its own evidence, split it before binding.

### Iron rules

- `specgit finish` exit code other than 0: never request merge. Fix the
  delivery, not the gate.
- Never weaken `spec_git/policy.yaml` to make a verdict pass.
- `--json` is the only parse surface: stdout is exactly one JSON
  document; never scrape human-readable output.
<!-- specgit:block:end -->
