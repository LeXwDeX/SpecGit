# SpecGit delivery

SpecGit binds intended work to Git and forge evidence, then distinguishes acceptance from confirmed delivery completion.

## Language

**Delivery**:
A named branch or worktree binding containing issues and one pull or merge request.
_Avoid_: task list, release

**Binding**:
The authoritative declaration connecting a delivery's execution context, issue numbers and request in `.specgit.yaml`.
_Avoid_: completion proof, cache

**Approved policy**:
The target-branch rules that authorize evaluation and configured completion effects; a proposed workspace policy cannot authorize itself.
_Avoid_: local settings, agent permission

**Acceptance**:
A read-only verdict derived from the binding, policy and current Git and forge evidence.
_Avoid_: merge, completion

**Verification decision**:
The check names selected from approved policy and complete immutable changes, with per-path reasons. CI planning, acceptance and historical completion share this decision.
_Avoid_: acceptance, cached green result, execution proof

**Delivery completion**:
A confirmed merge into the configured target with every bound issue and verified derived repair issue confirmed closed.
_Avoid_: acceptance, programme completion, publication

**Repair issue**:
An independently verifiable failure cause that needs its own tracked resolution while the original delivery remains traceable.
_Avoid_: failed delivery replacement

**Scope**:
An approved declaration of a parent issue and required issue/target pairs across deliveries, stored independently of the replaceable binding. Its assessment derives each member's completion from historical Git and forge evidence.
_Avoid_: current delivery, all open issues, checklist completion

**Repair declaration**:
A provider-verified repository writer statement on the parent request, recording an intended repair operation or its created issue. It is mutable forge state, not proof of an immutable execution.
_Avoid_: body marker, binding file, execution attestation

**Harness**:
The derived integrations that guide agents and invoke SpecGit using the authoritative policy and binding.
_Avoid_: policy, acceptance authority

**Publication**:
A separately authorized release whose package registry, version tag and release evidence are confirmed.
_Avoid_: delivery completion
