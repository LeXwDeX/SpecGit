# specgit

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
