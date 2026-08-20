---
"specgit": patch
---

### Merged-lineage anchor validation (#76)

Closes #76. The merged-delivery lineage gate passed the provider's
`merge_commit_sha` to `git merge-base --is-ancestor` as any non-empty
string. GitHub normally reports a hex object id, but nothing enforced
that: a malformed value rode git's opaque exit-128 path to fail closed
with an unclassified error, and a ref-like value (`origin/main`) was
resolved by git as a ref — silently accepted as a lineage anchor.

- `GitPort.headContains` now validates the anchor as a full hex object
  id (40 hex chars for sha1 repositories, 64 for sha256) before any git
  invocation. A non-hex anchor — empty, whitespace, padded,
  ref-like, abbreviated, wrong length — fails closed as
  `merged_lineage_unavailable` without invoking git, so the diagnostic
  is classified at the port, not recovered from a git error.
- Containment behavior is unchanged for valid anchors: exit 0 remains
  contained, exit 1 remains a decisive not-contained, unknown objects
  still fail closed.
- Port-level tests pin both directions: 40- and 64-hex anchors reach
  git unchanged (spawn-spy asserts the exact `merge-base` argv), and
  the malformed matrix (empty, whitespace, ref-like, abbreviated,
  39/41/63/65-length) is rejected with zero git invocations; a
  real-repository regression proves `origin/main` is never resolved as
  a ref.
