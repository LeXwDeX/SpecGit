# Guarded delivery completion

CLI completion and trusted remote completion share `completeDelivery`. This
boundary implements repair lifecycle work in #489; the whole automation
programme remains tracked by #493.

## Product responsibilities

A delivery binds a branch or worktree, issues and one request. Acceptance is a
read-only judgement about that delivery. Completion additionally confirms its
merge into the configured target and closure of its bound and verified derived
repair issues. Neither result proves that an entire programme is complete.

An [aggregate scope](scopes.md) supplies explicit required membership independently
of the current binding. Its read-only historical observer reuses required-check,
CI, convention and repair-resolution rules without invoking checkout gates for
unrelated deliveries. Scope declarations do not grant merge or closure effects.

The completion core owns approved-policy proof, current-head acceptance, CI
eligibility, guarded merge, closure and readback. It receives narrow Git, forge,
binding-read, policy-resolution and evaluation capabilities, and returns domain
observations. It cannot create issues, write bindings, configure protection,
prompt or print. CLI adapters own process exits and human output. The remote
driver owns polling, repair creation and recovery; its entry point verifies the
trigger, trusted runtime and delivery checkout. Init, setup and bootstrap keep
their separate boundaries.

An active acceptance job must not wait for itself to finish. Open-request
acceptance collects repair obligations and checks the required CI evidence.
Completion proves resolution only after all current-head CI has settled. A
read-only verdict for a merged request also checks unresolved repair evidence
before reporting completion.

## Repair operation lifecycle

Before creating a repair issue, the trusted runner records an intent in the
parent PR/MR discussion and confirms its readback. The intent carries the
repository and request identity, failed head, approved-policy hash, failure
cause and prepared issue content. After creation or adoption, a second
confirmed declaration records the issue identity.

A fresh runner reconstructs these operations from the complete discussion.
An intent without a receipt remains pending. Recovery searches relevant open
and closed issue history using the operation identity before creating anything;
a lost creation response therefore does not require an in-memory checkpoint.
Existing materialized work is receipted even after policy or source history
changes; those changes still prevent new creation and automatic resolution.
Conflicting identities, incomplete pagination or unavailable reads stay unknown.
Independent simultaneous writers are not transactionally serialized; ambiguous
creation is reported for reconciliation rather than selecting an arbitrary issue.

Automatic closure of a derived repair requires the unchanged approved policy,
failed-head ancestry in the retained PR/MR head, current successful evidence for the original
failure, and no competing open delivery claiming that repair. Removing a failed
check does not discharge it. Explicit adoption is available through the existing
`specgit bind --issue <number>` command after preserving the PR/MR body's closing
references; that changes the reviewed delivery scope.

Completion rechecks the binding, policy, request and repair declarations before
writes, submits the expected head to the forge, confirms the merged request,
and reads all relevant issues again. Source repair ancestry is independent of
the target checkout so squash and rebase merges retain a valid proof. A successful mutation response alone is
insufficient. Interrupted closure remains recoverable on the next execution.

## Authority and limits

The binding declares the original scope; approved target policy authorizes
completion effects. Repair declarations extend that scope only through the
forge adapter's verification of repository write authority. GitHub uses current
collaborator permissions or provider-backed writable app evidence; GitLab uses
current project membership. Historical candidates also require independently
verified creator write authority before adoption; conclusively untrusted
candidates are ignored. Body markers remain lookup hints. Untrusted discussion text cannot add an
obligation; unavailable permission evidence is not an empty log.

These are current writer declarations, not immutable execution attestations.
Writers can modify or delete discussion state. Complete removal of the log, or
loss of its authors' authority, cannot be reconstructed from the remaining
comments alone. The design covers ordinary runner interruption while preserving
the existing forge trust boundary; it does not promise a tamper-proof journal or
exactly-once writes across unrelated processes. No secret, external database or
protected metadata branch is introduced.

## Remaining programme boundaries

Repository-wide recovery after lost events (#492), portable CI selection (#472),
verified-input reuse (#473), measured Windows
performance (#474), and Git promotion lineage (#477) remain separate work.
A repair issue's completion does not close #493 or prove these capabilities.
