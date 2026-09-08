# Using SpecGit in an Existing Project

You can adopt SpecGit without rewriting repository history. SpecGit adds up to
three authoritative files (policy, record, and an optional GitLab declaration),
a derived harness, and local integration assets. It reads everything else from
the git and forge accounts you already have.

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

## Adopt in four steps

### 1. Inventory the CI you already trust

Look at the branch-protection settings of your base branch. Which check names are already required there? Those are your candidates for `required_checks` — the point of the policy is to make SpecGit enforce what the team already agrees "done" means.

- No required checks yet? Either run `specgit init` bare (the empty no-CI policy — the `SpecGit Acceptance` job itself is the gate) or create one aggregator check first — [GitHub Actions](actions.md) shows the `needs:`-based pattern (`All checks passed`).
- Many required checks? You can list several names in the policy, or (recommended) collapse them into one aggregator and declare one name.

### 2. Initialize the policy — through a PR, not a direct push

`specgit init` installs the pre-push guard that refuses direct pushes to your base branch, so bring the harness in the same way every later change arrives: through a pull request. From an up-to-date base:

Before it writes, init must resolve a supported forge. It exits `3` without
mutation when the origin is missing or the platform/provider declaration is
invalid or undecided. A run that will generate a platform workflow or configure
branch protection must also prove the remote default branch from `origin/HEAD`
before starting the local transaction; missing evidence leaves the policy,
harness, and protection unchanged. Init never guesses `main` or offers a GitHub
Enterprise route. Declare every GitLab endpoint explicitly with
`--gitlab-host <host>`; a failed provider-declaration write restores the exact
prior declaration and stops before policy or harness writes.

```bash
git checkout -b chore/adopt-specgit main
specgit init                    # auto-detects the names you inventoried above
git add -f spec_git/policy.yaml # ignored by default; force-stage intentionally
# also force-stage spec_git/providers.yaml when init created it
git add .github/workflows/specgit-*.yml AGENTS.md
# add CLAUDE.md only when it exists and contains the managed block
git commit -m "chore: adopt SpecGit (policy + acceptance harness)"
git push -u origin chore/adopt-specgit
```

Open the PR and merge it. The acceptance workflow's first run on this PR reports `record_missing` — expected: the adoption PR is not itself a delivery, and once the workflow lands on your base branch every later delivery carries a record.

**Then, after that merge**, set the acceptance check as a required status check in branch protection (`specgit init --force --protect`, or Settings → Branches without weakening existing rules). Ordering matters: while the check is required, no PR can merge without a passing verdict — so requiring it before the adoption PR merges would lock it out (`record_missing` can never pass). This is the one place where "protect first" is wrong: protect after the adoption merge, not before, and the GitHub-side and SpecGit-side contracts never disagree.

For a declared GitLab origin, carry the provider declaration and the generated
platform-neutral assets, then add the repository's reviewed GitLab CI entry that
runs `specgit finish --json`; init does not invent the project's business CI.

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

1. **Remove the shared harness and authoritative files.** Remove only files whose
   ownership is proven. Depending on platform and automation, this includes the
   policy/provider directory and `.github/workflows/specgit-accept.yml` /
   `specgit-complete.yml`. On GitLab, first restore the byte-preserved business
   configuration from `.gitlab/specgit-business.yml` to `.gitlab-ci.yml`, then
   remove `.gitlab/specgit-business.yml` and `.gitlab/specgit-complete.yml`.
   Preserve every business-owned workflow or include.

   ```bash
   git checkout -b chore/remove-specgit main
   git rm -r spec_git
   git rm .github/workflows/specgit-accept.yml
   # when present and SpecGit-owned:
   git rm .github/workflows/specgit-complete.yml
   ```

2. **Remove the managed agent block.** In `AGENTS.md` (and `CLAUDE.md` if present), delete everything from `<!-- specgit:block:start -->` through `<!-- specgit:block:end -->` inclusive — keep any manual guidance outside the markers.

3. **Remove the managed `.gitignore` region.** Delete only the lines between the
   SpecGit ignore markers; preserve every project-owned rule outside them.

