# specgit

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
