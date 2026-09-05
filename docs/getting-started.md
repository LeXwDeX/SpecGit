# Getting Started

This guide takes you from zero to your first **accepted** delivery. For installation details see [Installation](installation.md); for the underlying model see [Concepts](concepts.md).

```text
  specgit init / setup      initialize once; rerun after upgrades
        |                   harness + agent entry points
        v
  specgit issue "..."       per delivery: issues + branch +
        |                   draft PR/MR (Closes #n) + record,
        |                   committed and pushed (idempotent resume)
        v
  work, commit, push -----> CI/CD on the request head
        |                   (the platform acceptance job runs
        |                    specgit finish --json)
        v
  mark PR/MR ready          a draft request always fails the verdict
        |
        v
  specgit finish            the verdict: eleven gates, fail-closed
        |-- exit 0 --> accepted -> merge -> confirmed issue closure: completed
        |-- exit 1 --> fix what the gates named (evidence complete)
        '-- exit 3 --> follow errors[].fix; use doctor for its probes
```

## The loop in one screen

```bash
# initialize, and run again after package upgrades
specgit init            # auto-detects checks or offers a proven-drift refresh

# per delivery: one command bootstraps issues, branch, draft PR, record
specgit issue "feat: add login flow"

# after CI (including the SpecGit Acceptance job) is green on the PR
specgit finish
# exit 0 → accepted · exit 1 → rejected (evidence attached) · exit 3 → cannot determine
```

That is the core human delivery loop. The CLI has ten commands: `init` and
`setup` install the project surfaces; `pr`, `status`, and `doctor` repair or
diagnose them; `bind`/`unbind`/`accept` remain script aliases.

## Step by step

### 1. Initialize the policy and the harness

On the repository's default branch, declare which CI check names a delivery must pass:

```bash
specgit init                                  # auto-detect from CI files
specgit init --required-check "Build"         # or name them explicitly
```

With no arguments the check names are auto-detected from the repository's CI files (GitHub workflow job names, GitLab CI job keys). A repository with no product CI gets an empty list. On GitHub the generated `SpecGit Acceptance` job remains the protected gate and is never listed in its own policy. On GitLab the project's reviewed pipeline must run `specgit finish --json`, and the platform's pipeline-success protection remains authoritative. The usual pattern is to add a stable aggregator check and re-pin its exact name.

Init resolves a supported forge before writing. Only exact `github.com` origins
select GitHub automatically; declare GitLab with `--gitlab-host`, or confirm it
interactively for that endpoint. The prompt cannot select GitHub Enterprise.
Missing or invalid platform evidence exits `3` without mutation. When the run
will generate a platform workflow or configure branch protection, init also
proves the remote default branch from `origin/HEAD` before starting the local
transaction; missing branch evidence leaves policy, harness, and protection
unchanged. A failed provider declaration write restores its pre-run state before
stopping.

This creates `spec_git/policy.yaml` and the managed agent block. On GitHub it also generates `.github/workflows/specgit-accept.yml`, which runs `specgit finish --json` on every PR. On GitLab it never invents the business acceptance job: with automation off it warns `gitlab_harness_pending`; with automation on it installs the separate completion router and continuation around the byte-preserved business configuration. With a valid existing policy, plain interactive `init` asks about an upgrade only when its read-only inspector proves a required init asset or installed setup surface stale or missing. A detected ownership conflict returns `asset_conflict` (exit 3) before any prompt or write. Yes performs the equivalent of `init --force --no-protect` plus `setup --tool all` while preserving policy and automation choices and skipping remote protection; in the intentionally tracked authoritative model, that init also includes `--no-ignore` and setup preserves the proven opt-out. No leaves files untouched and returns `policy_exists`. Current assets, `--json`, non-TTY use, and an inspection that cannot prove drift never trigger an implicit refresh. A protection change remains a separate deliberate `--protect` invocation.

```yaml
version: 1
required_checks:
  - "Build"
```

Repeat `--required-check` for additional check names. By default init shields
`spec_git/` in a managed `.gitignore` block. The bootstrap's binding commit
force-stages the policy on the delivery branch so CI can read the approved
bytes; an adoption PR that carries it manually must also use `git add -f` (or
initialize with `--no-ignore`). Once shared, it is the reviewed project
contract. See [GitHub Actions](actions.md) for how to pick and wire check names.

### 2. Bootstrap the delivery with one command

From the repository's default branch, run:

```bash
specgit issue "feat: add login flow"
```

Each argument is one independently verifiable WHY: a quoted title creates a new issue; a pure number reuses an existing issue on the routed forge. N arguments bind N issues to **one** delivery. The command creates the branch `feat/<first-issue#>-<slug>`, opens the draft PR with a `Closes #n` reference for every issue in its body, writes the record, commits, and pushes. Re-run the same command to resume after any failure between steps.

It writes `.specgit.yaml` at the repository root (already committed on the delivery branch):

