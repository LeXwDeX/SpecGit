# GitHub Actions

SpecGit verifies deliveries against CI evidence. This page defines how GitHub Actions produce that evidence — how check names are chosen, how to wire required checks, and the security rules for the workflows involved.

## How SpecGit reads Actions

At acceptance, SpecGit asks GitHub for the **check runs reported to the PR head commit** and matches them against `required_checks` in `spec_git/policy.yaml` — exact name match, case-sensitive. Two consequences:

1. The strings in `required_checks` must be names GitHub actually reports as check runs for that commit.
2. Checks must exist **on the PR head**, so the workflow must trigger on PR activity (`pull_request` / `pull_request_target` carefully — see fork guidance below) or on pushes to the branch behind the PR.

## Pick one aggregator check

Workflow job names are reported as check runs. Job names churn as pipelines evolve; required checks and the SpecGit policy are contracts. Decouple them with an **aggregator job** whose name is the only required check:

```yaml
name: ci
on:
  pull_request:

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test

  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run build

  all-checks:
    name: "All checks passed"          # ← the contract
    needs: [test, build]
    runs-on: ubuntu-latest
    if: always()
    steps:
      - name: Fail unless every dependency succeeded
        if: contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')
        run: exit 1
      - run: echo ok
```

Then both sides of the contract carry one name:

- Branch protection: require status check **`All checks passed`**.
- Policy: `specgit init --required-check "All checks passed"`.

Internal jobs can be renamed, split, or parallelized without touching either setting.

Naming rules that matter:

- The job's **display name** (`name:`) is the reported check name when present; otherwise the job key is. Set `name:` explicitly on the aggregator.
- Matrix and reusable-workflow calls fan out into multiple or differently-shaped check runs. Keep the aggregator out of matrices, and prefer `needs:` over nesting reusable workflows for the gate job — SpecGit matches flat check-run names. `specgit init` auto-detection honors the same boundary (#310): a matrix job (placeholder name or not) or a reusable call has no statically provable check-run name, so detection reports it as ambiguous (`checks_name_ambiguous`, `detected.ambiguousJobs`) instead of arming the job id — name the real expanded names (e.g. `Test (linux-bash)`) explicitly with `--required-check`, and note that a later no-argument `init --force` PRESERVES the existing list; only an explicit `--required-check` run replaces it.
- Name stability is your problem to keep: whatever string the policy declares, CI must report byte-for-byte.

## Wiring required checks

1. In repository settings → branch protection for the delivery base branch, enable required status checks and list the aggregator name(s).
2. Declare the same name(s) in `spec_git/policy.yaml` and commit it.
3. Protect the base branch against deletions and force-pushes, and restrict who can dismiss reviews or bypass checks — SpecGit trusts whatever GitHub reports at the PR head, so the integrity of that surface is the integrity of acceptance.

`specgit finish` failing with `checks_missing` almost always means the policy name and the reported check name disagree — compare `gh api repos/{owner}/{repo}/commits/{pr-head-sha}/check-runs` output against the policy.

## Security guidance

**Least privilege by default.** Set top-level `permissions: { contents: read }` and grant more only inside jobs that provably need it. Acceptance evidence is read-only; nothing in the SpecGit model needs workflow write access to contents, packages, or deployments.

**Never expose secrets to untrusted changes.** Trigger on `pull_request` (not `pull_request_target`) for anything that runs fork-contributor code: the `pull_request` context receives no secrets and no write tokens. Reserve `pull_request_target` for workflows that only touch trusted data (labeling, status comments) and never check out or execute PR code.

**Tokens.** SpecGit on a developer machine authenticates through your existing `gh auth login` session; it never reads, echoes, or stores tokens, and `gh auth status` output is the only auth surface it inspects. If you script SpecGit in CI:

- Mint a narrowly scoped token (read-only for the repo: issues, pull requests, checks) and pass it as an action secret to `gh auth`.
- Never print the token, never store it in the record or policy (both are committed files), and never pass it as a command-line argument visible in process listings.
- Remember the asymmetry: CI-side verdicts are convenient, but they inherit the fork-PR secret rules above.

**Untrusted input is sanitized.** SpecGit renders strings that came from the GitHub API (issue titles, PR bodies, check names) only after stripping control/ANSI sequences and truncating them — a malicious PR title cannot escape the terminal. Keep the same discipline in your own workflow logs: do not echo PR bodies or issue titles unfiltered into logs or annotations.

**Supply chain.** Pin third-party actions by full commit SHA (`uses: actions/checkout@<sha>`) in workflows whose results gate acceptance; a compromised gate job is a compromised verdict. Keep the aggregator job dependency-free: no third-party actions, plain `run` steps only.

**Auditability.** The evidence SpecGit checks — branch, PR, closing refs, check runs — all lives in GitHub, where it is auditable. Prefer branch-protection enforcement (required checks) over convention, so a delivery cannot merge without the same evidence `specgit finish` requires.
