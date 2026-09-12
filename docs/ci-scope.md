# CI scope and release intent

This page describes the repository's retained TypeScript engineering gates.
Public SpecGit v2 is the native CLI described in [README](../README.md); its
release artifacts follow the [native release procedure](../runtime/distribution/README.md).

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

## Documentation short path

Use this path for an intended change limited to README prose, Wiki pages,
ordinary documentation, or manual project guidance in AGENTS/CLAUDE. Shipped
templates, generated-block source, executable workflows, and build inputs
retain their product classification. Judge the actual inputs;
a Markdown extension alone does not settle their role.

1. Reuse the existing issue/PR when it covers the same WHY. Read the requested
   pages and only the contract or source needed to verify their changed claims.
2. Edit those pages and inspect their diff once for accuracy, links, and scope.
   Preserve generated regions; manual project guidance belongs outside them.
3. Run `node scripts/ci-metadata-check.mjs` once. Existing dependencies suffice;
   if missing, install the locked verification dependencies with `--ignore-scripts`.
   Fix failures caused by this change and rerun only the affected check; record
   a pre-existing unrelated failure without expanding this task to repair it.
4. The local edit is ready when its relevant content and checks are correct.
   If delivery is authorized, commit only its intended files, push the final
   content, and use the existing lightweight remote acceptance before merge.
   Mark the PR ready after that final push. Pending CI is a wait state, not a
   reason to rebuild, rewrite documentation, or create another repair issue.

This path replaces the product TDD and multi-round quality-review loops for
documentation. It requires no product build, full test suite, mutation test,
architecture audit, parallel review agents, package release, or new test written
only to assert a sentence. Repeat verification when a subsequent change or a
relevant failure justifies it; passing checks are a stopping condition.

In a shared dirty checkout, keep the requested edit separate from pre-existing
source work. A PR that already includes product changes still needs product CI;
do not turn a documentation request into finishing those unrelated changes.
Publish Wiki pages from the reviewed document set and verify the remote commit;
describe only released behavior as currently available.

## Verification by changed surface

All CI/CD in this repository uses our self-hosted runners, including acceptance,
completion, security, and release. GitHub-hosted runners and hosted fallback jobs
are prohibited by the owner's #528 decision to preserve account minutes. Linux
X64 handles shared jobs; both TypeScript and Rust require native Linux X64, macOS
ARM64, and Windows X64 legs. This replaces the retired #105 shadow arrangement.
Registration alone is not execution evidence: current-head job results are required.

GitHub's managed CodeQL default setup is separate from the committed workflow
files. Its runner type must be `labeled`, with `code-scanning` assigned to the
Linux X64 runner. Verify both the default-setup API response and actual analysis
job runner labels; YAML inspection alone misses this configuration. Keep the
existing languages and query suite when changing the runner route.
Managed analysis also requires working Node.js and Python 3 commands on the
runner's default PATH; setup steps in another job do not provide that environment.
Verify those commands as the runner user before validating the managed scans.
After a migration, verify that the trusted Completion workflow is active and
successfully handles an already merged request on the default branch.

Windows requires Git for Windows (including Bash), PowerShell 7, and Visual Studio
Build Tools with the C++ desktop workload and Windows SDK. CI checks prerequisites
and installs pinned Node, pnpm, and Rust versions. An unavailable runner or missing
tool leaves verification pending or failed; it never redirects to a hosted runner.

PR code changes and ready transitions run acceptance as the final CI job, after
`Required verification`. Standalone acceptance handles body edits and merged
request signals without polling for sibling jobs. This dependency order leaves
the single Linux runner available for the work acceptance needs. After changing
the source acceptance generator, run `pnpm run build` and
`node scripts/refresh-self-acceptance.mjs` to refresh its CI block and standalone
workflows; metadata validation checks that the shared job has not drifted.

For validation before an authorized merge, a draft branch can use a `[skip ci]`
commit and a manual **CI** dispatch at that branch. Skipped automatic checks do not
prove acceptance. The routing change reaches default-branch schedules and trusted
completion only after merge; do not run their older hosted versions during migration.

