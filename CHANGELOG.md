# specgit

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
