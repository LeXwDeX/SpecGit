# Native GitHub releases

GitHub Release is the permanent publication channel. npm publication, promotion,
registry checks and partial-publication recovery have been removed.

## Release

After the intended changes are merged, dispatch the workflow on `main`:

```sh
gh workflow run release-prepare.yml --ref main -f release_version=2.1.1
```

The version must match Cargo and the private development workspace. The workflow
builds macOS arm64 on GitHub-hosted `macos-15`, and Linux x64 glibc and Windows
x64 on owner-provided self-hosted runners, with pinned Rust. macOS jobs verify
the hosted environment, ARM64 architecture and the image-provided compiler
without changing system Xcode selection. Missing tools fail the job. Each compiled binary runs three simple smoke checks:
`--human --version`, `--help` and `--schema`. Release does not repeat full source,
installed native CLI regression suites; those remain in CI.

When all three builds and smoke checks succeed, the final job verifies the source,
architecture and SHA-256, packages the tested executables using Python 3.13 ZIP
support, and signs the checksum manifest with Cosign 3.1.3 using GitHub Actions
OIDC. It publishes exactly these assets:

- `specgit-<version>-darwin-arm64.zip`
- `specgit-<version>-linux-x64-gnu.zip`
- `specgit-<version>-win32-x64.zip`
- `SHA256SUMS`
- `SHA256SUMS.sigstore.json`

Only the final job has repository write and OIDC token permissions, and only its publisher step
receives the workflow's `GH_TOKEN`. The publishing runner needs GitHub CLI 2.99 or newer (including `gh api --slurp`).
No custom release credential is needed. The
publisher checks current `main` and the three successful build jobs before writing,
verifies the signature against the exact main Release workflow identity, creates a
draft, uploads missing assets, verifies downloaded bytes, then makes the Release
stable/latest. Checksums also appear with the source/build link in Release notes.
The internal `native-release.json` and smoke reports remain Actions artifacts,
not Release attachments. A branch dispatch cannot publish.

## Resume an interrupted publication

For failed publication, reuse the retained signed bundle from the original attempt.
Re-signing creates different signature bytes and cannot overwrite an existing
immutable signature asset. Before any upload, retrying the job with the original
successful build artifacts is safe.
For a failed run, manual recovery requires all three native build jobs and every
assembly step before publication, including signing, to have succeeded. A build
or signing failure is not recoverable publication evidence. The retained signature
and archive hashes are verified again before any write.
Matching tags/assets are reused; different immutable bytes or a foreign tag stop
the run. Do not rebuild and overwrite an already published version.

The Actions artifact `specgit-release-<source SHA>-<attempt>` also supports explicit recovery
through the existing authenticated `gh` session:

```sh
node runtime/distribution/publish.mjs \
  --directory /absolute/native-bundle \
  --version 2.1.1 --source <current-main-sha> --build-run <qualified-run-id> \
  --github
```

The recovery runner needs Python 3.13, Node.js and Cosign 3.1.3 (or compatible).
Without `--github`, archive/checksum verification is offline and read-only and does
not claim signature verification. With `--preflight`,
the publisher verifies provenance and current main but performs no publication.
Retired `--npm` and npm recovery flags are rejected. Existing public npm versions
are historical; this workflow does not change or delete them.

See [manual installation](../../README.md#install) and
[v2 migration](../../docs/migration-v2.md).

## Private engineering compatibility

The public npm wrapper, platform-package staging and npm-installed qualification
have been removed. CI installs a copy of the compiled native executable and runs
the full Rust test inventory against it. The private root Node workspace only checks repository contracts. The v1
TypeScript implementation and package fixtures are retired. Historical v1 guides
are archived and do not provide another supported workflow.
