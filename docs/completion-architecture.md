# Guarded delivery completion

CLI completion and trusted remote completion share one domain operation,
`completeDelivery`. This boundary is part of repair lifecycle work in #489;
the wider automation programme remains tracked by #493.

## Decision

The remote driver previously called a CLI command handler and interpreted its
exit codes and output fields as domain state. Both callers need the same
approved-policy proof, exact-head acceptance, CI eligibility, guarded merge,
issue closure and post-write readback. Those rules belong in `src/completion/`.

The completion operation receives a discovered repository and only its required
Git, forge, binding-read, policy-resolution and evaluation capabilities. It
returns domain observations and recovery actions. It cannot create issues,
write bindings, change repository protection, prompt a user or print output.
CLI adapters preserve the existing JSON and human output. The remote driver
owns polling, deadlines and repair creation; its outer entry point owns event
authentication, trusted runtime selection and the data checkout.

Initialization, local setup and delivery bootstrap keep their existing
boundaries. A broad lifecycle dispatcher would give these unrelated callers a
larger interface without resolving repair identity or incomplete scope. A new
protected relationship journal would add another authority and operational
surface; this extraction introduces no persisted state.

## Evidence and authority

Bindings declare responsibility. Approved target policy authorizes effects.
Git and forge facts establish whether acceptance and completion hold. The
harness invokes these rules and does not maintain a second verdict.

Completion rechecks the binding, policy and request before writes, submits the
expected head to the forge, confirms the merged request and reads every bound
issue again. A successful mutation response does not establish completion.
Missing evidence remains unknown; the output adapter alone maps that result to
the existing process exit contract. A remote deadline does not imply success.

## Migration boundary

The extraction preserves single-delivery behavior. It does not yet implement
derived repair adoption, aggregate scope, durable sweep recovery, portable CI
selection, evidence reuse or promotion lineage. Those features need their own
declarations, evidence and tests; moving orchestration code is not evidence that
they work. In particular, editable repair markers are discovery hints, never
authorization to close an unbound issue.
