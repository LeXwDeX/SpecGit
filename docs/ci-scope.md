# CI scope

The repository builds and tests the Rust 2.0 CLI. The v1 TypeScript implementation,
Vitest suite, npm package checks and custom acceptance/completion controllers
are retired. Historical v1 documents are not active development instructions.

## Documentation short path

For README, Wiki, ordinary docs and manual project guidance, review the relevant
content and run `node scripts/ci-metadata-check.mjs`. Install locked Node tooling
with `pnpm install --frozen-lockfile --ignore-scripts` if needed. No Rust rebuild
is required for a documentation-only change. Executable workflows, shipped
runtime references, schemas, templates and scripts are product inputs even when
they use Markdown. Preserve unrelated dirty files.

## Product verification

The change classifier examines the complete Git diff, retains both sides of a
rename, and fails closed on missing range evidence. `.gitignore` never grants
verification exemptions. Unknown paths require product verification.

All native CI uses GitHub-hosted standard runners: `ubuntu-24.04` (Linux x64),
`macos-15` (ARM64), and `windows-2025` (Windows x64). These runners are [free and
unlimited for public repositories](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories).
If repository visibility changes, recheck the account billing allowance before
relying on hosted-runner costs.
The native matrix runs Linux x64, macOS arm64 and Windows x64. Each platform checks
Rust formatting and lint, compiles and runs every source test, verifies native
distribution tooling, compiles and installs the release executable, then repeats
the public regression inventory through that installed executable. Verified phase
outputs stay in the current job's temporary runner directory; a new job starts
clean. Qualification evidence is retained as Actions artifacts. Neither path treats
an incomplete phase as passed.

Repository contract tests check workflow permissions, standard hosted-runner
routing, signed publication identity, the required dependency chain and metadata
classification.
`Required verification` succeeds only when classification and repository contracts
pass and every applicable Rust matrix job succeeds. Documentation-only changes
must have the Rust job skipped. `SpecGit Acceptance` depends on that result and
requires a ready PR targeting main. The existing protected status name is retained.
GitHub owns merge eligibility and protection; there is no v1 `finish` verdict.

Dependency Review covers changed dependencies. Scheduled audit examines the native
Cargo dependency lockfile; private Node verification tooling is audited separately.
Windows hosted images must provide Git for Windows/Bash and the MSVC C++ workload
and Windows SDK. Missing tools or unavailable hosted capacity leave verification
pending or failed.

## Delivery and release

Use native SpecGit 2 Issue and PR operations with the installed schema and existing
user authorization. Verify current PR head checks before an authorized merge and
read back the merged request plus every associated Issue. A successful observation
is not delivery completion.

Merging does not authorize publication. The explicitly dispatched Release workflow
builds all three platforms from main, signs SHA256SUMS with the trusted workflow
identity, verifies the signature and uploaded bytes, and preserves immutable
releases. See the [native release procedure](../runtime/distribution/README.md).

Local CLI installation or init/setup refresh needs no product delivery when no
shared tracked changes are intended. Inspect the resulting diff before sharing it.
