# Using SpecGit in an Existing Project

You can adopt SpecGit in a repository with years of history in about five minutes, and you never have to touch the past. SpecGit adds a small, well-bounded footprint — two authoritative files, a derived harness, and local hook wiring — and reads everything else from the git and forge accounts you already have.

## Adopt in four steps

### 1. Inventory the CI you already trust

Look at the branch-protection settings of your base branch. Which check names are already required there? Those are your candidates for `required_checks` — the point of the policy is to make SpecGit enforce what the team already agrees "done" means.

- No required checks yet? Either run `specgit init` bare (the empty no-CI policy — the `SpecGit Acceptance` job itself is the gate) or create one aggregator check first — [GitHub Actions](actions.md) shows the `needs:`-based pattern (`All checks passed`).
- Many required checks? You can list several names in the policy, or (recommended) collapse them into one aggregator and declare one name.

### 2. Initialize the policy — through a PR, not a direct push

`specgit init` installs the pre-push guard that refuses direct pushes to your base branch, so bring the harness in the same way every later change arrives: through a pull request. From an up-to-date base:

```bash
git checkout -b chore/adopt-specgit main
specgit init                    # auto-detects the names you inventoried above
git add spec_git .github/workflows/specgit-accept.yml AGENTS.md CLAUDE.md
git commit -m "chore: adopt SpecGit (policy + acceptance harness)"
git push -u origin chore/adopt-specgit
```

Open the PR and merge it. The acceptance workflow's first run on this PR reports `record_missing` — expected: the adoption PR is not itself a delivery, and once the workflow lands on your base branch every later delivery carries a record.

**Then, after that merge**, set the acceptance check as a required status check in branch protection (`specgit init --force --protect`, or Settings → Branches without weakening existing rules). Ordering matters: while the check is required, no PR can merge without a passing verdict — so requiring it before the adoption PR merges would lock it out (`record_missing` can never pass). This is the one place where "protect first" is wrong: protect after the adoption merge, not before, and the GitHub-side and SpecGit-side contracts never disagree.

One more #292 note for the recipe above: with the default local-asset shielding, the plain `git add spec_git` line silently misses the ignored policy — use `git add -f spec_git/policy.yaml .github/workflows/specgit-accept.yml AGENTS.md CLAUDE.md` (or run `specgit init --no-ignore`), so the adoption PR really carries the policy its own wait step reads.

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

## Uninstall

Every piece is listed under [Where things live](getting-started.md#where-things-live), so removal is complete and leaves no hidden residue. On the base branch, through a PR:

1. **Remove the harness and policy.**

   ```bash
   git checkout -b chore/remove-specgit main
   git rm -r spec_git .github/workflows/specgit-accept.yml
   ```

2. **Remove the managed agent block.** In `AGENTS.md` (and `CLAUDE.md` if present), delete everything from `<!-- specgit:block:start -->` through `<!-- specgit:block:end -->` inclusive — keep any manual guidance outside the markers.

3. **Remove the local hook wiring** (not committed by default, so not in the PR):
   - `.git/hooks/pre-push` — delete the region between `# >>> specgit:start >>>` and `# <<< specgit:end <<<`; if nothing of yours remains, delete the file. With `core.hooksPath` (husky/lefthook), the managed region is in that directory's `pre-push`.
   - `.opencode/hooks.json` — remove the specgit guard entry (other entries are yours, untouched by init).
   - `.opencode/hooks/specgit-merge-guard.sh` — delete the file.
   - `specgit setup` output (`.opencode/command/specgit/*`, portable skills) — delete if you installed it.

4. **Remove delivery records.** Each delivery branch carries its own `.specgit.yaml`; in the current checkout `specgit unbind --yes` deletes it. Branches you keep can simply drop the file.

5. **Unprotect.** In branch protection, remove `SpecGit Acceptance` (and your aggregator check, if it existed only for SpecGit) from required status checks — otherwise GitHub keeps demanding a workflow that no longer exists.

6. **Uninstall the CLI.**

   ```bash
   npm uninstall -g specgit
   ```

Commit the PR, merge, done. Nothing else remains: no stores, no caches, no global state.

## Questions existing repos ask

**Do we have to backfill old work?** No. SpecGit evaluates deliveries that opt in. A repo can run mixed — new deliveries bound, old ones untouched — indefinitely.

**What about repositories with many required status checks?** Declare exactly the names GitHub reports, or introduce the aggregator pattern so the contract is one stable name. Policy entries match check names byte-for-byte.

**Our CI is not GitHub Actions.** Fine — SpecGit matches check-run names, not their source. Any CI system that reports check runs (or status checks surfaced as check runs) to the PR head works; the naming guidance in [GitHub Actions](actions.md) still applies to choosing names.

**GitHub Enterprise / non-github.com hosts?** Not supported in v1 — the scope is GitHub.com plus declared self-managed GitLab (see the [GitLab support](gitlab-support.md) ledger). Only `github.com` origins resolve on the GitHub route; a GitLab host declared in `spec_git/providers.yaml` routes through glab (#117). An undeclared `gitlab.com`/`*gitlab*` host fails closed with the dedicated `gitlab_unsupported`, anything else with `origin_unresolvable`.

**We track work in a non-GitHub tracker.** The delivery must still bind GitHub issue numbers (`--issue` rejects opaque tracker ids). The common bridge: file a thin GitHub issue that links to the tracker item, and bind that number.

**We already have branch protection with required checks — what does SpecGit add?** GitHub blocks *merge*; SpecGit verifies the *delivery aggregate*: that the branch/worktree you're standing on is bound, the issues really are closed by this PR's body, and the checks really are green at the PR head — one fail-closed verdict you can script, gate merges on, or hand to an AI agent as the definition of done.
