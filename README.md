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

The flow at a glance:

```text
  specgit init / setup      once per repository: policy + acceptance
        |                   harness + agent entry points
        v
  specgit issue "..."       per delivery: issues + branch +
        |                   draft PR (Closes #n) + record,
        |                   committed and pushed (idempotent resume)
        v
  work, commit, push -----> CI on the PR head
        |                   (the SpecGit Acceptance job runs
        |                    specgit finish --json)
        v
  gh pr ready <n>           a draft PR always fails the verdict
        |
        v
  specgit finish            the verdict: eleven gates, fail-closed
        |-- exit 0 --> accepted → merge → confirmed issue closure: completed
        |-- exit 1 --> fix what the gates named (evidence complete)
        '-- exit 3 --> fix the environment first (specgit doctor)
```

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
   GitLab instance). Ask the user whether to enable automatic merge and issue
   closure: **yes/no, default no**. Never answer yes on the user's behalf.
   Then run `specgit setup` (installs your entry points:
   commands for opencode, portable skills for other tools)
4. Review the generated changes. Local initialization or an entry-point refresh
   does not itself require an issue, PR, build, or release. If the user intends
   to share the acceptance workflow or project rules, deliver those selected
   tracked changes through a PR; keep local hooks and device state local
5. Confirm with `specgit doctor --json` and report the result

From then on, deliveries are two commands: `specgit issue "<title>"` →
work → `specgit finish` (exit 0 is acceptance before merge). The AGENTS.md managed
block is your behavior contract. Once the user authorizes delivery, the agent
executes the returned `nextActions`, fills the issue/PR bodies from the agreed
scope, fixes failures, and follows CI through the verified merge and any
authorized release. Routine commands are agent work; an existing authorization
does not expire at the merge brief. Missing credentials or a failed gate remain
explicit blockers. `finish` itself stays a read-only evidence verdict.

Choose verification from the intended tracked diff, not from the command that
created it. Shared documentation and project rules receive lightweight checks;
CLI source, shipped templates, schemas, build dependencies, and unknown or mixed
changes receive product CI. `.gitignore` controls tracking, never CI exemptions.
Publishing requires explicit release intent. The binding classification is
[CI scope](docs/ci-scope.md).

Initialization creates SpecGit's own acceptance workflow and local integration
assets; sharing that workflow is an adoption decision. It must not rewrite an
adopting project's business workflows, build commands, or dependencies. Current
init/setup are not a local-only installation mode: they can update tracked
shared files, which must be reviewed before committing.

Automatic merge and closure are opt-in. First interactive initialization asks
with **no** as the default. A normal `init --force` preserves the saved choice;
explicit `--automation yes|no` changes it.
Answering yes saves `automation.merge`, `automation.target_branch`, and
`automation.close_issues` in the policy. Use `--merge-target <branch>` to
specify the destination; otherwise init must prove the remote default branch.
Scripts can supply the user's answer with `--automation yes|no`; without an
answer, first non-interactive init leaves automation disabled and reports that choice.
Once enabled, `specgit pr --merge` requires acceptance and all current CI/CD
checks to pass for the exact head, merges into the configured target, confirms
the merged state, and explicitly closes bound issues. `specgit init --force` lets
the user explicitly enable it later or turn it off again. Enabled projects use
a trusted remote completion runner, so closing the agent conversation does not
interrupt merge and closure. Failed ready PRs produce repair issues; the original
business issues remain open until their delivery is confirmed.

## Project title and label rules

Project rules are optional. Configure them interactively with
`specgit init --force --configure-rules`, or use explicit script options:

```bash
specgit init --force --language en --title-check yes --label-check kind
specgit init --force --language zh --title-check yes --label-check project \
  --allowed-label kind::fix --allowed-label module::auth
```

Title validation is a deterministic character rule: English titles contain no
Han characters; Chinese titles contain at least one Han character and may keep
English technical names. It checks every bound issue and the PR/MR title.
`kind` label mode requires exactly one built-in `kind::` label and allows only
project-declared extras; `project` mode requires a nonempty selection from the
policy's `tags`. Both allow at most one label per scoped axis. The configuration
session offers English/Chinese, title validation on/off, and the label mode;
project mode then offers the available label vocabulary for selection.