| Changed surface | Required verification | Build or publish consequence |
| --- | --- | --- |
| CLI/domain/provider source, shipped generators and hook scripts, schema, templates, distributed skills, tests, build scripts, package/build dependencies, executable workflows | Product build, both typechecks, lint, tests and applicable security checks on the supported platform matrix | Build and test the product under review; publish only with release intent |
| Explicitly recognized shared documentation, policy/record/provider data, `.gitignore`, project AGENTS/CLAUDE guidance, issue/PR templates, reviewed release/review metadata, and local agent command/skill Markdown copies | Real schema, generated-content, configuration-shape and documentation contract validation; delivery acceptance still reads real git, forge and current-head CI evidence | Frozen verification dependencies installed with `--ignore-scripts`; no product compilation, typecheck, lifecycle build or implied release |
| Nix inputs and their CI wiring | Nix verification in addition to the applicable product checks | No implied release |
| Dependency manifests, lockfile and security wiring | Dependency audit in addition to the applicable product checks | No implied release |
| Valid nonempty release changeset or package version change | Validate release intent and run the release preparation/publishing gates appropriate to that stage | May start the explicitly authorized release flow, including an expressly requested docs-only release; a green ordinary PR alone cannot publish |
| Local caches, CLI/device state, credentials, logs and machine files | Keep outside committed source and release inputs; reject newly committed local state | Never use a developer's local copy as build, release, or acceptance evidence |
| Unknown paths, mixed source/metadata changes, scheduled or explicitly dispatched verification | Full product verification; relevant toolchain checks also run | Fail closed on incomplete change evidence; no inferred release intent |

The exact scheduling map lives in
[`scripts/ci-change-scope.mjs`](../scripts/ci-change-scope.mjs). Verification
consumers use `--verification-only`: only Node and Git are needed to classify
the complete committed diff, before installing a project toolchain. That mode
reports `release_intent: null`, meaning release intent was not assessed. The
default release-aware mode uses the parser installed by the locked Changesets
CLI to validate release notes. Ignore patterns do not determine scope.
PRs use the merge base and PR head; pushes use the event's before/after commits;
merge groups use their complete base/head range. Missing or invalid commit
evidence fails the job. A new branch without a prior revision, scheduled checks
and manual verification dispatches select full verification; unsupported events
fail closed.
Explicit metadata paths are a narrow allowlist; other paths require a build.
For example, `.agents/skills/specgit-issue/SKILL.md` is a local integration copy,
while the shipped `skills/specgit-issue/SKILL.md` is product content.
The lightweight configuration allowlist includes `.changeset/config.json`,
`.coderabbit.yaml`, `.github/dependabot.yml`, `.github/CODEOWNERS`, `.gitignore`,
and both YAML and legacy Markdown issue templates only because Metadata
contracts parses and validates their repository-critical shape. The Markdown
frontmatter must declare a supported English delivery title and its matching
`kind::<type>` label, and its body must be nonempty. YAML issue forms obey the
same title/label policy. `CODEOWNERS` needs valid patterns/owners and a default
`*` owner. `.gitignore` needs exactly one current, ordered SpecGit managed
region and no later negation that exposes its local assets.
Executable local integration configuration such as
`.devcontainer/devcontainer.json` and `.opencode/hooks.json` remains on the
product route.

Every path admitted to metadata-only CI has a concrete fail-closed check. A
required file deleted from the candidate tree, a malformed configuration, a
damaged managed region, a missing mandatory generated file, or a byte mismatch
against a generator fails Metadata contracts. It cannot turn into a successful
lightweight result merely because the classifier recognized its path. Unknown
paths and mixed diffs take full product verification instead.

Deletion of accidentally tracked known local state is permitted as metadata
cleanup; adding or modifying that state is rejected without reading its values.
`node_modules`, `dist` and coverage remain generated local output, not committed
source. CI produces its own dependencies and build artifacts; a verified `dist`
is part of the published package, while an arbitrary developer build is not a
substitute for that release verification.

The classifier emits `build`, `metadata`, `nix`, `dependencies`, and
`release_intent` (a boolean in release-aware mode, `null` in verification-only
mode). The release planner rejects an unassessed intent. Its `--assert-metadata` option proves only that the complete
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

For verification scheduling without installing dependencies:

```bash
node scripts/ci-change-scope.mjs --base <base-sha> --head <head-sha> --verification-only
```

CI and Security scope jobs use this mode. Self acceptance installs the project
toolchain only for product changes; metadata acceptance installs only the pinned
CLI into its isolated prefix. Completion classifies with approved source and
installs approved source dependencies only if a product change needs the runtime
fallback. Metadata contracts still validate actual content, including release
notes; skipping release assessment during scheduling does not exempt that content.

