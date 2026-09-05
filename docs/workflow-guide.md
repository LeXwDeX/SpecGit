# SpecGit Workflow Guide

This is the canonical walkthrough for humans and agents. The project guidance is
English; command names, diagnostic codes, JSON keys, branch names, and closing
references remain the same under every configured language.

```text
  specgit init / setup     initialize once; rerun after upgrades
        |
        v
  specgit issue "..."      each delivery: issues + branch + draft PR/MR
        |                  + binding record, committed and pushed
        v
  work, commit, push ----> CI/CD on the exact request head
        |
        v
  mark the PR/MR ready     a draft always fails with pr_draft
        |
        v
  specgit finish           eleven-gate, fail-closed evidence verdict
        |-- exit 0 --> accepted --> confirmed merge --> issue closure --> completed
        |-- exit 1 --> repair the delivery facts named by the gates
        '-- exit 3 --> follow errors[].fix; doctor covers prerequisite probes
```

## 1. Prepare each machine

| Requirement | Check | Purpose |
| --- | --- | --- |
| Node.js 20.19 or newer | `node --version` | CLI runtime |
| git | `git --version` | Local repository evidence |
| Authenticated `gh` | `gh auth status` | GitHub issues, PRs, checks, and administration |
| Authenticated `glab` 1.113.0 or newer | `glab auth status --hostname <host>` | Explicitly declared GitLab issues, MRs, pipelines, and administration |

Install or upgrade the published CLI:

```bash
npm install -g specgit@latest
specgit --version
```

Run the human-readable diagnostic inside the target repository:

```bash
specgit doctor
```

Scripts and agents may add `--json`. That flag is a machine interface: stdout is
exactly one JSON document and human-readable text goes to stderr. Humans do not
need it for ordinary use.

## 2. Initialize a repository

On the default branch, run:

```bash
specgit init
specgit setup
```

Fresh `init` detects statically provable PR-visible GitHub workflow job names or
visible GitLab CI job names. Supply exact names when detection cannot prove them:

```bash
specgit init --required-check "All checks passed"
```

The platform acceptance integration is separate from product checks. On GitHub,
never put the generated `SpecGit Acceptance` job in `required_checks`; its wait
step cannot wait for itself. On GitLab, the project's reviewed pipeline owns the
job that runs `specgit finish --json`. An empty list is the no-CI policy; the
applicable acceptance integration and merge protection remain the gate.

For GitLab, declare the exact origin host, including GitLab.com:

```bash
specgit init --gitlab-host git.example.com
specgit init --gitlab-host gitlab.com
```

The declaration is explicit, never inferred from a hostname substring. Declared
GitLab.com is capability-probed. Self-managed CE/Free has a verified window of
`>= 19.2.4 < 19.4.0`; versions outside it warn while live API evidence remains
fail-closed.

Init resolves this platform before it writes. Only exact `github.com` origins
select GitHub. An interactive prompt for another endpoint can confirm GitLab or
stop; it cannot select GitHub Enterprise. Invalid provider bytes or an undecided
platform cause exit `3` without mutation. A run that will generate a platform
workflow or configure protection also requires `origin/HEAD` to prove the
remote default branch before the local transaction; missing evidence leaves the
policy, harness, and protection unchanged. If writing a selected GitLab
declaration fails, init restores its exact pre-run provider state and stops.
Workflows and protection always use the proved branch, never a guessed `main`.

### What init and setup own

`init` writes the policy and converges the generated harness, managed
AGENTS/CLAUDE block, guard hooks, and managed `.gitignore` region. GitHub gets a
generated acceptance workflow. GitLab keeps its business acceptance job
project-owned; optional automation adds only the managed router, preserved
business configuration, and trusted completion continuation. `setup` installs
local agent entry points. These commands do not replace business build commands,
source, or dependencies.

By default the managed `.gitignore` region shields `.specgit.yaml` and
`spec_git/` from accidental staging. The delivery bootstrap uses `git add -f` to
carry the authoritative policy, optional provider declaration, and record into
the delivery branch where CI reads them. A deliberate adoption PR must likewise
force-stage the authoritative files, or initialize with `--no-ignore`.

The managed reconciler checks more than the initial plan. Immediately before a
whole-file replacement it re-reads the current bytes, proves ownership again,
and requires the bytes used by the merge plan to be unchanged. It re-proves
ownership from current bytes before removal. An intervening user edit is
preserved and earlier mutations in the failed transaction roll back.

Initialization and local entry-point refresh are maintenance. They do not by
themselves require a product build, issue, PR, or release. If the team chooses to
share a policy, workflow, or guidance change, deliver that tracked change under
the repository's [CI scope](ci-scope.md). `.gitignore` affects tracking, not the
checks appropriate to an intentionally shared diff.

### Automation is an explicit user choice

The first interactive initialization asks whether to enable automatic merge and
issue closure; the default is no. Agents cannot answer yes for the user. A first
non-interactive init without `--automation` leaves it disabled. Enable it only
with the user's choice:

```bash
specgit init --automation yes --merge-target main
```

An ordinary `init --force` preserves automation, target, closure, required
checks, language, tags, templates, validation, ordering, and repair labels.
Explicit options replace only the selected settings. With automation enabled,
the trusted completion runner can continue after CI, merge only the approved
target and exact head, confirm the merge, and close every bound issue.

### Project conventions

Configure generated text and optional live-fact validation with explicit flags
or the interactive rules session:

```bash
specgit init --force --configure-rules
specgit init --force --language en --title-check yes --label-check kind
```

