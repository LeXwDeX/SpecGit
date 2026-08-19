# Using SpecGit in an Existing Project

You can adopt SpecGit in a repository with years of history in about five minutes, and you never have to touch the past. SpecGit adds exactly two files and reads everything else from git and GitHub you already have.

## Adopt in four steps

### 1. Inventory the CI you already trust

Look at the branch-protection settings of your base branch. Which check names are already required there? Those are your candidates for `required_checks` — the point of the policy is to make SpecGit enforce what the team already agrees "done" means.

- No required checks yet? Either run `specgit init` bare (the empty no-CI policy — the `SpecGit Acceptance` job itself is the gate) or create one aggregator check first — [GitHub Actions](actions.md) shows the `needs:`-based pattern (`All checks passed`).
- Many required checks? You can list several names in the policy, or (recommended) collapse them into one aggregator and declare one name.

### 2. Initialize the policy

```bash
git checkout main && git pull
specgit init                    # auto-detects the names you inventoried above
git add spec_git/policy.yaml && git commit -m "chore: add SpecGit policy" && git push
```

Set the same name(s) as a required status check in branch protection in the same change, so the GitHub-side and SpecGit-side contracts never disagree.

### 3. Verify the environment

```bash
specgit doctor --json
```

Fix what it reports (usually: `gh auth login`) before the first delivery, not during it.

### 4. Run the next piece of real work through it

Don't manufacture a trial delivery — take the next bug or feature your team already planned:

```bash
specgit issue "fix: race in cache" 214
# ... implement, push — branch, draft PR (Fixes #214), and record already exist ...
specgit finish
```

That's the whole adoption. Old branches, old PRs, and closed issues need nothing at all.

## Questions existing repos ask

**Do we have to backfill old work?** No. SpecGit evaluates deliveries that opt in. A repo can run mixed — new deliveries bound, old ones untouched — indefinitely.

**What about repositories with many required status checks?** Declare exactly the names GitHub reports, or introduce the aggregator pattern so the contract is one stable name. Policy entries match check names byte-for-byte.

**Our CI is not GitHub Actions.** Fine — SpecGit matches check-run names, not their source. Any CI system that reports check runs (or status checks surfaced as check runs) to the PR head works; the naming guidance in [GitHub Actions](actions.md) still applies to choosing names.

**GitHub Enterprise / non-github.com hosts?** Not supported in this version. Only `github.com` origins resolve; other remotes fail closed with `origin_unresolvable`.

**We track work in a non-GitHub tracker.** The delivery must still bind GitHub issue numbers (`--issue` rejects opaque tracker ids). The common bridge: file a thin GitHub issue that links to the tracker item, and bind that number.

**We already have branch protection with required checks — what does SpecGit add?** GitHub blocks *merge*; SpecGit verifies the *delivery aggregate*: that the branch/worktree you're standing on is bound, the issues really are closed by this PR's body, and the checks really are green at the PR head — one fail-closed verdict you can script, gate merges on, or hand to an AI agent as the definition of done.
