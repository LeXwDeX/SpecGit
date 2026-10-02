# SpecGit 2.3.0 Preparation Ledger

Preparation date: 2026-10-02. This ledger describes the merged scope and remaining
qualification/publication gates. A source version or merged preparation PR is not
proof that signed release assets have been published.

## Merged Scope

| Specification | Implementation | Contract |
| --- | --- | --- |
| [#647](https://github.com/LeXwDeX/SpecGit/issues/647) | [PR #648](https://github.com/LeXwDeX/SpecGit/pull/648), `350bc5cc` | Manual installation and existing-project Wiki guidance |
| Dependency maintenance | [PR #649](https://github.com/LeXwDeX/SpecGit/pull/649), `656dd0b6` | Pinned setup-python action |
| [#650](https://github.com/LeXwDeX/SpecGit/issues/650) | [PR #653](https://github.com/LeXwDeX/SpecGit/pull/653), `3065e3cd` | Scoped setup ownership diagnostics without secret disclosure |
| [#629](https://github.com/LeXwDeX/SpecGit/issues/629) | [PR #654](https://github.com/LeXwDeX/SpecGit/pull/654), `72a7d972` | Bounded self-hosted recovery in the shipped skill and both guidance languages |
| [#628](https://github.com/LeXwDeX/SpecGit/issues/628) | [PR #655](https://github.com/LeXwDeX/SpecGit/pull/655), `58a499d4` | Shared inspection deadlines, descendant cancellation, partial-read and prewrite evidence |
| [#652](https://github.com/LeXwDeX/SpecGit/issues/652) | [PR #656](https://github.com/LeXwDeX/SpecGit/pull/656), `8e953607` | Explicit agents, project/global assets and worktree-private ownership receipts |
| [#630](https://github.com/LeXwDeX/SpecGit/issues/630) | [PR #657](https://github.com/LeXwDeX/SpecGit/pull/657), `56d01034` | Digest-bound project removal and rollback, shared-hook preservation, read-only checkpoint inspection |

All listed PRs were natively read back as merged to main, and all six associated
specification Issues as CLOSED/COMPLETED. Their checks qualify their own source
heads, not a later version-preparation or release revision.

## Version Preparation

[#658](https://github.com/LeXwDeX/SpecGit/issues/658) owns the independently
verifiable version/documentation preparation. Cargo, its own lock entry, the
private Node workspace and release input must agree on exactly 2.3.0. Dependency
resolutions, platform protections and historical records are unchanged.

The preparation request must record locked Node tests, documentation metadata,
pinned Rust fmt/Clippy/all-target tests, native distribution tests, and isolated
macOS arm64 source/build/install/profile qualification for its exact source.
Installed qualification accounts for every test executable. The existing explicit
real-Claude host manual qualification remains ignored, not a passed host journey.
Final review and current-head Linux/macOS/Windows source/installed CI must pass
before main merge and native closure of #658.

The user-level operational CLI is not replaced by a project build or test artifact.
For an older installed version, confirm the actual help/schema before using 2.3
project setup or removal options. Ownership conflicts preserve user files.

## Separate Publication Gate

[#651](https://github.com/LeXwDeX/SpecGit/issues/651) remains open through signed
publication and final repository readback; the preparation PR must not close it.
At this preparation snapshot, publication is still pending. The release must:

- Dispatch the [Release workflow](../.github/workflows/release-prepare.yml) on the
  verified current main with exactly 2.3.0 after its applicable CI passes.
- Build and smoke-test Linux x64 glibc, macOS arm64 and Windows x64 on the pinned
  hosted runner/toolchain contract; preserve immutable prior tags and assets.
- Publish the three ZIPs, SHA256SUMS and its Sigstore bundle; download and verify
  exact digests and the main-workflow GitHub Actions OIDC signer identity.
- Read back source provenance, stable/latest release state, linked Issues/PRs,
  synchronized Wiki content and any preserved cleanup blockers.

See the [release procedure](../runtime/distribution/README.md) for publication
and interrupted-publication recovery. Recorded feature checks or previews do
not substitute for these release receipts.
