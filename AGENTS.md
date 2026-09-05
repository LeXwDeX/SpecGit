# Repository Guidelines

SpecGit is a dual-platform TypeScript CLI that binds delivery branches to GitHub/GitLab issues and PRs/MRs, then evaluates Git and CI evidence through `gh`/`glab`.

## Project Structure & Module Organization

- `src/cli/`: commands, output, and generated integrations; `src/acceptance/`: verdict gates.
- `src/record/`: record/policy schemas and I/O; `src/gitfacts/`, `src/providers/`, `src/github/`: Git facts and forge adapters/ports.
- `test/specgit/`, `test/specgit-cli/`, `test/specgit-e2e/`: domain, CLI, and subprocess tests.
- `schemas/` and `skills/`: shipped assets; `docs/` and `workflows/`: contracts and workflows. `dist/` is generated.

SpecGit writes three tiers: authoritative delivery files (`.specgit.yaml`, `spec_git/policy.yaml`), the derived committed harness, and local integration assets.

## Build, Test, and Development Commands

Use Node.js ≥20.19 and pnpm 9.15.9. Install locked dependencies with `pnpm install --frozen-lockfile`.

| Command | Purpose |
| --- | --- |
| `pnpm run build` | Compile TypeScript into `dist/`. |
| `pnpm dev:cli --help` | Build and inspect the local CLI. |
| `pnpm test` | Run the Vitest suite once. |
| `pnpm exec tsc --noEmit` / `pnpm run typecheck:test` | Check source/test types. |
| `pnpm run lint` | Run ESLint on `src/`. |
| `node scripts/ci-metadata-check.mjs` | Validate metadata and documentation contracts. |

