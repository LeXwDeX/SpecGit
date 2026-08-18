# AGENTS.md — SpecGit

SpecGit (package and CLI: `specgit`) is a delivery binding and acceptance
harness: bind a branch or worktree to GitHub issues and one pull request, then
derive acceptance from real git, PR, and CI evidence. Repository:
https://github.com/LeXwDeX/SpecGit. All persistent state is two committed
files: the policy `spec_git/policy.yaml` and the record `.specgit.yaml`.

## Product contract (never break)

- Six commands: `specgit init`, `bind`, `unbind`, `status`, `accept`,
  `doctor` — nothing else is public surface.
- Exit-code contract: `0` success/accepted · `1` rejected with complete
  evidence · `2` usage error · `3` fail-closed unknown. Exit `1` vs `3` is
  contractual: `1` = evidence gathered and it says no; `3` = no verdict
  possible.
- With `--json`, stdout is exactly one valid JSON document (the envelope in
  [docs/cli.md](docs/cli.md)); every human-readable line goes to stderr.
- Fail-closed acceptance: if evidence cannot be gathered, the verdict is
  `unknown`, never `accepted`. A delivery is done if and only if
  `specgit accept` exits `0`.
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
