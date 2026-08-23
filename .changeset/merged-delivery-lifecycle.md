---
"specgit": patch
---

Merged-delivery lifecycle honesty (#298): `specgit unbind` on a tracked record now warns `record_deletion_tracked` (the working-tree deletion needs a commit — the next delivery's binding commit absorbs it) and `specgit init --force` on a tracked policy warns `policy_rewrite_tracked`, both instead of leaving silent working-tree residue after a delivery merges. Backed by a new read-only `GitPort.trackedFiles` member (`git ls-files` intersection, fail-closed as `tracked_probe_failed`, advisory at every call site) documented in the port-compatibility policy.
