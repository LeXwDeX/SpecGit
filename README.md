<p align="center">
  <a href="https://github.com/LeXwDeX/SpecGit"><strong>SpecGit</strong></a><br/>
  <em>Acceptance for deliveries, derived from evidence — not artifacts.</em>
</p>

<p align="center">
  <a href="https://github.com/LeXwDeX/SpecGit/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/LeXwDeX/SpecGit/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://www.npmjs.com/package/specgit"><img alt="npm" src="https://img.shields.io/npm/v/specgit?style=flat-square" /></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square" /></a>
</p>

---

## For AI agents: start SpecGit in a project

When the user says something like **"Set up the SpecGit discipline in this
project: https://github.com/LeXwDeX/SpecGit"** (or points you at this
repository), execute this protocol — no further questions needed:

1. Install the CLI: `npm install -g specgit`
2. Verify prerequisites: `git --version`, and `gh auth status` for GitHub
   repos (`glab auth status --hostname <host>` for GitLab; if not
   authenticated, ask the user to run the matching `… auth login`)
3. In the repository root: `specgit init` (auto-detects the required CI
   checks; add `--gitlab-host <hostname>` when the origin is a self-managed
   GitLab instance) then `specgit setup` (installs your entry points:
   commands for opencode, portable skills for other tools)
4. Commit the generated harness (`spec_git/`, the acceptance workflow,
   `AGENTS.md` managed block, hooks) on a branch and open a PR
5. Confirm with `specgit doctor --json` and report the result

From then on, deliveries are two commands: `specgit issue "<title>"` →
work → `specgit finish` (exit 0 is the only done). The AGENTS.md managed
block is your behavior contract.

## What SpecGit is

SpecGit defines **done** as a verifiable fact. A delivery is one aggregate:

```text
execution context (branch or worktree)
  + issues[]  (forge issues it closes — GitHub or GitLab)
  + one pull request (or merge request)
  + required CI checks
```

`specgit finish` re-derives the verdict from **live evidence** — your git
checkout, the issues, the PR's closing references, and the check runs
reported at the PR head commit. There are no spec files, no task lists, no
artifact states that can claim completion for themselves. If the evidence
can't be gathered, the answer is `unknown`, never `accepted` — SpecGit
**fails closed**.

## Platforms

One CLI, one harness, two forges — the platform is **declared, never
guessed**:

- **GitHub.com** works out of the box: evidence flows through your
  authenticated `gh` session.
- **Self-managed GitLab CE/Free** `>= 19.2.4 < 19.3.0` is supported since
  1.0: declare the host once (`specgit init --gitlab-host <hostname>`,
  persisted in `spec_git/providers.yaml`) and evidence flows through your
  authenticated `glab` session (`glab` ≥ 1.113.0). Nested-group origins
  (`group/subgroup/project`) are first-class; the version window is
  fail-closed. Full policy, evidence ledger, and SaaS (GitLab.com)
  capability probing: [GitLab support](docs/gitlab-support.md).
- GitHub Enterprise is declaration-and-diagnostics only (non-goal for v1);
  one delivery never spans platforms.

## Quick start

```bash
# 0. prerequisites: Node ≥ 20.19, git, and gh authenticated
#    (GitLab repos additionally need glab authenticated for that host)
gh auth status || gh auth login

# 1. install
npm install -g specgit
specgit --version

# 2. once per repository — declare the required CI checks and generate the
#    harness (acceptance workflow + the managed AGENTS.md block)
specgit init                          # auto-detects checks from your CI workflows
specgit init --gitlab-host git.example.com   # self-managed GitLab instead
specgit setup                         # install agent entry points (commands/skills)
specgit doctor                        # all probes green?

# The loop
# 3. per delivery — one command bootstraps everything
#    (creates the issues, branches, opens the draft PR with Closes #n for
#     every issue, writes .specgit.yaml, commits and pushes; re-run resumes)
specgit issue "feat: add login" "Harden the session model"

# 4. work, push; CI runs on the PR — including the acceptance job

# 5. gate the merge on evidence
specgit finish                       # exit 0 → merge; else fix what it names
```

