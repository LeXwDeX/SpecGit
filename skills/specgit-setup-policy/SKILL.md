---
name: specgit-setup-policy
description: Initialize the SpecGit project policy (spec_git/policy.yaml) by declaring the CI check names every delivery must pass.
allowed-tools: Bash(specgit:*), Bash(git:*), Bash(gh:*)
license: MIT
compatibility: Requires the specgit CLI and git; gh helps discover current check names.
metadata:
  author: specgit
  version: "1.0"
---

Initialize the SpecGit policy for this repository. The policy is the project's
contract: the non-empty list of CI check names that every delivery must pass
at the PR head commit before it can be accepted.

## Preflight

1. Confirm you are inside a git repository:

```bash
git rev-parse --show-toplevel
```

If this fails, stop — SpecGit runs only inside git repositories.

2. Check whether the policy already exists:

```bash
test -f spec_git/policy.yaml && echo EXISTS || echo MISSING
```

**If it exists: stop.** Never overwrite an existing policy. Show the user its
`required_checks` and explain that changing it requires a deliberate PR that
updates both the policy and branch protection together.

## Choose the check names

Ask the user which CI check names are required. Ground the choice in facts:

- Read branch protection, if reachable:

```bash
gh api "repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks" \
  --jq '.contexts'
```

- List check names recent PR heads actually report:

```bash
gh api "repos/{owner}/{repo}/commits/{sha}/check-runs" --jq '.check_runs[].name'
```

Prefer a single **aggregator check** (e.g. `All checks passed`) produced by a
job that `needs:` the real work — a stable name that survives CI churn. Names
match byte-for-byte at acceptance; verify each candidate name against real
check-run output before writing it into the policy.

## Initialize

Run `init` from the repository root on the default branch, passing every name
explicitly (required in non-interactive terminals):

```bash
specgit init --required-check "All checks passed"
```

Repeat `--required-check` for additional names. Verify the result:

```bash
cat spec_git/policy.yaml
```

Expected shape:

```yaml
version: 1
required_checks:
  - "All checks passed"
```

## Finish

- Commit the policy on the default branch and push it, or instruct the user to.
- Remind the user to require the same check name(s) in branch protection so
  GitHub's merge gate and SpecGit's acceptance gate enforce the identical list.

See: [GitHub Actions guidance](../../docs/actions.md), [Reference](../../docs/reference.md).
