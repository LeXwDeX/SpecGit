# CI scope and release intent

This is the binding classification for work in the SpecGit product repository.
Classify the intended tracked change before choosing a delivery, verification,
or release action. Running a command, detecting generated-file drift, or merging
a PR does not by itself authorize the next class of work.

## Local maintenance and tracked changes

Installing or upgrading the CLI, running `init` / `setup`, inspecting status,
and refreshing local entry points are local maintenance when no product or
shared-rule change is intended for commit. They need no issue, PR, product
build, CI wait, or package release. Inspect tracked diffs after a refresh;
shared files may have changed even when the command was local maintenance.

An intended tracked product or shared-rule change is a delivery: bind its issue
and PR before implementing that change, then use the checks below. A delivery
still requires the policy's checks and `specgit finish` exit 0 before merge.
Lightweight validation changes how checks obtain evidence, not which required
checks must exist or whether the current PR head must pass them.

`.gitignore` controls Git tracking only. Its entries never grant CI exemptions,
prove that an existing tracked file is local, or make ignored code safe to ship.
Moving a source file into a documentation path retains its source deletion in
the classified diff and therefore still requires product verification.

## What is verified

| Changed surface | Required verification | Build or publish consequence |
| --- | --- | --- |
| CLI/domain/provider source, shipped generators and hook scripts, schema, templates, distributed skills, tests, build scripts, package/build dependencies, executable workflows | Product build, both typechecks, lint, tests and applicable security checks on the supported platform matrix | Build and test the product under review; publish only with release intent |
| Explicitly recognized shared documentation, policy/record/provider data, `.gitignore`, project AGENTS/CLAUDE guidance, local agent command/skill Markdown copies | Real schema, generated-content and documentation contract validation; delivery acceptance still reads real git, forge and current-head CI evidence | Frozen verification dependencies installed with `--ignore-scripts`; no product compilation, typecheck, lifecycle build or implied release |
| Nix inputs and their CI wiring | Nix verification in addition to the applicable product checks | No implied release |
| Dependency manifests, lockfile and security wiring | Dependency audit in addition to the applicable product checks | No implied release |
| Valid nonempty release changeset or package version change | Validate release intent and run the release preparation/publishing gates appropriate to that stage | May start the explicitly authorized release flow, including an expressly requested docs-only release; a green ordinary PR alone cannot publish |
| Local caches, CLI/device state, credentials, logs and machine files | Keep outside committed source and release inputs; reject newly committed local state | Never use a developer's local copy as build, release, or acceptance evidence |
| Unknown paths, mixed source/metadata changes, scheduled or explicitly dispatched verification | Full product verification; relevant toolchain checks also run | Fail closed on incomplete change evidence; no inferred release intent |

The exact scheduling map lives in
[`scripts/ci-change-scope.mjs`](../scripts/ci-change-scope.mjs). It uses committed
Git evidence and the parser installed by the locked Changesets CLI, without
running package lifecycle scripts. Ignore patterns do not determine scope.
PRs use the merge base and PR head; pushes use the event's before/after commits;
merge groups use their complete base/head range. Missing or invalid commit
evidence fails the job. A new branch without a prior revision, scheduled checks
and manual verification dispatches select full verification; unsupported events
fail closed.
Explicit metadata paths are a narrow allowlist; other paths require a build.
For example, `.agents/skills/specgit-issue/SKILL.md` is a local integration copy,
while the shipped `skills/specgit-issue/SKILL.md` is product content.

Deletion of accidentally tracked known local state is permitted as metadata
cleanup; adding or modifying that state is rejected without reading its values.
`node_modules`, `dist` and coverage remain generated local output, not committed
source. CI produces its own dependencies and build artifacts; a verified `dist`
is part of the published package, while an arbitrary developer build is not a
substitute for that release verification.

The classifier emits `build`, `metadata`, `nix`, `dependencies`, and
`release_intent`. Its `--assert-metadata` option proves only that the complete
diff is eligible for metadata verification; it does not validate policy or
pretend to run product tests. A source change cannot acquire a lightweight
pass by changing an ignore rule. Changesets use the real Changesets syntax:
SpecGit release entries must name a valid patch, minor or major bump and have
a summary; empty release frontmatter is metadata with no release intent.
A package version change is also a release-intent signal. These signals do not
replace user authorization for publication.

For local inspection, supply explicit committed revisions:

```bash
node scripts/ci-change-scope.mjs --base <base-sha> --head <head-sha>
```

## Required verification

**Metadata contracts** runs on every classified change. It loads the actual
record, policy and provider schemas, requires this repository's nonempty
`Required verification` policy entry, and checks that each required name is
produced by CI. It compares generated workflow, managed guidance and installed
entry-point bytes with the real generators, then runs the selected documentation,
skill mirror and workflow-security contracts. Its standalone Vitest configuration
has no product-build global setup and does not consume `dist`.

