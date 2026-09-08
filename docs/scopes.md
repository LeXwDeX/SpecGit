# Aggregate delivery scopes

A delivery binding describes one PR/MR. An opt-in scope describes required work
across deliveries, independently of the binding that the next delivery replaces.
`specgit finish --scope <name> --json` assesses that scope without changing issues,
requests, Git refs, or the current delivery. Plain `finish` and `accept` retain
their eleven-gate delivery verdict. `status` remains local-only.

Create `spec_git/scopes/<name>.yaml` through a normal tracked delivery and merge
it into the repository's remote default branch:

```yaml
version: 1
name: programme
parent: 100
required:
  - issue: 101
    target: preview
    request: 110
  - issue: 102
    target: release/stable
```

The name is lowercase kebab-case, at most 100 characters. There must be 1–100
unique required issue numbers, excluding the parent. Each target is an explicit
Git branch name; it need not be the platform default branch. A request number is
optional and selects one PR/MR when several proven deliveries claim the member.
All numbers must be positive safe integers. Unknown keys are rejected.

Workspace declarations are proposals. Assessment pins the live remote default
branch commit and reads its complete first-parent declaration history from local
Git objects. Required membership, targets, the parent, and an existing request
selection cannot be removed or replaced in version 1. Additions and an initial
request selection are allowed. Deletion, reduction and retargeting need a future
explicit amendment protocol; version 1 never interprets them as approved scope
reduction. Shallow, unavailable, or more than 1,000 declaration revisions yield
unknown. A force-rewritten remote history cannot be compared with history no
longer available to this invocation; protect the declaration branch accordingly.

For each member, SpecGit reads authenticated forge facts, discovers or selects
the request, and proves its immutable request-head binding. Completion requires
the declared target merge, matching closing references, original approved policy,
applicable current-head CI with required-check freshness, and closure of all
bound and derived repair issues. Closed issue state alone is insufficient.
Unrelated open repository issues are outside this scope. Shared requests are
evaluated once per assessment. The caller's branch is not historical delivery
evidence, so no checkout-context gates are fabricated for other deliveries.

Fetch the retained request heads and complete target history when diagnostics
report unavailable objects. On GitHub, a request head is available through
`git fetch origin refs/pull/<number>/head`; on GitLab use
`git fetch origin refs/merge-requests/<number>/head`. The command itself does not
fetch or change refs. Forge state can change after an assessment; its result is
an observation, not a permanent attestation or a release authorization.

The JSON envelope contains `scope`, separately from a delivery `verdict`:

| Scope state | Exit | Meaning |
| --- | --- | --- |
| `completed` | 0 | Every required delivery and the parent issue are confirmed complete/closed. |
| `ready_to_close` | 1 | Every member is complete; the parent remains open. Assessment does not close it. |
| `incomplete` | 1 | Required work is open, unbound, closed without a proven delivery, or has a known unmet completion condition such as failed/pending CI or an open companion issue. |
| `unknown` | 3 | Evidence is missing, ambiguous, invalid, or changed during assessment. |

`scope.declaration` reports the path, branch, commit, SHA-256 content hash and
history revisions. Members report exact issue numbers and targets, state,
diagnostics, and verified request/head/merge/policy identities when complete.
No scope result authorizes merging the current delivery or publishing a package.

SpecGit's own automation programme is declared in
[`automation-programme.yaml`](../spec_git/scopes/automation-programme.yaml).
Run `specgit finish --scope automation-programme --json` after its declaration
is merged. It remains incomplete while any required optimization is outstanding.
