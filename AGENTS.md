# AGENTS.md — SpecGit

SpecGit (package and CLI: `specgit`) is a delivery binding and acceptance
harness: bind a branch or worktree to GitHub issues and one pull request, then
derive acceptance from real git, PR, and CI evidence. Repository:
https://github.com/LeXwDeX/SpecGit. Everything SpecGit writes falls into three
tiers: **authoritative delivery files** (the policy `spec_git/policy.yaml`,
the record `.specgit.yaml`, optional `spec_git/providers.yaml` — shielded in
`.gitignore` by default since #292 and carried into git by the bootstrap's
binding commit, where the PR-head CI verdict reads them), a **derived
committed harness** (the acceptance workflow and the managed AGENTS/CLAUDE
block — regenerate with `init --force`, never hand-edit), and **local
integration assets** (guard hooks and `setup` entry points; agent
conveniences, never acceptance inputs). Verdicts are never persisted.

## Product contract (never break)

- Ten commands. Human story: `specgit issue` (one-command bootstrap,
  idempotent resume) → `specgit finish` (verdict; the CI gate runs this
  in `.github/workflows/specgit-accept.yml`), with `specgit pr`
  (repair the PR binding; `--merge` executes configured automation), `specgit
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
- Automation is opt-in: `init` and `init --force` ask the user yes/no,
  default no. Agents cannot answer yes for the user. `pr --merge` requires
  the configured target, accepted evidence and all current CI/CD passing;
  `finish` and `accept` remain read-only. Details: [docs/cli.md](docs/cli.md).
- Provider seams: git facts come from **local git** (`src/gitfacts`);
  platform evidence (issues, PRs/MRs, checks) flows exclusively through
  authenticated CLIs — `gh` for GitHub (`src/providers/github/gh-cli.ts`,
  port at `src/github/port.ts`) and `glab` for GitLab-declared origins
  (`src/providers/gitlab/glab-cli.ts`) — dispatched per platform marker by
  `src/providers/routing.ts`. No direct REST client, no stored or logged
  tokens. v1 scope is dual-platform: self-managed GitLab has a verified
  window of `>= 19.2.4 < 19.4.0`, CE/Free tier (`glab` floor 1.113.0) —
  outside versions warn (`gitlab_version_unverified`) and are judged by
  their live API behaviour; a delivery on a declared GitLab origin
  evaluates every gate through glab —
  see [docs/gitlab-support.md](docs/gitlab-support.md).
- Generated text is language-configurable: `language: en|zh` in
  `spec_git/policy.yaml` (`specgit init --language zh`) selects the
  language of issue/PR scaffolds, the managed guidance block, and
  success-path stderr prose. The machine contract is never localized —
  exit codes, `--json` fields, diagnostic `code`s, closing references
  (`Closes #n`) — and branch names are always ASCII: a title that
  yields no ASCII slug never falls back to `issue<N>` — bootstrap asks
  for a kebab-case delivery name (`--delivery <slug>` in scripts).

## Build, test, lint

- Build: `pnpm run build`
- Typecheck: `pnpm exec tsc --noEmit` (src) plus `pnpm run typecheck:test` (test tree)
- Lint: `pnpm run lint` (ESLint over `src/`)
- Tests: `pnpm test` (Vitest, single run)
- Node ≥ 20.19; pnpm is the only package manager.

## Working discipline

- Development loop (binding): [workflows/specgit-dev-loop.md](workflows/specgit-dev-loop.md)
  — TDD slices, PR to `main`, a reviewable PR brief and existing user authorization.
- Pre-merge quality loop (binding):
  [workflows/quality-loop.md](workflows/quality-loop.md) — REVIEW →
  DEBUG → FIX until clean (fast rounds, then one full two-axis review),
  then merge, then release; zero checkpoints, capped, fail-closed.
- Issue tracker: [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md)
  — GitHub Issues on `LeXwDeX/SpecGit`, operated via `gh`.
- Docs must stay consistent with the language of [README.md](README.md) and
  [docs/cli.md](docs/cli.md); when the contract changes, change those first.
- Completion vocabulary, release gates, and growth discipline:
  [docs/release-gates.md](docs/release-gates.md) — every new issue cites an
  invariant or a seam, or is explicitly accepted-or-deferred.
