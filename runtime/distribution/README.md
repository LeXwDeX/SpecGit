# SpecGit 2.0 distribution and release recovery

GitHub Releases provides Actions-built native archives for manual installation.
npm provides `npm install -g specgit@2.0.0 --ignore-scripts` through the thin native
launcher. These channels are independent; GitHub-only publication does not read npm.

## Qualification

Dispatch [Release](../../.github/workflows/release-prepare.yml) with the exact
stable `release_version`. It runs macOS arm64, Linux x64 glibc and Windows x64 on
self-hosted runners. Actions has read-only repository permissions and does not
publish packages, tags or Releases. The coordinator uses its existing `gh` and npm
sessions for authorized publication; never read or copy credentials.

Each target runs formatting/lint, compiles the full native test inventory, runs
source and distribution regressions, builds a remapped release executable, packs
and installs its native package and wrapper offline with lifecycle scripts
disabled, then repeats the complete native test inventory through the installed
entrypoint. Windows includes console cancellation. Distribution regressions retain
raw output locally and identify failed repository test filenames and exit codes
in Actions output. All test files run even when one fails; the phase stays failed.

Assembly requires all three successful targets, exact source/version, complete
test accounting, matching installed executable/launcher hashes and tarball
integrity. No compile-only or source-only result qualifies a release.

The Actions artifact `specgit-release-<source SHA>` contains four npm `.tgz` files,
portable installed/profile evidence, `release.json` and `SHASUMS256.txt`.
Private runner paths are omitted. Native archives bundle license texts and the
standalone executable under `package/bin/`. The launcher has no lifecycle scripts;
its archived mode is `0644` on every host, while npm supplies executable shims.

## One command after approval

Merge the accepted changes, dispatch the final build on that exact `main`, and
download its successful artifact into a fresh directory. Keep these exact bytes.

```sh
node runtime/distribution/publish.mjs \
  --directory /absolute/current-main-bundle \
  --version 2.0.0 --source <current-main-sha> --build-run <successful-run-id> \
  --github --npm
```

Use `--github` alone for manual binary distribution, or `--npm` alone for npm.
With no channel flags, verification is offline and read-only. Add `--preflight`
to the channel command to verify local evidence, current main, exact successful
build provenance and (for npm) registry integrity without publishing anything.
Preflight does not prove that npm will permit a later publish.

GitHub receives only the three unchanged native archives, a native-only
`release.json` and its matching `SHASUMS256.txt`. The publisher creates a draft,
uploads missing assets, downloads and hashes all assets, then makes it stable and
latest and repeats readback. The npm wrapper and installer scripts are not GitHub
Release assets. Existing unexpected or conflicting assets stop recovery.

npm checks every existing exact version before writes, publishes missing platform
packages before the wrapper, then promotes and verifies `latest` with the wrapper
last. Registry integrity conflicts stop the command. Lost write responses stop;
the next explicit invocation reconciles before continuing. GitHub is published
before npm in a combined run, so an npm rejection may leave a completed GitHub
Release; resume the same command and bundle without replacing published bytes.

## Recovering the partially published 2.0.0 npm set

macOS/Linux 2.0.0 already exist from source
`6f011d218c99e45a2c605d8bec956c22bea327a2`, formal run `34592057943`.
The Windows name was blocked by npm; a support review was submitted. Do not rename
or retry to evade that block. Wait for support to clear it before actual npm writes.

The original qualified bundle is immutable. New main provenance changes package
metadata, so never substitute newly packed 2.0.0 bytes for these existing versions.
Use the explicit recovery options with the final current-main bundle:

```sh
node runtime/distribution/publish.mjs \
  --directory /absolute/current-main-bundle \
  --version 2.0.0 --source <current-main-sha> --build-run <successful-run-id> \
  --npm-directory /absolute/original-6f011d21-bundle \
  --npm-build-run 34592057943 \
  --github --npm
```

Recovery still requires fresh current-main three-platform qualification. It also
verifies the original successful main build, original installed profiles and
tarballs, ancestry, unchanged runtime/test/schema/launcher/license inputs, and
byte-identical executables and launcher in both bundles. It publishes the original
npm tarballs with their original source and uses current-main archives on GitHub.
Any mismatch requires a new version or investigation, not a relaxed gate. The JSON
result reports `source` and `npm_source` separately. Keep both bundles and their
run IDs; do not delete, repack or overwrite either during recovery.

Actual publication remains a separate authorized action. A successful preflight,
CI check or merge is not publication. Verify the final registry tags and installed
command from public npm after publication. Manual installation instructions are in
the [README](../../README.md#install); project cutover is in the
[migration guide](../../docs/migration-v2.md).
