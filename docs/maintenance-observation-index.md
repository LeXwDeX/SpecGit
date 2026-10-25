# Maintenance observation index

Investigation for [#807](https://github.com/LeXwDeX/SpecGit/issues/807).

## Finding

`MaintenancePlan::apply` passed the filtered `changes` index to a closure that sliced
`pending`, which contains changed entries only. When observations retained unchanged
entries, the index no longer matched the changed prefix.

The defect produced three outcomes:

- Leading observations panicked at `pending[..2]` when only one changed entry existed.
- Trailing observations panicked with the same out-of-range slice.
- Between observations compared an overlapping dependency against a postimage that
  was not written yet, returning `ConcurrentEdit`.

The repair in [runtime/src/assets.rs](../runtime/src/assets.rs) builds the same
`filtered` sequence used by the transaction and counts changed entries in the
filtered prefix for the current callback, before its corresponding write. The public `before_write` callback keeps its existing index
meaning. No clamp or panic catch is used.

## Reachability

- Internal module contract: reachable through `MaintenancePlan::observe` and
  `MaintenancePlan::apply` with real temporary files. This is the tested layer.
- Public library: `observe` is crate-private, so external callers cannot add
  observations directly.
- Installed CLI: not demonstrated on a normal setup history. `doctor` is the only
  product caller that maps native observations into `MaintenancePlan`. A setup
  receipt-only change would be required, and no normal setup transition produced
  one in this investigation.

## History

`fe692700` introduced the setup guard receipt and its generation. `v2.12.0` has only
the independent `guard-hooks.json` receipt; `v2.13.0` is the first release that
contains the setup guard. No normal release history writes a version-1 setup receipt.

## Tests

`assets::maintenance_observation_tests` covers:

- leading observations with a changed entry;
- between observations with overlapping dependencies on the written and pending
  entries;
- trailing observations;
- a failed write restoring written bytes and clearing the pending barrier;
- a later edit preserved with the pending barrier retained and rollback refused.

Before the repair, the first three cases failed by panic or `ConcurrentEdit`. After
the repair, all five pass together with the existing asset tests.

## Limits

The investigation did not reproduce the defect through the public library API or an
installed CLI command. It did not exercise Windows path aliases. These limits do not
change the internal index contract covered by the tests.
