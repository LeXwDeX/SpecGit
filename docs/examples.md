# Examples & Recipes

Real deliveries, start to finish. Each recipe shows the commands you type and the evidence SpecGit checks, so you can match your situation to a pattern and copy it.

> Command note: these recipes use the script aliases `specgit bind` / `specgit accept`. The one-command equivalents are `specgit issue "fix: …" 214` (creates branch + draft PR + record in one step) and `specgit finish` (the same evaluation as `accept`).

## Recipe 1: One issue, one branch, one PR

The default shape of a delivery.

```bash
# once per repository (already done if spec_git/policy.yaml exists)
specgit init --required-check "All checks passed"

git checkout -b feat/123-add-login-flow
specgit bind --delivery add-login-flow --issue 123
git commit -m "feat: add login flow"
git push -u origin feat/123-add-login-flow
gh pr create --title "Add login flow" --body "Closes #123"
# note the PR number, then:
specgit bind --pr 84

# ... CI runs, checks go green ...
specgit accept
# ✓ accepted — exit 0
```

What acceptance verified: you're on `feat/123-add-login-flow` (context matches live git), issue #123 exists, PR #84 is open with head branch `feat/123-add-login-flow` in the same repo, its body closes #123, and `All checks passed` is green at the PR head commit.

## Recipe 2: Closing two issues from a worktree

One PR may close N issues, and worktrees are first-class execution contexts.

```bash
git worktree add ../wt-124-fix-flaky-tests fix/124-flaky-tests
cd ../wt-124-fix-flaky-tests

specgit bind --delivery fix-flaky-tests --issue 124 --issue 131
# work, commit, push, open PR #85...
specgit bind --pr 85
```

The record now carries a worktree context:

```yaml
version: 1
delivery: fix-flaky-tests
context:
  kind: worktree
  label: wt-124-fix-flaky-tests
  branch: fix/124-flaky-tests
issues: [124, 131]
pr: 85
```

The PR body must close **both** issues:

```markdown
Fixes #124
Fixes #131
```

If you forget the second one, acceptance names it precisely:

```text
✗ rejected — closing_refs_incomplete
  PR 85 does not close: #131
  fix: add "Fixes #131" to the PR body
```

The worktree label (`wt-124-fix-flaky-tests`) is the basename of the checkout — portable, no paths stored. Any machine with a matching worktree on the same branch satisfies the same record.

## Recipe 3: Diagnosing a rejected verdict

Run with `--json` and read the gates; every failure carries a code and a fix.

```bash
specgit accept --json | jq '.verdict.gates[] | select(.status == "fail")'
```

```json
{
  "id": "checks",
  "status": "fail",
  "code": "checks_failed",
  "detail": { "name": "All checks passed" },
  "fix": "Re-run or fix the failing CI run for this check"
}
```

Common endings:

- `checks_pending` — CI has not finished; wait and re-run `specgit accept`.
- `pr_head_mismatch` — the PR's head branch differs from `context.branch`; the record and the PR must describe the same delivery.
- `checks_missing` — the policy name is not a check GitHub reports for the PR head; see [GitHub Actions](actions.md).

## Recipe 4: Local-only health check, no network

`status` never calls GitHub — useful in planes and firewalls:

```bash
specgit status --json
```

Reports record validity, derived state, live branch/worktree, upstream ahead/behind drift, and parsed origin. It cannot say `accepted` — only the full evaluation can.

## Recipe 5: Scripting the verdict

Exit codes are contractual, so gates in CI or merge scripts are one line:

```bash
if specgit accept --json > verdict.json; then
  echo "delivery accepted"
else
  code=$?
  case $code in
    1) echo "rejected — see verdict.json" ;;
    3) echo "cannot determine — record/policy/provider problem" ;;
    *) echo "usage error" ;;
  esac
fi
```

In JSON mode stdout is exactly one JSON document; send anything chatty to stderr yourself.

## Anti-recipes

Things that deliberately do not work, by design:

- **"Accept" while offline.** Evidence requires the provider; offline the best verdict is `unknown` (exit 3).
- **Binding a JIRA-style id.** `--issue JIRA-42` fails at bind time (`issue_ref_not_github`). Only GitHub issue numbers bind.
- **Two PRs for one delivery.** The second `--pr` replaces the first. Split the work or close both issues from one PR.
- **Passing the context as a flag.** There are no `--branch`/`--worktree` flags. Check out the branch (or worktree) and the context follows from live git.
- **Claiming done via files.** No artifact, checklist, or spec file influences the verdict. Only git, the PR, closing refs, and checks do.