The test matrix, lint/typecheck and RC jobs install locked dependencies with
`--ignore-scripts` and build explicitly once. RC tarball verification also disables npm lifecycle
scripts so it checks that explicit build without rebuilding during `npm pack`.
Normal package installation and the release workflow retain their lifecycle
behavior. The measured baseline and scheduled broader improvements are recorded
in the [delivery performance audit](delivery-performance-audit.md).

## Required verification

**Metadata contracts** runs on every classified change. It loads the actual
record, policy and provider schemas, requires this repository's nonempty
`Required verification` policy entry, and checks that each required name is
produced by CI. It parses all repository metadata named above, validates
changesets and selected issue/PR templates, checks the managed ignore block and
`CODEOWNERS`, and compares the acceptance workflow, mandatory `AGENTS.md`, any
present `CLAUDE.md`, and all ten setup entry points with their real generators.
It then runs the selected documentation, link, skill-mirror and workflow-security
contracts. Its standalone Vitest configuration has no product-build global setup
and does not consume `dist`. Missing and malformed inputs fail the job; the
metadata branch never falls back to compiling source to hide that failure.

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
history and classifies the change with Node and Git before installing a project
toolchain. Product changes install locked dependencies with `--ignore-scripts`,
then build and run the current CLI.
Metadata-only changes check out the repository's trusted default branch into
an isolated directory, install locked dependencies with lifecycle scripts disabled,
and compile the retained TypeScript engineering verifier there. They do not build
or test the native product. Public v2 packages contain no TypeScript `dist/` modules
and are not used as engineering runtimes. Policy/schema implementation changes
take the product path; source installation or compilation failure fails the job.

Both paths resolve the approved target-branch policy and wait through authenticated
`gh` for its required checks
at the exact PR head and the same ready-for-review freshness boundary. They
associate Actions checks with their current workflow execution; an obsolete
cancelled run cannot provide the successor's required aggregate, even if its
last job starts after readiness. Missing provenance fails closed. Each path
then runs `finish --json`. Classification, installation, waiting, or verdict
failure fails the job; an absent classification cannot select a success path.
For adopting projects, generated acceptance waits up to 25 minutes for sibling
checks within a 30-minute job. This repository instead orders acceptance after
verification in CI; standalone acceptance evaluates once without waiting.
During a workflow rerun, terminal jobs are usable before workflow completion only
when the attempt job API proves their current attempt, head, and check identity.
Checks without current-attempt proof remain pending until the workflow settles.
GitHub may copy retained successful jobs into the current attempt with new check
IDs and their original start times; the attempt API proves these current copies.
Version automation waits up to 35 minutes within its 40-minute step. Incomplete
evidence still prevents completion.
Changing policy in the PR cannot grant that PR permission to weaken its own
checks or enable automatic merging. First adoption can use candidate policy
for read-only acceptance when no approved policy exists; automatic completion
requires approved policy.

`finish` / `accept` remain read-only: exit 0 means accepted. Final completion
requires a confirmed merge and every bound issue closed; a merged delivery with
open issues is `closure_pending`. When configured, the separate completion
workflow runs from trusted default-branch code and rechecks live evidence.
Legacy adopter workflows use an exact CLI version with a checked completion
protocol. This repository instead compiles the retained engineering runtime from
its separate checkout pinned to the trusted default-branch event SHA, for both
product and metadata deliveries. It never executes PR source as its write-capable
completion runtime or installs the public v2 launcher for this purpose. This
repository requires verified single-pass support in that runtime and invokes
completion with `--single-pass`: pending CI returns immediately, freeing the
single Linux runner for queued verification jobs. Later CI or acceptance completion
events retry the evidence check; the normal adopter polling defaults remain unchanged.
The completion runner classifies the original PR's complete file changes, even
after that PR has merged. It verifies the PR identity and head/base revisions
around paginated file reads; missing, truncated, or changing evidence fails
closed. A merge must not collapse a product delivery into an empty metadata
change; native product checks remain determined by the original changed inputs.
The SpecGit repository's reserved `changeset-release/main` proposal still runs
Acceptance and every version/release gate, but its successful Acceptance run
does not start bound-delivery completion: that generated proposal deliberately
carries the preceding delivery record and is not itself a delivery. This
source-repository exclusion does not alter `workflow_dispatch` recovery or the
completion workflow generated for adopting projects.

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
