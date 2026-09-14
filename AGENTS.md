# Repository Guidelines

SpecGit 2 is a Rust library and native CLI for specification Issues, native PR/MR
aggregation and observation. GitHub/GitLab owns CI, protection and merge.

## Structure

- `runtime/src/`: typed library, CLI and forge/host adapters.
- `runtime/tests/`: public command and real subprocess regression tests.
- `runtime/schemas/` and `runtime/REFERENCE.md`: native declarations and contract.
- `runtime/distribution/`: native installation, signed ZIP release and validation.
- `runtime/scripts/`: resumable compilation and installed-runtime qualification.
- `scripts/`: repository metadata and workflow security checks using Node.

The v1 TypeScript runtime, tests, packaging and acceptance controller are retired.
Historical docs do not authorize running their old commands.

## Delivery

Load the specgit-native skill. Read `.specgit.yaml` and discover the installed
contract with `specgit --help` and `specgit --schema`. Search for duplicate Issues
and select complete Why / Scope / Approach / Acceptance specifications before
tracked edits. Preview Issue/PR writes with `--dry-run`, preserve native IDs and
all closing references, and use `--json` as the machine interface.

Target `main`, use Conventional Commit prefixes and the PR template. Use
`pr --status` and bounded `watch` for current evidence. Native gh/glab merge,
closure and publication operations require existing user authorization.
The declaration records preferences and grants no permission. Complete only
after current-head checks, confirmed target merge and every associated Issue
closure. Never weaken platform protection or skip required verification.

## Verification

For README, Wiki and manual guidance use the [documentation short path](docs/ci-scope.md#documentation-short-path):
one relevant content review and `node scripts/ci-metadata-check.mjs`.

For product changes use the pinned Rust toolchain in `runtime/rust-toolchain.toml`:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
node scripts/ci-metadata-check.mjs
cd runtime
cargo fmt --all --check
cargo clippy --locked --all-targets --features test-fixtures -- -D warnings
cargo test --locked --all-targets --features test-fixtures
```

Run relevant native distribution tests when changing installation or release.
CI verifies Linux x64, macOS arm64 and Windows x64 source and installed journeys
on self-hosted runners. `Required verification` aggregates the applicable jobs;
`SpecGit Acceptance` requires its success and a ready PR targeting main.
Publishing is a separate explicitly dispatched signed GitHub Release workflow.

Preserve unrelated dirty files and local artifacts. Prefer MCP graph discovery,
check coverage for evidence paths, and read source when results are stale or
missing. Use current-head and installed/runtime evidence for claims.
