<p align="center">
  <a href="https://github.com/LeXwDeX/SpecGit"><strong>SpecGit</strong></a><br/>
  <em>Acceptance for deliveries, derived from evidence — not artifacts.</em>
</p>

<p align="center">
  <a href="https://github.com/LeXwDeX/SpecGit/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/LeXwDeX/SpecGit/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square" /></a>
</p>

---

## For AI agents: start SpecGit in a project

When the user says something like **“在本项目中启动 specgit 规范：
https://github.com/LeXwDeX/SpecGit”** (or points you at this repository),
execute this protocol — no further questions needed:

1. Install the CLI: `npm install -g specgit`
2. Verify prerequisites: `git --version` and `gh auth status`
   (if `gh` is not authenticated, ask the user to run `gh auth login`)
3. In the repository root: `specgit init` (auto-detects the required CI
   checks) then `specgit setup` (installs your entry points: commands for
   opencode, portable skills for other tools)
4. Commit the generated harness (`spec_git/`, `.github/workflows/specgit-accept.yml`,
   `AGENTS.md` managed block, hooks) on a branch and open a PR
5. Confirm with `specgit doctor --json` and report the result

From then on, deliveries are two commands: `specgit issue "<title>"` →
work → `specgit finish` (exit 0 is the only done). The AGENTS.md managed
block is your behavior contract.

## What SpecGit is

SpecGit defines **done** as a verifiable fact. A delivery is one aggregate:

```text
execution context (branch or worktree)
  + issues[]  (GitHub issues it closes)
  + one pull request
  + required CI checks
```

`specgit finish` re-derives the verdict from **live evidence** — your git
checkout, the issues, the PR's closing references, and the check runs
reported at the PR head commit. There are no spec files, no task lists, no
artifact states that can claim completion for themselves. If the evidence
can't be gathered, the answer is `unknown`, never `accepted` — SpecGit
**fails closed**.

## Quick start

```bash
# 0. prerequisites: Node ≥ 20.19, git, and gh authenticated
gh auth status || gh auth login

# 1. install (once published): npm install -g specgit
specgit --version

# 2. once per repository — declare the required CI checks and generate the
#    harness (.github/workflows/specgit-accept.yml + the managed AGENTS.md block)
specgit init                          # auto-detects checks from your CI workflows
specgit setup                         # install agent entry points (commands/skills)
specgit doctor                       # all probes green?

# The loop
# 3. per delivery — one command bootstraps everything
#    (creates the issues, branches, opens the draft PR with Closes #n for
#     every issue, writes .specgit.yaml, commits and pushes; re-run resumes)
specgit issue "feat: add login" "Harden the session model"

# 4. work, push; CI runs on the PR — including the SpecGit Acceptance job

# 5. gate the merge on evidence
specgit finish                       # exit 0 → merge; else fix what it names
```

`specgit finish` exit `0` is the *only* definition of done. The full
walkthrough (worktrees, N issues per PR, the agent operating loop) is in the
[Workflow Guide](docs/workflow-guide.md).

(Condensed in [Quick start](#quick-start) above; the
[Workflow Guide](docs/workflow-guide.md) expands every step. `bind`,
`unbind`, and `accept` remain as machine aliases for scripts — `accept`
runs the same evaluation as `finish`.)

Two committed files, zero other state. One PR may close N issues; every bound
issue must be closed from the PR body; checks are matched byte-for-byte
against the names in `spec_git/policy.yaml`.

## Why evidence, not artifacts

Checklists and task files let whoever edits them declare "done." SpecGit
instead asks git and GitHub:

- Is this checkout the record's branch/worktree? *(context gates)*
- Do the bound issues exist? *(issue gates)*
- Is the PR open (or merged), on the right branch, in this repo? *(PR gates)*
- Does the PR body close **every** bound issue? *(closing-ref gate)*
- Is every required check green **at the PR head commit**? *(check gates)*

Ten ordered gates, each reporting stable diagnostic codes with fixes. Verdicts
are computed per invocation and never persisted, so they cannot drift from
reality.

## Commands

| Command | Does | Network |
| --- | --- | --- |
| `specgit issue` | One-command bootstrap: create/reuse issues, branch, draft PR closing every issue, record, commit, push (idempotent resume) | yes (`gh`) |
| `specgit finish` | The verdict — full evaluation → accepted / rejected / unknown | yes (`gh`) |
| `specgit pr` | Repair the PR binding: auto-discover by head branch, or bind an explicit PR | yes (`gh`) |
| `specgit init` | Creates the policy `spec_git/policy.yaml` (auto-detects checks from CI workflows) and generates the harness (acceptance workflow + guard hooks + managed AGENTS block) | no |
| `specgit setup` | Installs agent entry points: `.opencode/command/` for opencode, portable skills for other tools (`--tool opencode \| generic \| all`) | no |
| `specgit status` | Local evidence snapshot (record, policy, git facts, drift) | no |
| `specgit doctor` | Probes prerequisites (git, repo, origin, gh, policy) | gh auth |
| `specgit bind` / `unbind` / `accept` | Machine aliases for scripts: record edits, and the same evaluation as `finish` | accept: yes (`gh`) |

Every command supports `--json` (one JSON document on stdout, human text on
stderr). Exit-code contract: `0` accepted/success · `1` rejected with complete
evidence · `2` usage error · `3` fail-closed unknown. Requirements: Node ≥
20.19, `git`, and `gh` (authenticated) for GitHub evidence. There is no
telemetry and no configuration beyond the two files.

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
[the skills index](skills/README.md). A guided `specgit setup` installer for
the whole agent surface is tracked in
[#7](https://github.com/LeXwDeX/SpecGit/issues/7).

## Releasing

Releases are automatic and PR-gated. A feature/fix branch carries its
changeset (`.changeset/*.md`); merging the PR to `main` triggers the Release
workflow: consume changesets → bump → build → `npm publish` → tag
`v<version>` → GitHub Release. Direct pushes to `main` are blocked by the
pre-push guard, so **every published version traces to a merged PR**.
Prerequisite (repo admin, once): an npm **trusted publisher** bound to this
repository + `release-prepare.yml` workflow + the `NPM` environment (OIDC,
no long-lived token; provenance included).

## Documentation

- [Documentation home](docs/README.md)
- [Getting Started](docs/getting-started.md) · [Installation](docs/installation.md)
- [Concepts](docs/concepts.md) · [Overview](docs/overview.md)
- [CLI Reference](docs/cli.md) · [Reference (schemas, gates, codes)](docs/reference.md)
- [GitHub Actions usage & security](docs/actions.md)
- [Examples & Recipes](docs/examples.md) · [Existing Projects](docs/existing-projects.md)
- [Troubleshooting](docs/troubleshooting.md) · [FAQ](docs/faq.md) · [Glossary](docs/glossary.md)

## Security

SpecGit reads git facts and GitHub evidence (via your existing `gh` session);
it writes only its two YAML files. It never reads, prints, or stores tokens,
performs no telemetry, and sanitizes API-sourced strings before rendering.
For workflow-side guidance — permissions, secrets, fork PRs, supply chain —
see [GitHub Actions security](docs/actions.md#security-guidance). To report a
vulnerability in SpecGit itself, open a private security advisory on this
repository.

## License

MIT — see [LICENSE](LICENSE).