4. **Remove the local hook wiring** (not committed by default, so not in the PR):
   - `.git/hooks/pre-push` — delete the region between `# >>> specgit:start >>>` and `# <<< specgit:end <<<`; if nothing of yours remains, delete the file. With `core.hooksPath` (husky/lefthook), the managed region is in that directory's `pre-push`.
   - `.opencode/hooks.json` — remove the specgit guard entry (other entries are yours, untouched by init).
   - `.opencode/hooks/specgit-merge-guard.sh` — delete the file.
   - `specgit setup` output (`.opencode/command/specgit-*.md`, `.agents/skills/specgit-*/SKILL.md`) — delete if you installed it.

5. **Remove delivery records.** Each delivery branch carries its own `.specgit.yaml`; in the current checkout `specgit unbind --yes` deletes it. Branches you keep can simply drop the file.

6. **Retire forge administration.** On GitHub, remove `SpecGit Acceptance` from
   required checks and disable repository auto-merge only if SpecGit enabled it
   and the project no longer wants it. On GitLab, retire the corresponding
   project pipeline/merge settings. Remove an aggregator only when it existed
   solely for SpecGit.

7. **Uninstall the CLI.**

   ```bash
   npm uninstall -g specgit
   ```

Before uninstalling the CLI, inspect the effective hooks directory
(`git rev-parse --git-path hooks`), setup entry points, managed agent blocks,
managed ignore region, platform workflow/router assets, and open delivery
branches. Commit and merge the reviewed removal, then verify that the forge no
longer requires a retired check.

## Refresh after upgrading the package

Updating the global package does not update repository files. After
`npm install -g specgit@latest`, a human can run plain `specgit init` in each adopted
repository. With a valid existing policy, it uses the shared read-only inspector
and asks only when required init assets or already installed setup surfaces are
proven stale or missing. A detected ownership conflict returns exit `3` before
the prompt or any write and names the path to resolve. Current assets and deliberately absent
setup surfaces do not prompt.

Yes runs the equivalent of `specgit init --force --no-protect` followed by
`specgit setup --tool all`, preserving the project's checks, language, validation, templates,
tags, ordering, automation, target, closure, and repair labels. It does not
implicitly enable automation or change remote protection; protection changes
require a separate deliberate `--protect` invocation. When authoritative files
are already tracked without the managed ignore block, the equivalent init adds
`--no-ignore`, and setup preserves that proven model. No leaves files
untouched and returns `policy_exists` guidance. `--json` and non-TTY automation
never take the guided path; use `specgit init --force --no-protect`,
`specgit setup --tool all`, then `specgit status --json`; append `--no-ignore` to init for
the intentionally tracked authoritative model. Conflicting unowned files are
preserved and must be resolved before the final status can be clean. The writer
also re-reads whole-file targets at commit time and re-proves ownership before
replacement or removal, so an edit made after inspection cannot be overwritten
or deleted from a stale plan.

## Questions existing repos ask

**Do we have to backfill old work?** No. SpecGit evaluates deliveries that opt in. A repo can run mixed — new deliveries bound, old ones untouched — indefinitely.

**What about repositories with many required status checks?** Declare exactly the names GitHub reports, or introduce the aggregator pattern so the contract is one stable name. Policy entries match check names byte-for-byte.

**Our CI is not GitHub Actions.** Fine — SpecGit matches check-run names, not their source. Any CI system that reports check runs (or status checks surfaced as check runs) to the PR head works; the naming guidance in [GitHub Actions](actions.md) still applies to choosing names.

**GitHub Enterprise / non-github.com hosts?** GitHub Enterprise is unsupported in v1: it has no declaration or provider route. The supported evidence routes are GitHub.com plus explicitly declared GitLab, including GitLab.com; self-managed GitLab uses the verified version policy. Only `github.com` origins resolve on the GitHub route. An undeclared `gitlab.com`/`*gitlab*` host fails closed with `gitlab_unsupported`; anything else, including GitHub Enterprise, uses `origin_unresolvable`.

**We track work in a different tracker.** The delivery must still bind numeric issue IDs from its routed forge (`--issue` rejects opaque tracker IDs). Numeric IDs work for GitHub and declared GitLab; a full issue URL input is currently GitHub-only. The common bridge is a thin issue on the repository's forge that links to the external item.

**We already have branch protection with required checks — what does SpecGit add?** The forge blocks *merge*; SpecGit verifies the *delivery aggregate*: the branch/worktree is bound, every issue has a scoped closing reference, and the checks are green at the request head. Exit 0 proves acceptance; confirmed merge and issue closure prove completion.
