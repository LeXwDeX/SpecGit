# specgit

## 0.8.0

### Minor Changes

- [#81](https://github.com/LeXwDeX/SpecGit/pull/81) [`00bff6b`](https://github.com/LeXwDeX/SpecGit/commit/00bff6bf01997525c57513f8ee44127296e6c433) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - Make `specgit init` non-destructive and governance-preserving ([#62](https://github.com/LeXwDeX/SpecGit/issues/62)).

  - All validation — flag checks, `--gitlab-host` validation, `policy_exists`, and a root-writability preflight — now happens before any filesystem or remote mutation. A rejected init leaves the repository byte-identical.
  - The harness write is error-atomic: mid-sequence failures roll every target back to its pre-write bytes and modes.
  - Existing hooks are merged, never overwritten: `.opencode/hooks.json` user entries and unknown keys are preserved (unparseable files left untouched with a warning), and a user git `pre-push` hook keeps its content with the specgit guard appended inside managed markers. The git hook installs via `git rev-parse --git-path hooks`, so linked worktrees and `core.hooksPath` (husky/lefthook) are respected.
  - `--protect` is now read-modify-write: existing required checks, reviews (including dismissal rules), push restrictions, admin enforcement, and rule booleans are read and preserved, with `SpecGit Acceptance` the only addition. The warned-path fix guidance no longer prints a command that would clear reviews/restrictions.
  - Re-init contract change: `init` with an existing policy exits 2 having written and probed nothing; `--force` rebuilds the policy and refreshes the harness (managed-block drift repair now happens on `--force`).

- [#81](https://github.com/LeXwDeX/SpecGit/pull/81) [`00bff6b`](https://github.com/LeXwDeX/SpecGit/commit/00bff6bf01997525c57513f8ee44127296e6c433) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - Generate a portable acceptance harness for external repositories ([#63](https://github.com/LeXwDeX/SpecGit/issues/63)).

  - `specgit init` now selects the workflow template by repository: the SpecGit repository itself (root package name `specgit`) keeps the local-build template; every other (adopting) repository gets a portable template that installs the published CLI at the exact running version (`specgit@<version>`, no ranges), sets up only Node at the engine floor, parameterizes the adopting repo's remote default branch, and never assumes or invokes the adopting project's toolchain, lockfile, layout, or build. The `--json` envelope reports the choice as `harness.template`.
  - No-CI repositories: init's detection fallback now writes an empty `required_checks` list instead of the unsatisfiable aggregate name "All checks passed" (never a check-run name — it deadlocked the generated wait step and made the verdict impossible). The policy schema accepts the empty list as the no-CI policy; the SpecGit Acceptance job, enforced through branch protection, is the gate. This is a schema widening with rationale documented in `schemas/specgit/schema.yaml`.
  - An unresolvable remote default branch falls back to `main` with a `default_branch_unresolved` warning (same fallback the protection probe already uses).

### Patch Changes

- [#60](https://github.com/LeXwDeX/SpecGit/pull/60) [`22b5bbd`](https://github.com/LeXwDeX/SpecGit/commit/22b5bbd1759819ad48e5222064b080f5041b0222) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Attributed timeout diagnostics (`gh_timeout`)

  A `gh` call that exceeds its time budget (default 15 s) now fails with the
  dedicated `gh_timeout` code instead of the generic `gh_transport`, and the
  fix names the three likely causes in order — network reachability
  (`curl -sI https://api.github.com`), a GitHub incident (githubstatus.com),
  or a genuinely slow call — plus the knob: `SPECGIT_GH_TIMEOUT_MS`
  (milliseconds) raises the per-call budget for every `gh` invocation SpecGit
  spawns.

## 0.7.2

### Patch Changes

- [#56](https://github.com/LeXwDeX/SpecGit/pull/56) [`38d43ee`](https://github.com/LeXwDeX/SpecGit/commit/38d43ee9674ba47e354c89f055db2c83810b966d) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Harness template sync + retry hardening

  - The acceptance-workflow template source now matches the repository's own
    evolved `specgit-accept.yml` (workflow_dispatch trigger, WAIT_SHA fallback
    to `github.sha`, hosted-pool rationale): re-running `specgit init` no
    longer regresses these fixes. An anti-drift test locks the template to
    the repo file byte-for-byte.
  - The wait-for-sibling-checks script retries transient check-runs API
    failures (5xx, 429, network errors) with bounded exponential backoff
    (5 attempts, 2s→30s ladder) — a platform blip no longer fails the
    acceptance gate.

## 0.7.1

### Patch Changes

- [#51](https://github.com/LeXwDeX/SpecGit/pull/51) [`1e524f1`](https://github.com/LeXwDeX/SpecGit/commit/1e524f1aeadf3fd94d473ba8e379bbfa86ef930b) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Release idempotence decided by tag existence

  The release workflow treated a MERGED version PR as "already shipped" — but
  the `changeset-release/main` branch keeps the previous version's merged PR,
  so the next release was silently skipped. The check now decides by tag:
  `v<version>` already on the remote means shipped (exit 0); otherwise the
  version PR is created (or recreated after an older merge), regardless of
  the stale PR state.

- [#49](https://github.com/LeXwDeX/SpecGit/pull/49) [`197a757`](https://github.com/LeXwDeX/SpecGit/commit/197a757339ea0afda231a546e7b6b2b04353bb0b) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Review findings addressed

  - `specgit init` interactive prompts (platform select, protection confirm)
    render to stderr, keeping the `--json` stdout contract (exactly one JSON
    document) intact on interactive terminals.
  - `--gitlab-host` on a github.com origin is rejected (`gitlab_host_invalid`)
    instead of silently writing a nonsensical declaration.
  - The wiring evaluate wrapper no longer clobbers a caller-supplied
    `gitlabHost`; provider discovery only fills the gap.
  - Docs updated for the platform-mode model: `--gitlab-host` in the init flag
    table, the `platform` envelope section, and the `spec_git/providers.yaml`
    schema in the reference.
  - Acceptance workflow: `workflow_dispatch` runs now work (the sibling-wait
    SHA falls back to `github.sha`); the dead bootstrap step on the hosted job
    is removed; the CI bootstrap condition keys on the stable
    `matrix.label == 'self-hosted-linux'` instead of the runner machine name.
  - Tests pin the github.com-rejection branch and suffix-host spoof immunity.

## 0.7.0

### Minor Changes

- [#42](https://github.com/LeXwDeX/SpecGit/pull/42) [`6bb6033`](https://github.com/LeXwDeX/SpecGit/commit/6bb6033c44b6abf225e2c087744f37faec151ed2) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Platform-mode model for GitHub and GitLab

  Self-hosted GitLab origins (git.ycgame.com, git.corp.example, …) are no
  longer misclassified as generic `origin_unresolvable`:

  - `specgit init` resolves a platform mode: a `github.com` origin defaults
    to GitHub; any other origin asks on an interactive terminal (GitHub or
    GitLab) or is declared explicitly with `--gitlab-host <hostname>` (bare
    hostname, validated against the origin host).
  - The declaration persists in `spec_git/providers.yaml`
    (`gitlab.host`, `gitlab.insecure_ssl` for self-signed certificates) —
    committed to the repository, shared by the whole team.
  - `parseRepoRef`, the acceptance evaluator, `doctor`, and `status` all
    consult the declared host: matching origins report the dedicated
    `gitlab_unsupported` diagnostic (the glab-provider roadmap stays in
    docs/gitlab-support.md); everything else keeps `origin_unresolvable`.
  - Evidence providers remain the official CLIs only — `gh` for GitHub,
    `glab` for GitLab (once implemented); no third-party API clients.
  - The `--json` envelope gains a `platform` section
    (`{ mode: github | gitlab | undecided, gitlabHost? }`), and an undeclared
    non-github origin warns `platform_undecided`.

- [#34](https://github.com/LeXwDeX/SpecGit/pull/34) [`9f9e114`](https://github.com/LeXwDeX/SpecGit/commit/9f9e1148107b199d03dcbe7e3861dc0507d53eb2) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Prompt-guided duplicate check before issue creation

  The managed prompt block injected by `specgit init` into `AGENTS.md` /
  `CLAUDE.md` now instructs agents to search the tracker for similar open
  issues before creating one (`gh issue list` / `gh search issues`), read
  every plausible candidate (`gh issue view`), compare the WHY, and let the
  requester decide between continuing the existing issue and creating a
  duplicate — one line of work per WHY, never two. Existing installations
  pick the guidance up on the next `specgit init`.

### Patch Changes

- [#40](https://github.com/LeXwDeX/SpecGit/pull/40) [`8358d76`](https://github.com/LeXwDeX/SpecGit/commit/8358d767149c5ed7580633fb32c85abb1c814639) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### init detection hardening

  - Job names containing matrix placeholders (e.g.
    `Unit Tests (${{ matrix.settings.name }})`) never appear in real
    check-runs; detection now falls back to the stable job id instead of
    writing an unmatchable name into `spec_git/policy.yaml`.
  - `workflow_dispatch`-only workflows never run on a PR head, so their jobs
    are excluded from detection (a workflow counts when any trigger other
    than `workflow_dispatch` is present; YAML 1.1's boolean-`true` parsing of
    the `on` key is handled).
  - Release workflow: when the bot cannot create the version PR, the
    fallback edit only reuses a PR that is still open — a closed one is now
    a hard error instead of silently masking the failure.

## 0.6.0

### Minor Changes

- [#37](https://github.com/LeXwDeX/SpecGit/pull/37) [`a0ecb70`](https://github.com/LeXwDeX/SpecGit/commit/a0ecb70031ce3ff4b8954cfc9811e21251a1d41d) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Ordered issue merging (`ordered_issues`)

  `spec_git/policy.yaml` gains an optional `ordered_issues: true` switch. When
  on, `specgit finish` enforces ascending merge order across deliveries: any
  open issue with a number smaller than this delivery's smallest bound issue
  rejects the verdict (`issue_out_of_order`, exit 1) naming the earlier open
  issues. The rule lives in the gate — every CI acceptance run and every local
  `finish` enforces it identically, so new agent sessions cannot merge out of
  order even by accident. Off (the default), nothing changes and no extra
  provider call is made.

## 0.5.0

### Minor Changes

- [#20](https://github.com/LeXwDeX/SpecGit/pull/20) [`07f749e`](https://github.com/LeXwDeX/SpecGit/commit/07f749e35f749d8201f2180cc38611a6bdddd43e) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Strict issue input spec for `specgit issue`

  - Issue titles must match `<type>: <english title>`; the type is validated
    against a fixed 14-entry whitelist (`feat`, `fix`, `refactor`, `perf`,
    `docs`, `test`, `chore`, `style`, `build`, `ci`, `revert`, `security`,
    `deprecate`, `dogfood`), and the title body must be printable ASCII.
    Missing/unknown types and non-English titles are usage errors (exit 2)
    that list the valid types; every title is validated before any issue is
    created.
  - Created issue bodies follow a required/optional section template
    (`## Why (required)`, `## Scope (optional)`, `## Acceptance (required)`).

  ### Acceptance-bypass guard at `specgit init`

  - After writing the policy and harness, `init` probes the default branch:
    when the `SpecGit Acceptance` check is not a required status check there,
    it warns that the acceptance gate can be bypassed, asks for confirmation
    on an interactive terminal, and (when confirmed, or with `--protect`)
    enables branch protection and repository auto-merge. `--no-protect` skips
    the probe. Provider or permission failures never fail `init`
    (fail-open); the `--json` envelope gains a `protection` section.

  ### GitLab origins recognized with a dedicated diagnostic

  - `gitlab.com` and self-hosted `*gitlab*` origins now fail with
    `gitlab_unsupported` (instead of the generic `origin_unresolvable`),
    naming the actual gap and pointing at the published GitLab/glab support
    roadmap (`docs/gitlab-support.md`). `specgit doctor` surfaces the same
    code on its `origin` probe.

## 0.4.0

### Minor Changes

- [#18](https://github.com/LeXwDeX/SpecGit/pull/18) [`1432789`](https://github.com/LeXwDeX/SpecGit/commit/1432789fc52cf4b5aaa4044c31755cffe7523bdb) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Init detection: platforms, GitLab CI, --force, --no-detect

  - `specgit init` now reports a `detected` JSON section: platform classified from the origin URL (github / gitlab / unknown, no network), the CI files the checks came from, and gh/glab presence on PATH (reported only)
  - Required-check discovery extends to `.gitlab-ci.yml` top-level job keys (reserved keys excluded) when no GitHub workflows exist
  - `--force` rebuilds `spec_git/policy.yaml` even when it exists (default stays the `policy_exists` usage error)
  - `--no-detect` keeps the strict legacy path: without explicit `--required-check` it exits 2 instead of detecting

## 0.3.0

### Minor Changes

- [#17](https://github.com/LeXwDeX/SpecGit/pull/17) [`c1649da`](https://github.com/LeXwDeX/SpecGit/commit/c1649da4f4feb372da72e05ea0fbbce8799dfbda) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Merged-delivery lifecycle

  - `specgit finish` on a merged delivery's record (e.g. on main after the PR merged) now returns **accepted** with a `record_of_merged_delivery` warning suggesting `specgit unbind --yes` — previously it mis-reported `branch_mismatch`. The merge is verified against PR evidence; a provider failure keeps the fail-closed mismatch.
  - `specgit issue` replaces a merged-delivery record automatically instead of failing with `issue_resume_drift` until a manual unbind — the merge is verified the same fail-closed way.

## 0.2.0

### Minor Changes

- [#11](https://github.com/LeXwDeX/SpecGit/pull/11) [`d290d0b`](https://github.com/LeXwDeX/SpecGit/commit/d290d0b0f96e633999a94ad26ad8acda86126213) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### Automated npm releases

  Merging a PR to `main` with pending changesets now publishes automatically: the Release workflow consumes the changesets, bumps the version, builds, publishes to npm (automation token in the `NPM` environment), pushes the `v<version>` tag, and creates the GitHub Release. Direct pushes to `main` remain blocked by the pre-push guard, so every release traces to a merged PR. The beta-dispatch and GitHub-App/OIDC machinery from the inherited workflow is removed.

- [`48a1a00`](https://github.com/LeXwDeX/SpecGit/commit/48a1a00e77aa06384090abcdcf8c7b65076a9e63) Thanks [@LeXwDeX](https://github.com/LeXwDeX)! - ### SpecGit 0.1.0 — the strict delivery harness

  The delivery story becomes physical: one command to start, one to finish, and a CI gate that makes the verdict the only path to merge.

  - **`specgit issue <title-or-number>...`** — one-command bootstrap: creates or reuses N issues (one issue = one independently verifiable WHY), branches, opens the draft pull request that closes every bound issue, writes `.specgit.yaml`, and pushes. Re-running resumes; it is idempotent.
  - **`specgit finish`** — the evidence verdict (pure delegation to the acceptance evaluator; `accept` remains as a machine alias). Exit 0 is the only "done".
  - **`specgit pr`** — repairs the pull-request binding: auto-discovers the PR by head branch, errors with a fix when none is found, refuses with a list when several match.
  - **`specgit init` generates the harness**: `.github/workflows/specgit-accept.yml` (job _SpecGit Acceptance_ runs the verdict on every PR, waits for sibling required checks by name, and stays out of `policy.required_checks` to avoid self-deadlock) plus a managed prompt block injected between exact markers in AGENTS.md (created when missing) and CLAUDE.md (only when present). Re-init overwrites the block only.
  - **Agent surface simplified**: `skills/` and `.opencode/command/` are removed — the AGENTS.md block plus `docs/agent-contract.md` are the behavior source. `bind`/`unbind`/`accept` remain as machine aliases.
  - Dogfooded: the acceptance gate ran on its own delivery PR and caught four real harness defects (truncated action SHA, detached-HEAD checkout, empty check-runs race, status-vs-conclusion vocabulary) before release.

## 0.1.0

### Minor Changes

- **`specgit issue <title-or-number>...`** — one-command bootstrap: creates or reuses N issues (one issue = one independently verifiable WHY), branches, opens the draft pull request that closes every bound issue, writes `.specgit.yaml`, and pushes. Re-running resumes; it is idempotent.
- **`specgit finish`** — the evidence verdict (pure delegation to the acceptance evaluator; `accept` remains as a machine alias). Exit 0 is the only "done".
- **`specgit pr`** — repairs the pull-request binding: auto-discovers the PR by head branch, errors with a fix when none is found, refuses with a list when several match.
- **`specgit init` generates the harness**: `.github/workflows/specgit-accept.yml` (job _SpecGit Acceptance_ runs the verdict on every PR, waits for sibling required checks by name, stays out of `policy.required_checks` to avoid self-deadlock) plus a managed prompt block injected between exact markers in AGENTS.md (created when missing) and CLAUDE.md (only when present). Re-init overwrites the block only.
- **Agent surface simplified**: `skills/` and `.opencode/command/` removed — the AGENTS.md block plus `docs/agent-contract.md` are the behavior source. `bind`/`unbind`/`accept` remain as machine aliases.
- Dogfooded: the acceptance gate ran on its own delivery PR and caught four real harness defects before release.

## 0.0.1

### Initial release

SpecGit is a delivery binding and acceptance harness. This is the first
release of a new product; it replaces OpenSpec with no compatibility or
migration path.

- **Product identity.** Package `specgit`, CLI `specgit`, project data root
  `spec_git/`, delivery record `.specgit.yaml`. Canonical repository:
  https://github.com/LeXwDeX/SpecGit.
- **Delivery model.** A change binds one git branch or one git worktree to
  `issues[]` and one pull request; one PR may bind and close N issues.
- **Evidence-derived acceptance.** `specgit accept` derives its verdict
  fail-closed from real git, PR, and check evidence through mockable provider
  adapters (`git` locally, `gh` as the GitHub seam; `SPECGIT_GH` overrides the
  gh command). Spec artifacts, task files, or any other file contents can
  never change acceptance. Exit contract: 0 accepted · 1 rejected · 2 usage ·
  3 fail-closed unknown.
- **Command surface.** `specgit init` (write `spec_git/policy.yaml`), `bind`,
  `unbind`, `status`, `accept`, `doctor`. Non-interactive; exactly one JSON
  document on stdout with `--json`.
- **Agent surface.** Skills (`specgit-setup-policy`, `specgit-bind-delivery`,
  `specgit-accept-delivery`), the agent contract (`docs/agent-contract.md`),
  and the workflow guide (`docs/workflow-guide.md`).

History note: this project superseded
[Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec); its changelog
applies to the retired product and is not reproduced here.