With English title validation, issue and PR/MR titles must contain no Han
characters. With Chinese validation they must contain at least one Han
character; English technical names may remain. Label validation uses either the
built-in `kind::` axis plus declared extras, or the exact project `tags`
vocabulary. Repair issue labels are selected with repeatable `--repair-label`.

Policies may select issue and PR/MR templates and require nonempty H2 sections.
When body validation or `required_sections` is enabled, prepare complete files
before creating remote objects:

```bash
specgit issue "fix: prevent stale sessions" \
  --body-file /tmp/issue.md \
  --pr-body-file /tmp/pr.md
```

Without body rules, the built-in scaffold is advisory and can be completed after
creation. Unselected repository templates are never loaded silently.

## 3. Start one delivery

```bash
specgit issue "feat: add login" "security: harden session handling"
```

Each argument is one independently verifiable WHY. A quoted typed title creates
an issue; a positive integer reuses an issue in the current routed forge. One
command may bind N issues to one PR/MR. Numeric references work on GitHub and
declared GitLab because they are forge-local. Full issue URL input is currently
the GitHub-only convenience; opaque tracker IDs are rejected.

Bootstrap plans the selection, checks relevant issue history and active issue
occupancy, creates or reuses the issues, creates the delivery branch, opens a
draft PR/MR containing `Closes #n` for every bound issue, writes the record,
commits, and pushes. Re-running the same command resumes after a partial failure
without duplicating durable remote objects.

New titles use `<type>: <summary>`, where type is one of the CLI's declared
types. Branch names remain ASCII. When no ASCII slug can be derived, pass an
explicit kebab-case delivery name:

```bash
specgit issue "feat: add localized onboarding" --delivery localized-onboarding
```

Preserve every closing reference. Fill the issue Why / Scope / Approach /
Acceptance and the PR/MR Why / What changed / Evidence / Checklist sections.
When body rules are enabled, supply that content before bootstrap as described
above. Resume preserves existing remote bodies and human edits.

## 4. Implement and review

Work on the branch bootstrap created, commit, and push. The PR/MR remains draft
until it is reviewable:

```bash
gh pr ready <number>
# GitLab:
glab mr update <number> --ready
```

Review decides whether the change should exist and whether the implementation is
sound. SpecGit checks the delivery binding and live evidence. Existing user
authorization covers routine body completion, review fixes, ready transition,
CI repair, merge, and closure unless the user limited that authorization or a
new scope decision is required.

## 5. Run the verdict

```bash
specgit finish
```

The evaluator checks, in order: record, policy, completeness, context, origin,
provider, issues and project rules, issue sequence, PR/MR and project rules,
closing references, and required checks at the exact request head.

- Exit `0`: accepted. A live delivery is eligible for the authorized merge.
- Exit `1`: evidence is complete and says no. Fix the named delivery fact.
- Exit `2`: command usage or configuration input is invalid.
- Exit `3`: no verdict is possible. Follow each reported `errors[].fix`; use
  `specgit doctor` only for its git, repository, origin, routed forge-CLI,
  authentication, and policy probes.
- Exit `130`: an interactive prompt was interrupted; no JSON envelope exists.

`finish` is read-only. Exit 0 alone does not prove completion. Completion needs a
confirmed merge and every bound issue confirmed closed. After a merge, `status`
may report `historical-candidate` from local evidence; `finish` proves merged
lineage and reports `completed`, or `closure_pending` while an issue remains open.

With configured automation, trusted remote execution normally performs the merge
and closure. `specgit pr --merge` is the recovery path for an interrupted run and
rechecks current policy, exact head, target, acceptance, and all executed CI/CD.
With automation disabled, use the forge merge operation already authorized, then
verify the resulting completed state. A terminal failed PR/MR is tracked by a
repair issue; repeated occurrences of the same unresolved cause reuse it.

## 6. Repair and diagnose

- Missing or stale PR/MR binding: run `specgit pr`. It discovers by head branch;
  zero matches gives a repair, multiple matches require an explicit number.
- Exit 3: follow the named fix. When it concerns a prerequisite,
  `specgit doctor` reports all failed git, repository, origin, routed platform CLI (`gh`
  or `glab`), authentication, and policy probes. It does not inspect records,
  PRs/MRs, checks, or managed-file drift.
- Stale installed assets after a package update: run `specgit status`, then each
  exact `init --force` or `setup --tool ...` repair it names, and re-run status.
- Pending checks: wait for the current head's fresh generation. Do not open a
  repair issue or weaken policy for a transient state.
- Failed PR/MR: keep the original business issues bound; use the automatically
  created or manually tracked repair issue for the independent failure cause.
- Closed-unmerged bound PR/MR: `specgit issue` exits `1` with
  `pr_closed_unmerged` and preserves the record even when given new titles.
  Reopen it or create/find an open draft from the recorded branch with every
  closing reference, then run `specgit pr <number>`. Start a new WHY only after
  repairing that binding.

## 7. Parallel deliveries

Each delivery owns one branch or linked worktree, one record, N issues, and one
PR/MR. Separate deliveries use separate branches/worktrees and independent
records. The project policy is shared. A worktree context keeps its portable
checkout basename plus branch and is revalidated with `git worktree list`.

## References

- [CLI reference](cli.md)
- [Concepts](concepts.md) and [Glossary](glossary.md)
- [Installation and upgrades](installation.md)
- [Troubleshooting](troubleshooting.md)
- [Team workflow](team-workflow.md)
- [CI scope](ci-scope.md)
