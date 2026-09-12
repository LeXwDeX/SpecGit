# Native GitHub releases

GitHub Release is the permanent publication channel. npm publication, promotion,
registry checks and partial-publication recovery have been removed.

## Release

After the intended changes are merged, dispatch the workflow on `main`:

```sh
gh workflow run release-prepare.yml --ref main -f release_version=2.0.0
```

The version must match Cargo and the private development workspace. The workflow
builds macOS arm64, Linux x64 glibc and Windows x64 with pinned Rust on the three
self-hosted runners. Each compiled binary runs three simple smoke checks:
`--human --version`, `--help` and `--schema`. Release does not repeat full source,
package installation or installed-entrypoint regression suites; those remain in CI.

When all three builds and smoke checks succeed, the final job verifies the source,
architecture and SHA-256, then publishes exactly these assets:

- `specgit-darwin-arm64`
- `specgit-linux-x64-gnu`
- `specgit-win32-x64.exe`

Only the final job has repository write permission, and only its publisher step
receives the workflow's `GH_TOKEN`. No custom release credential is needed. The
publisher checks current `main` and the three successful build jobs before writing,
creates a draft, uploads missing binaries, verifies downloaded bytes, then makes the
Release stable/latest. Checksums and the source/build link live in the Release
notes. The internal `native-release.json` and smoke reports remain Actions artifacts,
not Release attachments. A branch dispatch cannot publish.

## Resume an interrupted publication

Rerun the failed workflow job so it uses the original successful build artifacts.
Matching tags/assets are reused; different immutable bytes or a foreign tag stop
the run. Do not rebuild and overwrite an already published version.

The Actions artifact `specgit-release-<source SHA>` also supports explicit recovery
through the existing authenticated `gh` session:

```sh
node runtime/distribution/publish.mjs \
  --directory /absolute/native-bundle \
  --version 2.0.0 --source <current-main-sha> --build-run <successful-run-id> \
  --github
```

Without `--github`, bundle verification is offline and read-only. With `--preflight`,
the publisher verifies provenance and current main but performs no publication.
Retired `--npm` and npm recovery flags are rejected. Existing public npm versions
are historical; this workflow does not change or delete them.

See [manual installation](../../README.md#install) and
[v2 migration](../../docs/migration-v2.md).
