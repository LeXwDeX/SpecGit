# Core Concepts

SpecGit's contract is built on real Git and forge evidence. It stores the binding
and project policy; acceptance is recomputed whenever it is requested.

## A delivery

A delivery consists of a branch or worktree, one or more issues, one PR/MR, and
required checks. Each issue is an independently verifiable WHY. The request body
must contain a closing reference for every bound issue in the same repository.
A reference declares the intended closure; actual closure is confirmed after merge.

## Acceptance and completion

| Outcome | What the evidence means |
| --- | --- |
| `accepted` | The current request head passes the acceptance gates |
| `rejected` | A required condition is demonstrably unsatisfied |
| `unknown` | Evidence is missing, unavailable, or incomplete |
| `closure_pending` | Merge is confirmed but some bound issues remain open |
| `completed` | Merge and all bound issue closures are confirmed |

`specgit finish` is read-only. Exit `0` does not itself merge a request.
A local test run or an edited checklist proves neither acceptance nor completion.
A verdict applies to the observed facts; collect it again after relevant changes.

The eleven gates cover record, policy, completeness, context, origin, provider,
issues, sequence, request, closing references, and checks. Required checks are
verified at the request head. Authentication failures and truncated evidence fail
closed; an unavailable fact cannot be treated as a successful check.

## State and configuration

| Surface | Role |
| --- | --- |
| `.specgit.yaml` | Delivery binding |
| `spec_git/policy.yaml` | Required checks and optional project rules/automation |
| `spec_git/providers.yaml` | Explicit GitLab host declaration when used |
| Generated workflow and managed guidance | Derived integration assets |
| Hooks and `setup` entry points | Local integration assets |

Generated regions are refreshed through `init`/`setup`; manual guidance belongs
outside their markers. A normal next delivery replaces confirmed completed
history. `unbind` is an explicit reset/abandon operation, not routine cleanup.

SpecGit verifies against existing Git, issue, PR/MR, and CI systems. It does not
require a separate proposal/spec/task-artifact lifecycle. Verification effort
follows the changed inputs; ordinary prose does not require product testing.

[Detailed concepts](https://github.com/LeXwDeX/SpecGit/blob/main/docs/concepts.md) · [中文](Concepts-zh)