`issue` checks these rules before creating or changing delivery state, and
`finish` checks the live forge titles and issue labels. A proven violation
rejects acceptance; missing evidence returns unknown. Policies without
`validation` keep the existing behavior. See the [CLI rules](docs/cli.md#project-title-and-label-rules)
for the full contract.

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
- **Self-managed GitLab CE/Free** `>= 19.2.4 < 19.4.0` is supported since
  1.0: declare the host once (`specgit init --gitlab-host <hostname>`,
  persisted in `spec_git/providers.yaml`) and evidence flows through your
  authenticated `glab` session (`glab` ≥ 1.113.0). Nested-group origins
  (`group/subgroup/project`) are first-class; the verified window is
  advisory — outside versions warn (`gitlab_version_unverified`) while
  the live API evidence stays fail-closed. Full policy, evidence ledger, and SaaS (GitLab.com)
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
#    protection ordering: on a fresh adoption init's confirm defaults to
#    "no" (the harness is not on the default branch yet; a required check
#    no PR can pass would lock out non-admin merges) and the output lists
#    the adoption steps — carry the policy with `git add -f` (it is
#    gitignored by default), merge the adoption PR, then re-run
#    `specgit init --force --protect` after that first merge.

# The loop
# 3. per delivery — one command bootstraps everything
#    (creates the issues, branches, opens the draft PR with Closes #n for
#     every issue, tags them — the title's kind::<type> by default, or
#     --tags kind::feat,module::auth for an explicit pool-first selection
#     that seeds declared vocabulary when missing; re-run resumes)
specgit issue "feat: add login" "security: harden the session model"

# 4. work, push; CI runs on the PR — including the acceptance job

# 5. mark the draft ready, then gate the merge on evidence
gh pr ready <number>                  # GitLab: glab mr update <number> --ready
specgit finish                       # exit 0 → merge; else fix what it names
```

`specgit finish` exit `0` means accepted. A delivery is completed only after
the platform confirms the merge and every bound issue is closed. The full
walkthrough (worktrees, N issues per PR, the agent operating loop) is in the
[Workflow Guide](docs/workflow-guide.md).

State and assets, in three tiers: **authoritative delivery files**
(`spec_git/policy.yaml`, `.specgit.yaml`, optional `spec_git/providers.yaml`
— shielded from everyday commits by a managed `.gitignore` region that
`init` writes by default and reconciles on upgrade, and carried into git
only by the bootstrap's own binding commit, where the CI verdict can read
them; `--no-ignore` keeps the classic committed model), a **derived
committed harness** (the acceptance workflow and the managed
AGENTS/CLAUDE block — converged to the running version by `init --force`,
which also removes obsolete SpecGit-owned assets it can prove ownership
of and rolls the whole local mutation — bytes, modes, symlinks, and created
directories — back on failure), and **local
integration assets** (guard hooks and `setup` entry points — likewise
converged to the running version by re-running `specgit setup`, which
removes retired SpecGit-owned entry points only with proven ownership,
preserves unmarked files, and never touches the unselected surface).
Tool detection uses existing OpenCode configuration or user entry points;
the guard files generated by `init` alone do not select OpenCode. Use
`specgit setup --tool generic|opencode|all` for an explicit choice.
`specgit status` is the read-only check of that convergence (#308): its
`assets.generated` report names every stale, missing, or conflicting
generated asset with the exact command that repairs its surface, and
fail-closed about its own coverage — `clean` requires `complete`, an
`uninspected` part means incomplete (never clean), while a proven opt-out
(`skipped`) does not — the numbered upgrade sequence is in
[Installation](docs/installation.md#upgrade-to-a-newer-cli-version).
Verdicts are never persisted. One PR may close N issues;
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
| `specgit issue` | One-command bootstrap: create/reuse issues, branch, draft PR closing every issue, tag them (pool-first, #330), record, commit, push (idempotent resume) | yes (`gh`/`glab`) |
| `specgit finish` | The verdict — full evaluation → accepted / rejected / unknown | yes (`gh`/`glab`) |
| `specgit pr` | Repair the PR binding: auto-discover by head branch, or bind an explicit PR | yes (`gh`/`glab`) |
| `specgit init` | Creates the policy `spec_git/policy.yaml` (auto-detects checks from CI workflows; `--gitlab-host` declares a GitLab origin) and generates the harness (acceptance workflow + guard hooks + managed AGENTS block); by default also shields the local delivery assets in `.gitignore` (`--no-ignore` opts out) | gh (protection probe) |
| `specgit setup` | Installs agent entry points: `.opencode/command/` for opencode, portable skills under `.agents/skills/` for other tools (`--tool opencode \| generic \| all`) | no |
| `specgit status` | Local evidence snapshot (record, policy, git facts, drift) plus the generated-asset drift report — the local upgrade check: per-surface current/stale/missing/conflict states with the exact fix command (`assets.generated`, #308) | no |
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
timeout per forge CLI, defaults: `gh`/`glab` on PATH, 15 s), plus
hook-only `SPECGIT_GUARD_BUDGET_S` (seconds — the merge-guard hook's
verdict budget; the CLI never reads it). Requirements:
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
| `.opencode/hooks.json` + `.opencode/hooks/specgit-merge-guard.sh` | opencode PreToolUse (Bash \| Edit \| Write) | Blocks `gh pr merge` / `glab mr merge` / direct push-to-main tool calls that bypass the verdict, and file-mutation tool calls (`edit`/`write`) on a branch with no delivery binding — the start gate (#335): start with `specgit issue` first |
| `.git/hooks/pre-push` | git | Refuses direct pushes to `main` — deliveries must go PR → CI → finish. Pushing a commit that is already merged into `origin/main` (post-release mirror sync) is allowed (#343) |

Event-driven beats periodic prompting: the guard fires exactly at the
highest-risk moment, not every N turns. For other tools (codex, pi-agent,
cursor, …) the portable entry points live in [`skills/`](skills/) — the
generated distribution mirror of the entry points `specgit setup` installs
under `.agents/skills/` in a project; see
[the skills index](skills/README.md).

## Releasing

Releases use version PRs and OIDC trusted publishing. An explicitly authorized
package release carries a changeset (`.changeset/*.md`); local maintenance,
shared-rule edits, and an ordinary merge do not imply publication. Merging a
release-intent changeset to `main` makes the
Release workflow open (or update) the **version PR**
(`changeset-release/main`) with the consumed version bump. Automatic merging
is **off by default**. To enable it, run `specgit init --force`, answer
`yes`, and select `main` as the merge target. The Release workflow reads
`automation.merge: true` and `automation.target_branch: main` from the
policy; otherwise it leaves the version PR open and reports that automation
is disabled. When enabled, it waits up to 20 minutes for all CI on the exact
version head, including classic statuses and workflow runs. Non-required
skipped jobs may be omitted; failed or incomplete checks block the merge.
The merge request is conditional on that SHA and its merged state is
verified, with branch protection still enforced.

The repository defines `RELEASE_BOT_TOKEN` (a fine-grained PAT or GitHub App
token with contents + pull-requests write) so version-PR events start CI
without manual approval. Missing permissions or approval-blocked runs fail
visibly. Merging that
PR lands `chore(release): v<version>` on `main`, which builds, verifies the
packed version, and publishes to npm via **OIDC trusted publishing** (no
long-lived token, no environment secret; provenance included), then tags
`v<version>` and creates the GitHub Release. The publish gate is registry
evidence — no pending changesets and `package.json`'s version absent from npm
— so the merge strategy never decides whether a release ships, and a failed
publish can be retried from the workflow's manual dispatch on `main` only.
Replays recover a missing tag or GitHub Release independently of npm publication:
the published version's `gitHead` identifies the source commit, and an existing
tag must agree with it. Registry failures fail closed; only a verified npm 404
means unpublished. Replays never double-publish, and release candidates can be verified (dry-run publish,
tarball inspection) without accidentally shipping the final version. Direct
pushes to `main` are blocked by the pre-push guard, so **every published
version traces to a merged PR**. Prerequisite (repo admin, once): an npm
**trusted publisher** bound to this repository and the Release workflow's
OIDC token.

## Documentation

- [Documentation home](docs/README.md)
- [Getting Started](docs/getting-started.md) · [Installation](docs/installation.md)
- [Product Baseline v1](docs/baseline-v1.md) — the versioned public contract
- [Release gates](docs/release-gates.md) — the invariants and evidence protocol for shipping
- [2026-09-04 full project audit](docs/audits/2026-09-04-full-project-audit.md) — confirmed corrections, verification scope, and architecture dispositions
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
