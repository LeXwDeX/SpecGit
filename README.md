<p align="center">
  <a href="https://github.com/LeXwDeX/SpecGit"><strong>SpecGit</strong></a><br/>
  <em>Lightweight delivery binding and evidence-based acceptance.</em>
</p>

<p align="center">
  <a href="https://github.com/LeXwDeX/SpecGit/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/LeXwDeX/SpecGit/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://www.npmjs.com/package/specgit"><img alt="npm" src="https://img.shields.io/npm/v/specgit?style=flat-square" /></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-blue.svg" /></a>
</p>

SpecGit connects a branch or worktree, one or more issues, one PR/MR, and the
project's required checks. It derives acceptance from Git and your authenticated
GitHub or GitLab session. Teams and coding agents get a shared, verifiable
meaning of acceptance and completion.

## Design principles

- **Evidence determines acceptance.** The record declares the delivery; Git,
  issue, request, and current-head check facts substantiate it on every run.
- **Missing evidence stays unknown.** Unavailable or incomplete evidence cannot
  produce an accepted verdict.
- **Completion closes the delivery.** Acceptance precedes merge; completion
  requires a confirmed merge and every bound issue closed.
- **Verification follows the change.** A README introduction needs content and
  link checks. Product behavior needs applicable product tests. Publication
  requires explicit release intent.

One issue describes one independently verifiable WHY. One PR/MR may close
several such issues. See [Concepts](docs/concepts.md) for the full model.

## Quick start

Requirements: Node.js **>=20.19**, Git, and an authenticated `gh` or `glab`.
Run repository commands inside the project you intend to use with SpecGit.

```bash
npm install -g specgit@latest
specgit --version

gh auth status                       # GitHub; use glab for GitLab
specgit init                         # review detected required checks
specgit setup                        # install agent entry points

specgit issue "feat: add login flow"
# Implement, run the checks appropriate to the change, commit, and push.
# Keep Closes #n for every bound issue in the PR/MR body.

gh pr ready <number>                 # GitLab: glab mr update <number> --ready
specgit finish
```

`issue` creates or reuses the issues, creates the branch and draft PR/MR,
records the binding, and pushes it. Repeating the same command resumes an
interrupted bootstrap. Fill in the actual Why, Scope, Approach, and Acceptance;
selected body rules may require `--body-file` and `--pr-body-file` at creation.

`finish` reads evidence and never merges or closes issues itself:

| Result | Meaning | Next step |
| --- | --- | --- |
| `accepted`, exit `0` | The observed request head satisfies acceptance | Complete the authorized merge and issue closure |
| `rejected`, exit `1` | Evidence proves a condition is not satisfied | Fix the named condition; pending CI may simply need time |
| `unknown`, exit `3` | Necessary evidence is unavailable | Follow `errors[].fix` and collect fresh evidence |
| `closure_pending` | Merge is confirmed, but bound issues remain open | Complete their closure and run `finish` again |
| `completed` | Merge and all bound issue closures are confirmed | Start the next delivery when ready |

A changed head, request body, or check result needs a fresh verdict.
See [Getting Started](docs/getting-started.md) for the detailed walkthrough.

## Keep small changes small

