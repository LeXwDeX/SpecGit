# SpecGit 2 terminology

SpecGit manages specification Issues, native PR/MR associations and observations.
The installed CLI's offline schema and [native reference](runtime/REFERENCE.md)
define the current contract. Historical v1 policy/binding terminology is not a
second execution model.

| Term | Meaning and boundary |
| --- | --- |
| Specification Issue | One independently verifiable need with Why, Scope, Approach and Acceptance; identified by its native repository and ID. |
| Project declaration | Local `.specgit.yaml`: provider/remote/target, language, templates, validation and observation preferences. It grants no authorization and does not contain a v1 Issue binding or forge protection policy. |
| Checkpoint / local selection | Recoverable Issue/request selection and uncertain-write intent under Git, owned by one branch and worktree. It gates tracked edits where hooks/guards are installed; it is not remote completion evidence. Use a separate worktree for independent delivery. |
| Native request | One PR/MR combining actual pushed changes and selected Issue references. Creation is a draft; marking ready is an authorized write. |
| Observation | A dated read of native checks, request state and Issue associations. Missing or changed evidence remains unknown. SpecGit does not calculate merge eligibility or reconstruct CI dependency graphs. |
| Verification | Applicable source, installed-runtime and platform checks. This repository's CI aggregates them in `Required verification` and `SpecGit Acceptance`; these check names are repository policy, not universal SpecGit commands. |
| Delivery completion | Native readback proves merge into the intended target and closure of every selected Issue. Passing CI, exit 0 or a merged request alone is insufficient. |
| Agent preference | Optional native auto-merge registration or supplementary Issue closure by an already authorized Agent through gh/glab. Both preferences default off; setting one grants no permission. |
| Host integration | Project guidance, user-level skill and registered hooks. Written registration, successful import, delivered context and human reading are separate facts. |
| Notification receipt | Acknowledgment that an event reached its transport. It does not prove human reading, approval, merge or completion. |
| Repair Issue | An ordinary specification for a distinct failure cause, selected within existing authorization. SpecGit does not run a repair-creation controller. |
| Publication | A separately authorized stable GitHub Release, with verified source/tag identity, signed manifest, ZIP hashes and installed artifact evidence. Delivery merge alone does not publish. |

GitHub/GitLab owns CI, protection, review and merge. The Rust core, watch and hooks
cannot merge requests, close Issues, delete branches or administer forge settings.
An authorized Agent can perform native operations outside those runtime boundaries.

See [CI scope](docs/ci-scope.md), [installation](docs/installation.md) and
[release recovery](runtime/distribution/README.md) for repository-specific procedures.