- Contributor onboarding: [CONTRIBUTING.md](CONTRIBUTING.md) (setup,
  everyday checks, the delivery workflow).
- GitLab live testing and release sync use the `gitlab-mirror` remote
  (`git@git.ycgame.com:suntao/specgit.git`, glab-authenticated,
  self-managed CE): never claim there is no live GitLab environment.
  A release counts as done only after `main` and every version tag
  are pushed to it and verified with `git ls-remote`.

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
- Issue bodies are filled at bootstrap, from the conversation: right after
  `specgit issue` succeeds, edit each issue it created (`gh issue edit <n>`)
  with the discussed Why / Scope / Approach / Acceptance, then implement.
  The PR scaffold's placeholders are advisory — fill those sections in as
  you deliver; the closing references are the only body gate. The PR body
  is written once at creation; no SpecGit command edits an existing PR
  body, and the repository's own pull-request template is never read.
- A draft pull request always fails the verdict (`pr_draft`): before
  `specgit finish`, mark it ready for review — `gh pr ready <number>`
  on GitHub, `glab mr update <number> --ready` on GitLab.
- `specgit finish` is read-only: its verdict comes from real git, PR,
  and CI evidence; exit 0 is the only acceptance. With automation enabled,
  continue with `specgit pr --merge --json`: it verifies the policy's
  `target_branch`, fresh acceptance, and all CI checks passing at the
  current PR head, then confirms the merge before closing bound issues
  when configured.

### Issue tags

- Follow the project's `language` for issues and PRs. Enabled `validation`
  rules check titles and labels before creation and during `finish`.
  `kind` mode requires one catalog kind and only declared extras;
  `project` mode selects only policy `tags`. Users choose rule changes with
  `specgit init --force --configure-rules`.
- Every bootstrap applies the title's `kind::<type>` member
  automatically; pass `--tags <a,b>` to choose the full set explicitly.
- Selection is pool-first: existing on-spec labels win verbatim; anything
  missing is seeded from the built-in `kind::` catalog or the policy's
  `tags:` declarations. Unknown vocabulary exits 2 naming the universe.
- Choose at most one label per axis; omit uncertain optional labels and
  keep every label required by the selected policy. Existing pool labels
  cannot override that policy —
  off-spec pool labels are reported (`tag_pool_dirty` warnings are for
  humans) and never renamed by SpecGit.

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
- Automation defaults to off (`--automation no`). Only when the user personally chooses
  yes may `specgit init --automation yes --merge-target <branch>` enable it;
  `init --force` can change that choice. An agent must not answer yes for the user.

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

### Agent contract essentials

- **SpecGit is the default way of working here.** Any non-trivial
  task — a feature, a fix, a refactor, a docs change — is a delivery:
  work items live in this tracker as issues, never in private task
  lists or conversational checklists. The trigger is the decision to
  start: the moment the conversation settles and you begin turning
  the plan into changes, the FIRST action is
  `specgit issue <type>: <title>...` — before any file edit.
  Working without a binding is a contract violation, not a style
  choice. Immediately after bootstrap, fill each issue body
  (Why / Scope / Approach / Acceptance) from the discussion with
  `gh issue edit`, then implement. Mid-conversation inventories
  ("let me list everything to do") become issues, not chat
  artifacts. Trivial replies and read-only questions need none of
  this.
- The one rule: a delivery is done if and only if `specgit finish`
  exits `0`. Never declare completion from task lists, file states, or
  test runs you performed yourself.
- Use existing user authorization to complete issue bodies, the PR body
  and ready transition, CI repairs or retries, acceptance, and the authorized
  merge. When user authorization or platform permission is missing, present
  the prepared result and name the specific gap. Documentation and entry
  points do not grant permission themselves.
- Branch on exit codes, not phrasing: `1` = evidence complete, fix what
  the gates named; `3` = evidence missing, fix the environment first
  (`specgit doctor`). Never present exit `3` as success.
- Keep the `Closes #n` references in the PR body intact; after changing
  the PR body, head branch, or CI, re-run `specgit finish`. Never
  bypass or reconfig a required check to make acceptance pass.
- Forge evidence flows through the user's authenticated CLI session only
  (`gh` / `glab`): never read, log, or pass around tokens.
<!-- specgit:block:end -->