For changes to SpecGit's own README, Wiki, or manual project guidance, use the
[documentation short path](docs/ci-scope.md#documentation-short-path):
review the affected content once, run the existing metadata check, and finish
local verification when it passes. These changes do not need product compilation,
typechecks, the full test suite, mutation testing, or repeated agent reviews.

```bash
node scripts/ci-metadata-check.mjs
```

This repository still uses lightweight remote metadata validation and acceptance
before a delivery merges. Product build/test jobs are skipped for a complete
metadata-only diff; a documentation edit does not request an npm release.
A PR that also contains source changes still requires product verification.
Keep unrelated work out of a small documentation delivery.

Shipped templates, generators, executable workflows, schemas, and distributed
skills are product inputs, even when they produce Markdown. Their changes need
the applicable product checks. The binding classification is [CI scope](docs/ci-scope.md).
An adopting project chooses its own checks and their scope; SpecGit's private
source-repository CI map does not replace the adopter's business CI.

## Platforms

| Platform | Setup | Evidence |
| --- | --- | --- |
| GitHub.com | Authenticate `gh`, then run `specgit init` | GitHub issues, PRs, and current-head checks |
| Self-managed GitLab | Authenticate `glab` for the host and declare it with `--gitlab-host` | GitLab issues, MRs, and pipeline jobs |
| GitLab.com | Declare `--gitlab-host gitlab.com` and authenticate `glab` | Capability-probed GitLab evidence |

```bash
glab auth status --hostname gitlab.example.com
specgit init --gitlab-host gitlab.example.com
```

The verified self-managed window is GitLab CE/Free `>=19.2.4 <19.4.0`, with
`glab >=1.113.0`. Outside that window, live evidence remains authoritative;
consult [GitLab support](docs/gitlab-support.md) for the qualification policy.
GitHub Enterprise has no v1 provider route. One delivery belongs to one repository
on one platform.

GitHub gets a generated acceptance workflow. GitLab's business acceptance job
remains project-owned; its reviewed pipeline must run `specgit finish --json`.
See the platform guide before enabling completion automation.

## Configuration and automation

| File | Purpose |
| --- | --- |
| `spec_git/policy.yaml` | Required checks and optional language, title/label/body rules, templates, and automation |
| `spec_git/providers.yaml` | Explicit GitLab host declaration, when used |
| `.specgit.yaml` | This delivery's issue, execution-context, and PR/MR binding |

`init` creates shared integration assets and local hooks; `setup` installs local
agent entry points. Review generated changes before committing shared assets.
Neither a local refresh nor an ordinary merge authorizes package publication.
Acceptance state is derived on each invocation, never stored in a checklist.
The three tiers are authoritative delivery files, the derived committed harness,
and local integration assets.

Automatic merge and issue closure are **off by default**. Only the user's explicit
yes enables them; an agent cannot supply that decision. For an existing policy:

```bash
specgit init --force --automation yes --merge-target main
```

Once enabled, the trusted completion workflow continues after CI.
`specgit pr --merge --json` recovers interrupted completion: it checks the approved
target and current head, verifies acceptance and CI, confirms merge, then closes
bound issues. See [Team Workflow](docs/team-workflow.md) and [Actions](docs/actions.md).

## Upgrade an existing installation

Updating the package and refreshing a repository are separate steps:
Refresh generated assets after CLI upgrades with this explicit sequence:

```bash
npm install -g specgit@latest
specgit --version
specgit init --force --no-protect
specgit setup --tool all
specgit status --json
```

Review the resulting diff. Follow [Installation](docs/installation.md#upgrade-to-a-newer-cli-version)
for ownership conflicts and projects that intentionally track authoritative files
without the managed ignore block. Use `doctor` for a reported environment or
provider problem; `status` checks local state and generated-asset drift.
A refresh does not grant permission to change automation or release a package.

## Commands and agent integration

| Command | Purpose |
| --- | --- |
| `specgit init` | Initialize policy and integration assets; refresh explicitly with `--force` |
| `specgit setup` | Install or refresh OpenCode commands or portable agent skills |
| `specgit issue` | Start or resume the bound delivery |
| `specgit pr` | Repair the request binding; recover enabled completion with `--merge` |
| `specgit finish` | Read live acceptance and completion evidence |
| `specgit status` | Inspect local binding and generated-asset state |
| `specgit doctor` | Probe Git, repository, origin, forge CLI/authentication, and policy |
| `specgit bind`, `specgit unbind`, `specgit accept` | Script-level binding operations and the acceptance alias |

Humans may omit `--json`. Agents and scripts use its single stdout JSON envelope
and stable exit codes: `0` success/accepted, `1` rejected, `2` usage error,
`3` unknown, `130` interrupted. Diagnostics include a code and a repair direction.
See [CLI Reference](docs/cli.md) for flags and exact result shapes.
For `specgit status`, a missing record is normal before binding: exit `0` with
state `unbound`. That local snapshot is not a remote acceptance verdict.

`setup --tool generic` installs `.agents/skills/` entry points;
`setup --tool opencode` installs `.opencode/command/` entries; `--tool all`
refreshes both. Init-managed guards protect merge operations such as
`gh pr merge` and `glab mr merge`. `SPECGIT_GUARD_BUDGET_S` controls the hook's
verdict budget; it is not a general CLI setting. The forge overrides are
`SPECGIT_GH`, `SPECGIT_GH_TIMEOUT_MS`, `SPECGIT_GLAB`, and `SPECGIT_GLAB_TIMEOUT_MS`.
See the [Agent Contract](docs/agent-contract.md) for authorization and completion.

## Documentation and contributing

- [Project Wiki](https://github.com/LeXwDeX/SpecGit/wiki) · [中文 Wiki](https://github.com/LeXwDeX/SpecGit/wiki/Home-zh)
- [Getting Started](docs/getting-started.md) · [Installation](docs/installation.md) · [Existing Projects](docs/existing-projects.md)
- [Concepts](docs/concepts.md) · [CLI Reference](docs/cli.md) · [Schemas and gates](docs/reference.md)
- [Team Workflow](docs/team-workflow.md) · [CI scope](docs/ci-scope.md) · [Agent Contract](docs/agent-contract.md)
- [GitLab support](docs/gitlab-support.md) · [Troubleshooting](docs/troubleshooting.md) · [FAQ](docs/faq.md)
- [Contributing](CONTRIBUTING.md) · [Release gates](docs/release-gates.md) · [Changelog](CHANGELOG.md)

The Wiki provides English and Chinese introductions; detailed contracts live in
`docs/`. Repository copies of Wiki pages live in `docs/wiki/`. Publishing the Wiki
is a separate update, so editing those files alone does not update the live site.

SpecGit uses your authenticated `gh`/`glab` session without storing tokens or
sending telemetry. Report vulnerabilities through the repository's private
security advisory channel. Workflow permissions and supply-chain guidance are
in [Actions security](docs/actions.md#security-guidance).

MIT — see [LICENSE](LICENSE).
