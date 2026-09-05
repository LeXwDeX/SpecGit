# Examples & Recipes

Real deliveries, start to finish. Each recipe shows the commands you type and the evidence SpecGit checks, so you can match your situation to a pattern and copy it.

The primary human commands are `specgit issue` and `specgit finish`. Low-level
`bind` and `accept` appear only where a script-oriented recipe needs them.

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

## Recipe 1: One issue, one branch, one PR

The default shape of a delivery.

```bash
# initialize once; after package upgrades refresh with init --force and setup
specgit init --required-check "All checks passed"   # this repo uses the aggregator pattern

specgit issue "feat: add login flow"
# bootstrap creates/reuses the issue, branch, draft PR, record, commit, and push
# fill the issue and PR body; preserve the generated Closes #123 reference
# ... implement, commit, and push ...
gh pr ready 84

# ... CI runs, checks go green ...
specgit finish
# ✓ accepted — exit 0
# merge under the existing authorization, then confirm merge + issue closure
```

What acceptance verified: you're on `feat/123-add-login-flow` (context matches live git), issue #123 exists and is not occupied by another active delivery, PR #84 is ready with head branch `feat/123-add-login-flow` in the same repo, its body contains a scoped closing reference for #123, configured title/label/body rules pass, and `All checks passed` is green at the PR head commit. Completion still requires the confirmed merge and closed issue.

## Recipe 2: Closing two issues from a worktree

One PR may close N issues, and worktrees are first-class execution contexts.

```bash
git worktree add -b fix/124-flaky-tests ../wt-124-fix-flaky-tests main
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

The PR/MR body must contain a closing reference for **both** issues:

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
specgit finish --json | jq '.verdict.gates[] | select(.status == "fail")'
```

```json
{
  "id": "checks",
  "status": "fail",
  "code": "checks_failed",
  "detail": { "name": "All checks passed" },
  "fix": "Fix the failing check, then run \"specgit finish\" again. On GitHub, action_required means the run never started and needs maintainer approval in Actions or a re-push by an actor with write access."
}
```

Common endings:

- `checks_pending` — CI has not finished; wait and re-run `specgit finish`.
- `pr_head_mismatch` — the PR's head branch differs from `context.branch`; the record and the PR must describe the same delivery.
- `checks_missing` — the configured job did not run on the current PR/MR head; inspect the GitHub workflow or GitLab pipeline trigger and exact job name.

## Recipe 4: Local-only health check, no network

`status` never calls the forge — useful in planes and firewalls:

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
- **Binding a JIRA-style id.** `--issue JIRA-42` fails at bind time (`issue_ref_not_github`). Bind a positive issue number from the routed forge; numeric GitHub and declared-GitLab IDs work. Full issue URL input is currently GitHub-only.
- **Two PRs for one delivery.** The second `--pr` replaces the first. Split the work or close both issues from one PR.
- **Passing the context as a flag.** There are no `--branch`/`--worktree` flags. Check out the branch (or worktree) and the context follows from live git.
- **Claiming completion via files or acceptance alone.** No artifact, checklist, or spec file influences the verdict. `finish` exit 0 proves acceptance; a confirmed merge and every bound issue closed prove completion.
