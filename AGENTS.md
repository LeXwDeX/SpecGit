# AGENTS.md — SpecGit

SpecGit (package and CLI: `specgit`) is a delivery binding and acceptance
harness: bind a branch or worktree to GitHub issues and one pull request, then
derive acceptance from real git, PR, and CI evidence. Repository:
https://github.com/LeXwDeX/SpecGit. Everything SpecGit writes falls into three
tiers: **authoritative committed files** (the policy `spec_git/policy.yaml`,
the record `.specgit.yaml`, optional `spec_git/providers.yaml`), a **derived
committed harness** (the acceptance workflow and the managed AGENTS/CLAUDE
block — regenerate with `init --force`, never hand-edit), and **local
integration assets** (guard hooks and `setup` entry points; agent
conveniences, never acceptance inputs). Verdicts are never persisted.

## Product contract (never break)

- Ten commands. Human story: `specgit issue` (one-command bootstrap,
  idempotent resume) → `specgit finish` (verdict; the CI gate runs this
  in `.github/workflows/specgit-accept.yml`), with `specgit pr`
  (repair the PR binding: auto-discover by head branch), `specgit
  setup` (agent entry points: commands/skills), and `specgit
  init` / `status` / `doctor` for setup and diagnostics. Machine
  aliases for scripts: `bind`, `unbind`, `accept` — nothing else is
  public surface.
- Exit-code contract: `0` success/accepted · `1` rejected with complete
  evidence · `2` usage error · `3` fail-closed unknown. Exit `1` vs `3` is
  contractual: `1` = evidence gathered and it says no; `3` = no verdict
  possible. `130` (SIGINT interruption) is the single exception outside the
  JSON envelope: stderr `Interrupted.`, no envelope, deterministic.
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
  authenticated **`gh` CLI** (`src/providers/github`, port at
  `src/github/port.ts`). No direct REST client, no
  stored or logged tokens. v1 scope is dual-platform — GitHub.com plus
  GitLab CE/Free self-managed per the version policy — and
  GitLab capability lands incrementally per the Phase-2 roadmap; today a
  GitLab host declared via `specgit init --gitlab-host` is a
  declaration-diagnostics seam (`gitlab_unsupported`), not yet a
  provider — see [docs/gitlab-support.md](docs/gitlab-support.md).

## Build, test, lint

- Build: `pnpm run build`
- Typecheck: `pnpm exec tsc --noEmit` (src) plus `pnpm run typecheck:test` (test tree)
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

Managed by `specgit init`. Everything between the markers is regenerated
whenever init writes the harness (a fresh init, or `--force` when a policy
already exists); keep manual guidance outside them.

### The delivery story

- Start with `specgit issue <title-or-number>...`: it creates or reuses
  the issues, branches, opens the draft pull request pre-filled with a
  deterministic scaffold (the `Closes #n` line for every bound issue,
  then Why / What changed / Evidence / Checklist sections), and writes
  `.specgit.yaml`. Re-running resumes; it is idempotent.
- Fill in the scaffold sections as you deliver. Its placeholders are
  advisory — the closing references are the only body gate. The PR body
  is written once at creation; no SpecGit command edits an existing PR
  body, and the repository's own pull-request template is never read.
- Finish with `specgit finish`: the verdict, derived from real git, PR,
  and CI evidence. Exit code 0 is the only "done".

### Repair and diagnostics

- `specgit pr` repairs the pull-request binding: with no arguments it
  auto-discovers the pull request for this head branch, errors with a fix
  when none is found, and refuses with a list when several match.
- `specgit status` shows local evidence only: record, state, drift,
  origin. `specgit doctor` probes git, repository, origin, gh, and
  policy.

### The command surface

- Ten commands: `specgit init`, `specgit setup`, `specgit issue`,
  `specgit pr`, `specgit finish`, `specgit bind`, `specgit unbind`,
  `specgit status`, `specgit accept`, `specgit doctor`.
- `specgit setup` installs the agent entry points (commands for opencode,
  portable skills for other tools); `specgit bind`, `specgit unbind`,
  and `specgit accept` are automation aliases for scripts and CI.

### Before creating an issue, check for duplicates

- Before running `specgit issue` with a new title, search the tracker for
  similar open work: `gh issue list` with keywords from the title
  (state, labels, and search terms via `gh search issues`).
- Open and read every plausible candidate (`gh issue view <n>`) — compare
  the WHY, not just the wording.
- If a candidate covers the same WHY, continue that issue instead of
  creating a new one; if it is close but different, say how they differ.
- When unsure, ask the requester to decide between continuing the existing
  issue and creating a duplicate. The team ships one line of work per WHY,
  never two.

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
