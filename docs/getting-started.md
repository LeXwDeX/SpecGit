# Getting Started

This guide takes you from zero to your first **accepted** delivery. For installation details see [Installation](installation.md); for the underlying model see [Concepts](concepts.md).

## The loop in one screen

```bash
# one-time, per repository
specgit init            # auto-detects required checks (empty list when no CI exists)

# per delivery: one command bootstraps issues, branch, draft PR, record
specgit issue "feat: add login flow"

# after CI (including the SpecGit Acceptance job) is green on the PR
specgit finish
# exit 0 → accepted · exit 1 → rejected (evidence attached) · exit 3 → cannot determine
```

That is the entire product surface. Everything else is diagnostics and JSON. (`bind`/`unbind`/`accept` remain as script aliases.)

## Step by step

### 1. Initialize the policy and the harness

On the repository's default branch, declare which CI check names a delivery must pass:

```bash
specgit init                                  # auto-detect from CI files
specgit init --required-check "Build"         # or name them explicitly
```

With no arguments the check names are auto-detected from the repository's CI files (GitHub workflow job names, GitLab CI job keys). A repository with no CI at all gets an empty list — the `SpecGit Acceptance` job itself (never listed in the policy) is then the gate; the usual pattern is to add an aggregator check and re-pin the name. The harness workflow is portable: it installs the published CLI and assumes nothing about this repository's stack.

This creates the policy `spec_git/policy.yaml` and generates the harness: the `SpecGit Acceptance` workflow (`.github/workflows/specgit-accept.yml`, which runs `specgit finish --json` on every PR) and the managed agent block in `AGENTS.md`. Re-running `init` refreshes the harness idempotently and never touches an existing policy.

```yaml
version: 1
required_checks:
  - "Build"
```

Repeat `--required-check` for additional check names. The policy is committed to the repository — it is the shared contract the whole team, and every evaluation, relies on. See [GitHub Actions](actions.md) for how to pick and wire check names.

### 2. Bootstrap the delivery with one command

From the repository's default branch, run:

```bash
specgit issue "feat: add login flow"
```

Each argument is one independently verifiable WHY: a quoted title creates a new issue; a pure number reuses an existing one. N arguments bind N issues to **one** delivery. The command creates the branch `feat/<first-issue#>-<slug>`, opens the draft PR with `Closes #n` for every issue in its body, writes the record, commits, and pushes. Re-run the same command to resume after any failure between steps.

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
- The branch `type` is validated against a fixed whitelist (`feat`, `fix`, `chore`, … full list in the CLI reference); the title must be English (printable ASCII). The slug comes from the first three ASCII words of the title.
- `context` is filled in automatically from live git — never hand-edit it. (The `bind` alias exists for script-level record surgery.)

### 3. Work, push, and keep the closing refs

Work on the branch the bootstrap created (or a worktree of it — context is always resolved from live git). The PR body must close **every** bound issue with a closing reference:

```markdown
Closes #123
```

Supported forms: `Closes #123`, `owner/repo#123`, and full issue URLs, with any of the closing keywords (`closes`, `fixes`, `resolves`, and their tense variants). Missing references produce `closing_refs_incomplete` at acceptance. If the PR binding is ever lost, `specgit pr` auto-discovers the PR by head branch and repairs the record.

### 4. Pass the required checks

Your CI must produce checks whose names exactly match `required_checks`, reported on the PR head commit — including the generated `SpecGit Acceptance` job. With GitHub Actions, the usual pattern is a single aggregator job (e.g. `All checks passed`) that depends on the real work — see [GitHub Actions](actions.md).

### 5. Finish

```bash
specgit finish
```

SpecGit re-reads the record and policy, probes live git, and asks GitHub (via `gh`) for issue, PR, and check evidence. Every gate either passes with evidence or fails with a code and a fix. Exit `0` means **accepted**: the delivery is bound, every issue is closed by the PR, and every required check is green at the PR head.

Add `--json` for machine-readable output; see the [CLI reference](cli.md). When a verdict is rejected, [Troubleshooting](troubleshooting.md) maps each code to its fix.

## Where things live

SpecGit's entire footprint is three tiers of files:

| Tier | Path | What it is | Committed? |
| --- | --- | --- | --- |
| Authoritative | `spec_git/policy.yaml` | The project's required-checks policy (created by `init`) | Yes |
| Authoritative | `.specgit.yaml` | This delivery's binding record (created by `issue`) | Yes, on the delivery branch |
| Authoritative | `spec_git/providers.yaml` | Optional platform declaration (only with a declared GitLab host) | Yes |
| Derived harness | `.github/workflows/specgit-accept.yml` | The generated acceptance gate — regenerate with `init --force` | Yes |
| Derived harness | `AGENTS.md` / `CLAUDE.md` managed block | The generated agent contract between the `specgit` markers | Yes |
| Local integration | `.opencode/hooks.json`, `.opencode/hooks/specgit-merge-guard.sh`, the managed region of `.git/hooks/pre-push`, `setup` entry points | Machine-local wiring, merged non-destructively | Your choice |

There are no artifact folders, no stores, no caches, and nothing persisted outside these files plus the git and forge facts they point at. Verdicts are never stored — they are computed on every run. The full normative table is in [Reference](reference.md#state-and-assets).