```yaml
version: 1
delivery: add-login-flow
context:
  kind: branch
  branch: feat/123-add-login-flow
issues: [123]
pr: 42
```

Rules that matter:

- One issue = one independently verifiable WHY; if a deliverable cannot be verified on its own evidence, split it before binding.
- The branch `type` is validated against a fixed whitelist (`feat`, `fix`, `chore`, … full list in the CLI reference). Titles may use either supported language unless the project enables `validation.titles`; then English titles contain no Han characters and Chinese titles contain at least one. A slug is derived only when the entire title is printable ASCII, using its first three words. Any non-ASCII or wordless title requires `--delivery <slug>` (or the interactive prompt) — bootstrap never invents a name.
- `context` is filled in automatically from live git — never hand-edit it. (The `bind` alias exists for script-level record surgery.)

If the policy enables body validation or selects templates with required
sections, prepare the content before bootstrap: repeat `--body-file <path>` once
for each new title and pass `--pr-body-file <path>` for the new PR/MR. Numeric
reuse and resume preserve the remote body. Without body rules, the built-in
scaffold remains advisory and can be filled after creation.

### 3. Work, push, and keep the closing refs

Work on the branch the bootstrap created (or a worktree of it — context is always resolved from live git). The PR/MR body must contain a closing reference for **every** bound issue:

```markdown
Closes #123
```

Supported forms: `Closes #123`, `owner/repo#123`, and full issue URLs, with any of the closing keywords (`closes`, `fixes`, `resolves`, and their tense variants). Missing references produce `closing_refs_incomplete` at acceptance. If the request binding is ever lost, `specgit pr` auto-discovers the PR/MR by head branch and repairs the record.

If the bound request was closed without merge, `issue` does not resume it or
replace it with new titles. It exits `1` with `pr_closed_unmerged` and preserves
the record. Reopen the request, or create/find an open draft PR/MR from the
recorded branch with every closing reference and run `specgit pr <number>`.
Start a new WHY only after that failed binding is repaired.

### 4. Pass the required checks

Your CI/CD must produce checks whose names exactly match `required_checks`, reported on the PR/MR head commit. The platform acceptance job is a separate protected gate and must never list itself in `required_checks`, which would deadlock its own wait step. With GitHub Actions, the usual pattern is a single aggregator job (e.g. `All checks passed`) that depends on the real work — see [GitHub Actions](actions.md).

### 5. Finish

```bash
specgit finish
```

SpecGit re-reads the record and policy, probes live git, and asks the forge (`gh`, or `glab` on a declared GitLab origin) for issue, PR/MR, and check/pipeline evidence. Every gate either passes with evidence or fails with a code and a fix. Exit `0` means **accepted**: the live delivery is bound, every issue has a valid closing reference, and every required check is green at the request head. It becomes **completed** only after the merge is confirmed and every bound issue is confirmed closed.

Add `--json` for machine-readable output; see the [CLI reference](cli.md). When a verdict is rejected, [Troubleshooting](troubleshooting.md) maps each code to its fix.

## Where things live

SpecGit's entire footprint is three tiers of files:

| Tier | Path | What it is | Committed? |
| --- | --- | --- | --- |
| Authoritative | `spec_git/policy.yaml` | The project's delivery policy (created by `init`) | Shielded by default; force-staged when deliberately shared |
| Authoritative | `.specgit.yaml` | This delivery's binding record (created by `issue`) | Force-staged on the delivery branch |
| Authoritative | `spec_git/providers.yaml` | Optional explicit GitLab platform declaration | Shielded by default; force-staged with the binding |
| Derived harness | `.github/workflows/specgit-accept.yml` (GitHub) or managed `.gitlab-ci.yml` router plus `.gitlab/specgit-{business,complete}.yml` when GitLab automation is enabled | Generated GitHub acceptance or GitLab completion plumbing — regenerate with `init --force`; the GitLab business acceptance job remains project-owned | Yes when selected |
| Derived harness | `AGENTS.md` / `CLAUDE.md` managed block | The generated agent contract between the `specgit` markers | Yes |
| Local integration | `.opencode/hooks.json`, `.opencode/hooks/specgit-merge-guard.sh`, the managed region of `.git/hooks/pre-push`, `setup` entry points | Machine-local wiring, merged non-destructively | Your choice |

There are no artifact folders, no stores, no caches, and nothing persisted outside these files plus the git and forge facts they point at. Verdicts are never stored — they are computed on every run. The full normative table is in [Reference](reference.md#state-and-assets).

After upgrading the globally installed package, do not re-adopt the project. A
human runs plain `specgit init` and may accept the guided refresh when proven
drift exists. Automation uses `init --force --no-protect`, `setup --tool all`,
then `status --json`; append `--no-ignore` to init for the intentionally tracked
authoritative model. Deliberately absent setup surfaces do not cause the prompt,
although accepting it installs both surfaces. See the reviewed recovery and
verification sequence in [Installation](installation.md#upgrade-to-a-newer-cli-version).
