# Getting Started

This guide takes you from zero to your first **accepted** delivery. For installation details see [Installation](installation.md); for the underlying model see [Concepts](concepts.md).

## The loop in one screen

```bash
# one-time, per repository
specgit init --required-check "All checks passed"

# per delivery, on your delivery branch
specgit bind --delivery add-login-flow --issue 123 --pr 42

# after the PR exists with closing refs and green checks
specgit accept
# exit 0 → accepted · exit 1 → rejected (evidence attached) · exit 3 → cannot determine
```

That is the entire product surface. Everything else is diagnostics and JSON.

## Step by step

### 1. Initialize the policy

On the repository's default branch, declare which CI check names a delivery must pass:

```bash
specgit init --required-check "All checks passed"
```

This creates one file: `spec_git/policy.yaml`.

```yaml
version: 1
required_checks:
  - "All checks passed"
```

Repeat `--required-check` for additional check names. The policy is committed to the repository — it is the shared contract the whole team, and every evaluation, relies on. See [GitHub Actions](actions.md) for how to pick and wire check names.

### 2. Prepare the execution context

Work on a branch — or in a linked worktree — that will carry the delivery:

```bash
git checkout -b feat/123-add-login-flow
```

The execution context is **always resolved from live git**. There are no flags to set a branch or worktree; wherever git says you are is the context SpecGit evaluates.

### 3. Bind the delivery

Bind the delivery id, the GitHub issues it closes, and (once it exists) the PR:

```bash
specgit bind --delivery add-login-flow --issue 123
# ... work, commit, push, open PR #42 ...
specgit bind --pr 42
```

This writes `.specgit.yaml` at the repository root — **commit it on the delivery branch**:

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

- `--delivery` is kebab-case and accepted only on the first bind.
- `--issue` takes **GitHub issue numbers only** (`123`, or a full issue URL). Opaque tracker ids are rejected.
- Repeat `--issue` across binds; values merge and deduplicate, first-seen order kept. `--pr` replaces any previous value. At most one PR per delivery.
- `context` is filled in automatically from live git — never hand-edit it.

### 4. Close the issues from the PR

The PR body must close **every** bound issue with a closing reference:

```markdown
Closes #123
```

Supported forms: `Closes #123`, `owner/repo#123`, and full issue URLs, with any of the closing keywords (`closes`, `fixes`, `resolves`, and their tense variants). Missing references produce `closing_refs_incomplete` at acceptance.

### 5. Pass the required checks

Your CI must produce checks whose names exactly match `required_checks`, reported on the PR head commit. With GitHub Actions, the usual pattern is a single aggregator job (e.g. `All checks passed`) that depends on the real work — see [GitHub Actions](actions.md).

### 6. Accept

```bash
specgit accept
```

SpecGit re-reads the record and policy, probes live git, and asks GitHub (via `gh`) for issue, PR, and check evidence. Every gate either passes with evidence or fails with a code and a fix. Exit `0` means **accepted**: the delivery is bound, every issue is closed by the PR, and every required check is green at the PR head.

Add `--json` for machine-readable output; see the [CLI reference](cli.md). When a verdict is rejected, [Troubleshooting](troubleshooting.md) maps each code to its fix.

## Where things live

| Path | What it is | Committed? |
| --- | --- | --- |
| `spec_git/policy.yaml` | The project's required-checks policy (created by `init`) | Yes |
| `.specgit.yaml` | This delivery's binding record (created by `bind`) | Yes, on the delivery branch |

No other state exists. There are no artifact folders, no stores, no caches, and nothing persisted outside these two files plus the git and GitHub facts they point at.