**Required verification** always reports a result. It requires successful
classification and Metadata contracts before examining applicable job results:

| Scope | Required results |
| --- | --- |
| Product or mixed change | All three `Test (platform)` matrix jobs, `Lint & Type Check`, and reusable package/RC verification succeed |
| Metadata only | Those product jobs are explicitly inapplicable and skipped; Metadata contracts actually succeeds |
| Nix inputs changed | Nix verification also succeeds; otherwise it must be skipped |

An applicable job that fails, is cancelled, is skipped, or supplies no result
fails the aggregate. Unknown classification values also fail. Product job names
retain their meaning: a metadata change receives no fabricated Test/Lint pass.
SpecGit Acceptance waits on this aggregate; the aggregate never waits on
SpecGit Acceptance. Branch protection and the approved policy must be migrated
together, through checks required by the previously approved policy.

Ordinary metadata pushes do not start release preparation or publication. A
nonempty changeset explicitly requests release work, so its merge may install
build dependencies and prepare a version PR even when the note itself needed
only metadata verification. The version PR and publication still pass their
normal package/release gates. Explicit `pnpm release` and manual release dispatch
remain release entry points; an optional exact version guard detects stale
dispatch input.

## The acceptance job

This repository's generated **SpecGit Acceptance** workflow checks out full
history, installs locked classifier dependencies with `--ignore-scripts`, and
classifies the change. Product changes build and run the current CLI.
Metadata-only changes install the exact version declared in `package.json` into
`$RUNNER_TEMP/specgit-cli`, with lifecycle scripts disabled, and run that
published CLI without compiling the product. Policy/schema implementation
changes take the product path. A missing published version or incompatible
runtime fails closed; metadata verification does not fall back to compilation.

Both paths resolve the approved target-branch policy and wait through authenticated
`gh` for its required checks
at the exact PR head and the same ready-for-review freshness boundary. They
associate Actions checks with their current workflow execution; an obsolete
cancelled run cannot provide the successor's required aggregate, even if its
last job starts after readiness. Missing provenance fails closed. Each path
then runs `finish --json`. Classification, installation, waiting, or verdict
failure fails the job; an absent classification cannot select a success path.
Generated acceptance waits up to 25 minutes for sibling checks within a
30-minute job, covering this repository's 20-minute test window with setup and
verdict headroom. Version automation waits up to 35 minutes within its 40-minute
step so it cannot expire ahead of that acceptance window. These are bounded
waits: incomplete evidence at the deadline still prevents completion.
Changing policy in the PR cannot grant that PR permission to weaken its own
checks or enable automatic merging. First adoption can use candidate policy
for read-only acceptance when no approved policy exists; automatic completion
requires approved policy.

`finish` / `accept` remain read-only: exit 0 means accepted. Final completion
requires a confirmed merge and every bound issue closed; a merged delivery with
open issues is `closure_pending`. When configured, the separate completion
workflow runs from trusted default-branch code and rechecks live evidence.
Its generated runtime reference is an exact CLI version with a checked completion
protocol, not a permanent 1.12.0 pin or `latest`. In this product repository,
only a product change may use the approved source-build fallback when the
published completion runtime is unavailable. Metadata changes instead report
`runtime_upgrade_required` until a compatible runtime is published.
The completion runner classifies the original PR's complete file changes, even
after that PR has merged. It verifies the PR identity and head/base revisions
around paginated file reads; missing, truncated, or changing evidence fails
closed. A merge must not collapse a product delivery into an empty metadata
change, and metadata-only deliveries remain ineligible for source compilation.

## Adopting projects

SpecGit's source templates are product changes even when their output is a
local hook or Markdown entry point. Their tests and release belong here.
Generated copies in an adopting project do not become that project's business
code or build dependencies.

`init` / `setup` must preserve the adopting project's business workflows, build
commands and dependencies. The separate SpecGit acceptance workflow is an
explicit shared-adoption commitment when the user chooses to commit it. Its
isolated CLI installation does not install the adopting project's dependencies.
Shared policy must remain available to any remote verdict that uses it.
The private classification map in this repository is not imposed on an adopter's
business CI. The adopter chooses its own real required checks and their scope.

Current init/setup are not a local-only installation mode: init can update
AGENTS/CLAUDE, the SpecGit workflow and effective Git hook directory. Ignore
rules do not stop hooks or loaded agent guidance from affecting local work.
Review generated changes and select shared files deliberately; local refreshes
must not automatically create a PR, stage every file, run business deployment,
or publish a package. A new local-only lifecycle would be a separate product
change, not a CI path-filter adjustment.

Ordinary `init --force` refreshes preserve required checks, language, validation,
templates and the existing automation choice. Changing an automation choice
requires an explicit user decision; refreshing assets does not grant it.