`specgit finish` exit `0` is the *only* definition of done. The full
walkthrough (worktrees, N issues per PR, the agent operating loop) is in the
[Workflow Guide](docs/workflow-guide.md).

State and assets, in three tiers: **authoritative committed files**
(`spec_git/policy.yaml`, `.specgit.yaml`, optional `spec_git/providers.yaml`),
a **derived committed harness** (the acceptance workflow and the managed
AGENTS/CLAUDE block — regenerable with `init --force`), and **local
integration assets** (guard hooks and `setup` entry points, merged
non-destructively). Verdicts are never persisted. One PR may close N issues;
every bound issue must be closed from the PR body; checks are matched
byte-for-byte against the names in `spec_git/policy.yaml`. Full table:
[Reference](docs/reference.md#state-and-assets).

## Why evidence, not artifacts

Checklists and task files let whoever edits them declare "done." SpecGit
instead asks git and the forge:

- Is this checkout the record's branch/worktree? *(context gates)*
- Do the bound issues exist? *(issue gates)*
- Is the PR open (or merged), on the right branch, in this repo? *(PR gates)*
- Does the PR body close **every** bound issue? *(closing-ref gate)*
- Is every required check green **at the PR head commit**? *(check gates)*

Eleven ordered gates, each reporting stable diagnostic codes with fixes. Verdicts
are computed per invocation and never persisted, so they cannot drift from
reality.

## Commands

| Command | Does | Network |
| --- | --- | --- |
| `specgit issue` | One-command bootstrap: create/reuse issues, branch, draft PR closing every issue, record, commit, push (idempotent resume) | yes (`gh`/`glab`) |
| `specgit finish` | The verdict — full evaluation → accepted / rejected / unknown | yes (`gh`/`glab`) |
| `specgit pr` | Repair the PR binding: auto-discover by head branch, or bind an explicit PR | yes (`gh`/`glab`) |
| `specgit init` | Creates the policy `spec_git/policy.yaml` (auto-detects checks from CI workflows; `--gitlab-host` declares a GitLab origin) and generates the harness (acceptance workflow + guard hooks + managed AGENTS block) | no |
| `specgit setup` | Installs agent entry points: `.opencode/command/` for opencode, portable skills for other tools (`--tool opencode \| generic \| all`) | no |
| `specgit status` | Local evidence snapshot (record, policy, git facts, drift) | no |
| `specgit doctor` | Probes prerequisites (git, repo, origin, forge CLI, policy) | forge auth |
| `specgit bind` / `unbind` / `accept` | Machine aliases for scripts: record edits, and the same evaluation as `finish` | accept: yes (`gh`/`glab`) |

Every command supports `--json` (one JSON document on stdout, human text on
stderr). Exit-code contract: `0` accepted/success · `1` rejected with complete
evidence · `2` usage error · `3` fail-closed unknown · `130` the Ctrl-C
interruption exception (no envelope — see the [CLI reference](docs/cli.md)).
One documented exception: `specgit status` reports a missing record as the
healthy pre-binding state — exit `0` with state `unbound` (#175).
Environment inputs: `SPECGIT_GH` / `SPECGIT_GH_TIMEOUT_MS` and
`SPECGIT_GLAB` / `SPECGIT_GLAB_TIMEOUT_MS` (executable path and per-call
timeout per forge CLI, defaults: `gh`/`glab` on PATH, 15 s). Requirements:
Node ≥ 20.19, `git`, and `gh` (authenticated) for GitHub evidence — or
`glab` (authenticated) for a declared GitLab host. There is no telemetry and
no configuration beyond the three file tiers. The versioned contract —
platforms, commands, state, compatibility, non-goals, deprecation — is
pinned in the [Product Baseline v1](docs/baseline-v1.md).

## Built for teams and agents

- **Teams**: the policy is a committed contract — change required checks the
  way you change code, aligned with branch protection. See
  [Team Workflow](docs/team-workflow.md) and
  [GitHub Actions guidance](docs/actions.md).
- **AI agents**: stable commands, contractual exit codes, one JSON envelope —
  and the rule that `specgit finish` exit `0` is the *only* definition of
  done. `specgit init` injects the managed agent block into `AGENTS.md`; see
  the [Agent Contract](docs/agent-contract.md).

### Agent guard hooks

`specgit init` also installs two guard hooks (both idempotent, re-run safe):

| Hook | Layer | What it does |
| --- | --- | --- |
| `.opencode/hooks.json` + `.opencode/hooks/specgit-merge-guard.sh` | opencode PreToolUse | Blocks `gh pr merge` / push-to-main tool calls that bypass the verdict, with the iron-rule reason |
| `.git/hooks/pre-push` | git | Refuses direct pushes to `main` — deliveries must go PR → CI → finish |

Event-driven beats periodic prompting: the guard fires exactly at the
highest-risk moment, not every N turns. For other tools (codex, pi-agent,
cursor, …) the portable entry points live in [`skills/`](skills/) — see
[the skills index](skills/README.md); `specgit setup` installs them.

## Releasing

Releases are automatic, PR-gated, and OIDC-based. A feature/fix branch carries
its changeset (`.changeset/*.md`); merging it to `main` makes the Release
workflow open (or update) the **version PR** (`changeset-release/main`) with
the consumed version bump — the manual batch-decision point. Merging *that*
PR lands `chore(release): v<version>` on `main`, which builds, verifies the
packed version, and publishes to npm via **OIDC trusted publishing** (no
long-lived token, no environment secret; provenance included), then tags
`v<version>` and creates the GitHub Release. Each step is idempotent —
decided by tag and npm existence — so replays never double-publish, and
release candidates can be verified (dry-run publish, tarball inspection)
without accidentally shipping the final version. Direct pushes to `main`
are blocked by the pre-push guard, so **every published version traces to a
merged PR**. Prerequisite (repo admin, once): an npm **trusted publisher**
bound to this repository and the Release workflow's OIDC token.

## Documentation

- [Documentation home](docs/README.md)
- [Getting Started](docs/getting-started.md) · [Installation](docs/installation.md)
- [Product Baseline v1](docs/baseline-v1.md) — the versioned public contract
- [Release gates](docs/release-gates.md) — the invariants and evidence protocol for shipping
- [GitLab support](docs/gitlab-support.md) — platforms, version window, evidence ledger
- [Concepts](docs/concepts.md) · [Overview](docs/overview.md)
- [CLI Reference](docs/cli.md) · [Reference (schemas, gates, codes)](docs/reference.md)
- [GitHub Actions usage & security](docs/actions.md)
- [Examples & Recipes](docs/examples.md) · [Existing Projects](docs/existing-projects.md) (adoption & uninstall)
- [Troubleshooting](docs/troubleshooting.md) · [FAQ](docs/faq.md) · [Glossary](docs/glossary.md)

## Community

- [Contributing](CONTRIBUTING.md) — development setup, the delivery workflow, and PR expectations
- [Support](SUPPORT.md) — where to ask what, and how to report bugs and security issues
- [Code of Conduct](CODE_OF_CONDUCT.md) — applies to every interaction in this project
- [Maintainers](MAINTAINERS.md) · [Security policy](SECURITY.md)

## Security

SpecGit reads git facts and forge evidence through your existing
authenticated CLI sessions (`gh` for GitHub, `glab` for GitLab); it writes
only the [three file tiers](docs/reference.md#state-and-assets) —
authoritative YAML, the derived harness, and local hook wiring. It never
reads, prints, or stores tokens, performs no telemetry, and sanitizes
API-sourced strings before rendering. For workflow-side guidance —
permissions, secrets, fork PRs, supply chain — see
[GitHub Actions security](docs/actions.md#security-guidance). To report a
vulnerability in SpecGit itself, open a private security advisory on this
repository.

## License

MIT — see [LICENSE](LICENSE).
