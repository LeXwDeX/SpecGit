# Delivery performance audit — 2026-09-07

Small changes should not pay for unrelated product builds or deployments.
This audit examines initialization, local integration, binding, CI scheduling,
acceptance, completion, release, and multi-stage delivery in the SpecGit product
repository. It separates measured costs from implementation findings and future
capabilities. The initial implementation is tracked by [#469](https://github.com/LeXwDeX/SpecGit/issues/469)
and [#470](https://github.com/LeXwDeX/SpecGit/issues/470), delivered through
[PR #471](https://github.com/LeXwDeX/SpecGit/pull/471).

## Measured baseline

These are observed runs, not a promise about every run or adopting repository.
Workflow duration includes runner scheduling; job and step times are separately
reported by GitHub. The 30-minute acceptance timeout is a ceiling, not a measured
duration for every change.

| Evidence | Observed duration | Implication |
| --- | --- | --- |
| [Docs PR #468 CI](https://github.com/LeXwDeX/SpecGit/actions/runs/33962441401), only `.specgit.yaml` and two Wiki Markdown files | 50 seconds from creation to completion | Product test matrix, lint, package and Nix jobs were skipped already |
| Its Detect changes / Metadata contracts jobs | 18 / 20 seconds | Classification and content validation each took less than a few seconds; startup dominates the small-change route |
| [Docs PR #468 acceptance](https://github.com/LeXwDeX/SpecGit/actions/runs/33962441256) | 68 seconds; sibling-check wait 35 seconds | The verifier waits for applicable evidence instead of spending 30 minutes running tests |
| [Product CI](https://github.com/LeXwDeX/SpecGit/actions/runs/33960983216) | 13 minutes 12 seconds | Full verification has a material critical path |
| Product Windows job / test step | 760 / 684 seconds | Windows tests dominate the measured full run |
| Product Linux / macOS test steps | 80 / 114 seconds | Raising every platform's parallelism is not an evidence-based fix for Windows |

## Lifecycle findings and disposition

| Surface | Current behavior and evidence | Optimization decision |
| --- | --- | --- |
| `init` and `setup` | Refresh has a local-maintenance route and preserves approved policy choices; [workflow selection](../src/cli/commands/init-workflow.ts) distinguishes this repository from adopting projects | Keep local maintenance lightweight; do not turn refresh into product delivery automatically |
| `status` | [Status](../src/cli/commands/status.ts) inspects local evidence and generated-asset drift | No demonstrated bottleneck justifies a speculative cache or a new daemon |
| Issue and PR binding | [Bootstrap](../src/cli/commands/issue.ts) carries an initial record, then the PR number, in separate pushed commits | Preserve resumability and remote evidence; reduce repeated verification through [#473](https://github.com/LeXwDeX/SpecGit/issues/473), not by dropping the binding |
| Verification scope | [Classifier](../scripts/ci-change-scope.mjs) already distinguishes metadata from product changes, but its consumers installed the toolchain before classifying | [#469](https://github.com/LeXwDeX/SpecGit/issues/469): classify using only Node and Git; install after the decision |
| Product build | `package.json` prepare builds during installation, followed by explicit builds in CI and RC; the RC pack guard can build a third time | [#470](https://github.com/LeXwDeX/SpecGit/issues/470): disable installation/packing lifecycle builds where an explicit build already supplies the artifact |
| Metadata validation | [Metadata contracts](../scripts/vitest.metadata.config.mjs) validate real schemas, generated assets and documentation without a product build | Retain content checks; finer record-only validation belongs to portable scope design in [#472](https://github.com/LeXwDeX/SpecGit/issues/472) |
| Acceptance and readiness | [Checks gate](../src/acceptance/gates/checks-gate.ts) requires current-head results after the readiness anchor; [self CI](../.github/workflows/ci.yml) reruns on ready-for-review | [#473](https://github.com/LeXwDeX/SpecGit/issues/473): separate product-input evidence from fresh delivery acceptance, with explicit provenance |
| Provider and merge evidence | [Merge](../src/cli/commands/merge.ts) rereads binding, request identity and actual merged state; [effective policy](../src/record/effective-policy.ts) reads the target's approved policy | Keep these correctness boundaries; no demonstrated cost warrants replacing live evidence with guessed success |
| Trusted completion | [Generator](../src/cli/completion-workflow.ts) installs a pinned runtime and permits approved-source fallback for product changes | [#469](https://github.com/LeXwDeX/SpecGit/issues/469): install source dependencies only when that fallback actually occurs |
| Release | [Release workflow](../.github/workflows/release-prepare.yml) starts release work only after explicit intent; default classification uses the locked Changesets parser | Retain release-specific dependency installation and validation; verification-only output cannot authorize release |
| Non-default targets | [Automation policy](../src/record/policy.ts) can name a delivery target, while [acceptance generation](../src/cli/commands/init-workflow.ts) uses the proved default branch | [#475](https://github.com/LeXwDeX/SpecGit/issues/475): separate trusted-runtime identity from acceptance target stages |
| Issue completion | Both providers support explicit issue closure, but [policy](../src/record/policy.ts) requires automatic merge when enabling it | [#476](https://github.com/LeXwDeX/SpecGit/issues/476): independently authorized closure after a verified manual or automatic merge |
| Preview to main promotion | [Delivery schema](../src/record/schema.ts) names one delivery/branch/PR and its issues; a release batch needs provenance from several deliveries | [#477](https://github.com/LeXwDeX/SpecGit/issues/477): preserve and aggregate actual promoted lineage, including already-closed issues |

## Scheduled follow-up work

The tracker owns these work items and their acceptance criteria. P1 means the
next optimization priorities; P2 follows the required domain/policy decisions.
These capabilities are scheduled, not implemented by PR #471.

| Priority | Issue | Dependency and intended result |
| --- | --- | --- |
| P1 | [#472 — applicable verification for adopting repositories](https://github.com/LeXwDeX/SpecGit/issues/472) | Generalize scope into approved project policy and generated GitHub/GitLab wiring; record changes do not trigger business builds or deployments |
| P1 | [#473 — reuse verification of unchanged product inputs](https://github.com/LeXwDeX/SpecGit/issues/473) | Follow scope policy; avoid repeating full CI for metadata or readiness changes while recomputing current delivery acceptance |
| P1 | [#474 — Windows verification critical path](https://github.com/LeXwDeX/SpecGit/issues/474) | Independent profiling and bounded sharding/setup optimization; preserve every Windows test and aggregate every result |
| P1 | [#475 — configured acceptance target branches](https://github.com/LeXwDeX/SpecGit/issues/475) | Foundation for feature-to-Preview and Preview-to-main stages, without changing the trusted default-branch identity |
| P2 | [#476 — issue closure independent of automatic merge](https://github.com/LeXwDeX/SpecGit/issues/476) | Follow target-stage policy; preserve issues, verify the merge, close only authorized bindings, and retry partial failures |
| P2 | [#477 — promotion issue lineage](https://github.com/LeXwDeX/SpecGit/issues/477) | Follow stage/completion contracts; aggregate included deliveries and handle reverted, partial, or ambiguous inclusion explicitly |

## First delivery: what changes and what is still expensive

Verification scheduling uses `--verification-only` and reports
`release_intent: null`. Default release-aware classification retains Changesets
validation, and the release planner rejects unassessed intent. CI and Security
scope jobs no longer install dependencies. Metadata self acceptance no longer
installs the repository toolchain. Trusted completion installs source dependencies
only when the compatible published runtime is unavailable and product scope
permits fallback. Product verification retains its explicit build and removes
duplicate installation and RC packing builds.

This removes deterministic work; it does not prove that the 13-minute product
critical path or every adopting project's pipeline is fixed. The Windows suite,
readiness replay, portable record-only policy, multi-stage triggers and promotion
lineage remain the separately tracked work above. Required checks, supported
platforms, real content validation, issue identity, and merge confirmation remain
in effect. There is no package publication intent in this delivery.

A local execution of the new classifier against the actual binding-only commits
on the delivery branch reported only `.specgit.yaml`, with `build: false`,
`metadata: true`, and `release_intent: null`. Three runs took 53, 55 and 53 ms.
This measures the local classification command only, excluding hosted runner
startup, package installation, and remote acceptance. The regression suite also
executes copied classifier modules without `node_modules`; a local warm toolchain
is not used as proof of dependency-free operation.

## Evidence limits

Code discovery used the repository graph with direct source verification. Coverage
metadata for the relied-on paths reported no recorded gaps in generation
`2026-09-07T07:29:29Z`; this is not proof of exhaustive code coverage. Excluded
local policy/record files were read directly. The audit is a lifecycle and
performance assessment, not an exhaustive security audit. No GitLab production
pipeline or adopting project's deployment was changed or measured. Remote timings
above are baseline observations from September 5, refreshed through the
authenticated GitHub CLI on September 7; post-change runs must be reported
separately rather than compared as identical workloads when their contents differ.