For README, Wiki, or project-guidance edits, use the [documentation short path](docs/ci-scope.md#documentation-short-path) before consulting the product development or quality loops. It ends after one relevant content review and the existing metadata check; build, full tests, mutation testing, and multi-agent review belong to product changes. Keep unrelated dirty files outside this task's staged diff.

## Coding Style & Naming Conventions

Use strict TypeScript/ESM, two-space indentation, single quotes, semicolons, and `.js` extensions in relative imports. Match kebab-case filenames, camelCase functions, and PascalCase types. ESLint applies `typescript-eslint` recommendations; prefix intentionally unused parameters with `_`.

## Testing Guidelines (product changes)

Name tests `*.test.ts` under the matching suite. Run a focused file with `pnpm exec vitest run test/specgit-cli/status.test.ts`; rebuild first when `dist/` may be stale. Cover accepted, rejected, missing-evidence, and cross-platform behavior. No numeric coverage threshold is configured. Follow [test guidance](test/AGENTS.md) for deterministic providers and snapshots.

## Commit & Pull Request Guidelines

Use Conventional Commit prefixes found in history: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`. Bind tracked work through SpecGit before implementation. Target `main`; follow [the PR template](.github/PULL_REQUEST_TEMPLATE.md) with WHY, changes, evidence, and `Closes #n` for every bound issue. Update contract docs alongside behavior. Add a changeset only for explicit npm publication intent. Acceptance requires a ready PR and current-head checks; completion requires confirmed merge and issue closure.

## Agent Guidance

Prefer MCP graph discovery, check coverage for evidence paths, and verify stale or missing results in source. Keep manual guidance outside generated markers.

<details>
<summary>Generated SpecGit contract (required by metadata validation)</summary>

<!-- specgit:block:start -->
## SpecGit delivery harness

Managed by `specgit init`. Everything between the markers is regenerated
whenever init writes the harness (a fresh init, or `--force` when a policy
already exists); keep manual guidance outside them.

### The delivery story

- Start with `specgit issue <title-or-number>...`: it creates or reuses
  the issues, writes and pushes the initial binding on the delivery branch,
  opens the draft pull or merge request with the supplied body, selected policy
  template, or built-in scaffold, then records and pushes its number. Re-running
  resumes; it is idempotent.
- Use the issue and PR/MR templates explicitly selected by policy. With
  `validation.bodies` or `required_sections`, prepare complete content from
  the discussion before bootstrap and supply `--body-file <path>` per new
  title and `--pr-body-file <path>`. Without enforced body rules, the selected
  policy template or built-in scaffold can be filled after creation. Preserve
  every `Closes #n`; enabled body
  rules apply at creation and acceptance. Resume keeps existing remote bodies
  and user edits. Unselected repository templates are not silently loaded.
- A draft PR/MR always fails the verdict (`pr_draft`): before
  `specgit finish`, mark it ready for review — `gh pr ready <number>`
  on GitHub, `glab mr update <number> --ready` on GitLab.
- `specgit finish` is read-only: its verdict comes from real git, PR/MR,
  and CI evidence; exit 0 means accepted. With automation enabled, the trusted
  remote workflow continues after CI without another confirmation.
  `specgit pr --merge --json` is the recovery path: it verifies the approved
  `target_branch`, fresh acceptance, and all current-head CI, then confirms
  the merge and every bound issue closure before reporting completed.
  A failed closure remains recoverable and is never reported as completed.

### Issue tags

- Follow the project's `language` for issues and PRs/MRs. Enabled `validation`
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

- `specgit pr` repairs the PR/MR binding: with no arguments it
  auto-discovers the request for this head branch, errors with a fix
  when none is found, and refuses with a list when several match.
- `specgit status` shows local evidence only: record, state, drift,
  origin. `specgit doctor` probes git, repository, origin, the configured
  provider CLI (`gh`, or `glab` for a declared GitLab host), and policy.

### The command surface

- Ten commands: `specgit init`, `specgit setup`, `specgit issue`,
  `specgit pr`, `specgit finish`, `specgit bind`, `specgit unbind`,
  `specgit status`, `specgit accept`, `specgit doctor`.
- `specgit setup` installs the agent entry points (commands for opencode,
  portable skills for other tools); `specgit bind`, `specgit unbind`,
  and `specgit accept` are automation aliases for scripts and CI.
- Automation defaults to off (`--automation no`). For a fresh policy, only
  when the user personally chooses yes may they enable it with
  `specgit init --automation yes --merge-target <branch>`. To change an
  existing policy, use
  `specgit init --force --automation yes --merge-target <branch>`; plain
  `init --force` preserves its current choice and target. An agent must not
  answer yes for the user.

### Before creating an issue, check for duplicates

- Before running `specgit issue` with a new title, search the tracker for
  similar open work through the authenticated session: on GitHub use
  `gh issue list --state open --search "<keywords>"`; on GitLab use
  `glab issue list --search "<keywords>" --in title`. Narrow
  further with labels when useful.
- Open and read every plausible candidate with `gh issue view <n>` on GitHub
  or `glab issue view <n>` on GitLab — compare the WHY, not just the wording.
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

- **SpecGit is the default delivery workflow here.** An intended tracked
  change — a feature, a fix, a refactor, a docs change, or shared rules — is a delivery:
  work items live in this tracker as issues, never in private task
  lists or conversational checklists. The trigger is the decision to
  start: the moment the conversation settles and you begin turning
  the plan into changes, the FIRST action is
  `specgit issue <type>: <title>...` — before tracked implementation edits.
  Preparing temporary body files for bootstrap is part of this first step.
  Working without a binding is a contract violation, not a style
  choice. After bootstrap, verify each issue contains the discussed
  Why / Scope / Approach / Acceptance and fill only missing content with
  `gh issue edit` or `glab issue update`,
  then implement. Mid-conversation inventories
  ("let me list everything to do") become issues, not chat
  artifacts. Trivial replies and read-only questions need none of
  this.
- Local maintenance: installing or upgrading the CLI and running `init` /
  `setup` to refresh local configuration and entry points need no issue, PR/MR,
  product build, or release when no product or shared-rule change is intended
  for commit. After a package upgrade, a human may run plain `specgit init`
  and approve its guided refresh when it proves drift; non-interactive agents
  run `specgit init --force --no-protect`, then `specgit setup --tool all`,
  then verify `specgit status --json`. Append `--no-ignore` to init when
  authoritative delivery files are intentionally tracked without the managed
  ignore block; setup preserves that proven choice. Review tracked diffs before choosing what to share; ignore rules
  are never CI exemptions. Follow the host project's verification policy for
  the actual changed inputs; documentation may itself be a product input.
  Publishing requires explicit release intent within existing user authorization;
  local maintenance and merging do not imply publication.
- `specgit finish` exit `0` means accepted. Report completed only after
  the configured target merge and every bound issue closure are confirmed.
  Never declare completion from task lists, file states, or tests alone.
  Track a failed PR/MR with a new repair issue; repeated causes reuse an open
  repair issue and do not require abandoning the original PR/MR.
- Use existing user authorization to complete issue bodies, the PR/MR body
  and ready transition, CI repairs or retries, acceptance, and the authorized
  merge. When user authorization or platform permission is missing, present
  the prepared result and name the specific gap. Documentation and entry
  points do not grant permission themselves.
- Branch on exit codes, not phrasing: `1` = evidence complete, fix what
  the gates named; `3` = evidence missing, so follow `errors[].fix` first.
  Run `specgit doctor --json` only for git, repository, origin, configured
  provider CLI/auth, or policy probes. Never present exit `3` as success.
- Keep the `Closes #n` references in the PR/MR body intact; after changing
  the PR/MR body, head branch, or CI, re-run `specgit finish`. Never
  bypass or reconfig a required check to make acceptance pass.
- Forge evidence flows through the user's authenticated CLI session only
  (`gh` / `glab`): never read, log, or pass around tokens.
<!-- specgit:block:end -->

</details>
