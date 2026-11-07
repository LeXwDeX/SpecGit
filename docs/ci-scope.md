# CI scope

The repository builds and tests the Rust 2 CLI. The v1 TypeScript implementation,
Vitest suite, npm package checks and custom acceptance/completion controllers
are retired. Historical v1 documents are not active development instructions.

## Documentation short path

The short path only shortens verification. Documentation changes still need a
selected Issue and a PR. For README, Wiki, ordinary docs and manual project
guidance, review the relevant content and run `node scripts/ci-metadata-check.mjs`. Install locked Node tooling
with `pnpm install --frozen-lockfile --ignore-scripts` if needed. No Rust rebuild
is required for a documentation-only change. Executable workflows, shipped
runtime references, schemas, templates and scripts are product inputs even when
they use Markdown. Preserve unrelated dirty files.

## Product verification

The change classifier examines the complete Git diff, retains both sides of a
rename, and fails closed on missing range evidence. `.gitignore` never grants
verification exemptions. Unknown paths require product verification.
CI and security classification execute the classifier from the event's base commit,
not the pull request checkout. Missing base evidence fails closed.

For pushes to main and same-repository PRs, native CI routes Linux and Windows to
the owner's self-hosted Azure runners; macOS uses GitHub-hosted `macos-15` ARM64.
Fork PRs, merge groups and manual runs use GitHub-hosted runners for all three
platforms. Other CI jobs and release builds use GitHub-hosted runners. This differs
from the owner-runner-only decision in #528; a routing policy change needs owner
review, not an implicit change here. Dependabot PRs are same-repository PRs, so
third-party crate `build.rs` code can execute on the owner's Linux and Windows
machines. Review updates and runner isolation with that risk in mind.
GitHub-managed CodeQL default setup is configured separately in security settings.
The native matrix runs Linux x64, macOS arm64 and Windows x64. Each platform checks
Rust formatting and lint, compiles and runs every source test, verifies native
distribution tooling, compiles and installs the release executable, then repeats
the public regression inventory through that installed executable. Verified phase
outputs stay in the current job's temporary runner directory; a new job starts
clean. Qualification evidence is retained as Actions artifacts. Neither path treats
an incomplete phase as passed.

Repository contract tests check workflow permissions, exact native runner
routing, signed publication identity, the required dependency chain and metadata
classification.
`Required verification` succeeds only when classification and repository contracts
pass and every applicable Rust matrix job succeeds. Documentation-only changes
must have the Rust job skipped. `SpecGit Acceptance` depends on that result and
requires a ready PR targeting main. The existing protected status name is retained.
GitHub owns merge eligibility and protection; there is no v1 `finish` verdict.

Dependency Review runs on every PR and fails on high-severity dependency findings.
Administrator action is required: bind trusted `ci.yml` and `security.yml` workflows
in the repository ruleset, retain `SpecGit Acceptance`, and require the
`Dependency Review` check from GitHub Actions. Confirm the platform's required
workflow binding enforces the trusted base workflow and works with merge queues
before enabling it. Verify the ruleset and a failing high-severity test PR after
configuration. Repository workflow changes alone do not enforce the ruleset.
Scheduled audit examines the native
Cargo dependency lockfile; private Node verification tooling is audited separately.
Windows runners must provide Git for Windows/Bash and the MSVC C++ workload
and Windows SDK. Missing tools or unavailable runner capacity leave verification
pending or failed.

## Delivery and release

Use native SpecGit 2 Issue and PR operations with the installed schema and existing
user authorization. Verify current PR head checks before an authorized merge and
read back the merged request, its native closing set and every associated Issue. A
successful observation is not delivery completion; `completed` also requires each
selected Issue to appear in that request's native closing set and every associated
Issue to be closed.

Merging does not authorize publication. The explicitly dispatched Release workflow
builds all three platforms from main, requires successful `Required verification` and
`SpecGit Acceptance` checks on that exact source SHA before signing and again before
publication, then signs SHA256SUMS with the trusted workflow
identity, verifies the signature and uploaded bytes, and preserves immutable
releases. The signature covers only `SHA256SUMS`, and therefore the ZIP bytes; the
source commit, version, build run and internal `native-release.json` are not in the
signed payload, so cross-check the tag commit and the native build workflow run
separately. See the [native release procedure](../runtime/distribution/README.md).

Local CLI installation or init/setup refresh needs no product delivery when no
shared tracked changes are intended. Inspect the resulting diff before sharing it.
