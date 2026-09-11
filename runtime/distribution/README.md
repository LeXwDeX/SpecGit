# SpecGit 2.0 distribution and release recovery

Public `specgit@2.0.0` is a thin native launcher with three exact-version optional
dependencies: `specgit-darwin-arm64`, `specgit-linux-x64-gnu`, and `specgit-win32-x64`.
The repository root is a private development workspace; it retains TypeScript
engineering gates and old regressions but cannot publish the old runtime.

## Build and independently install

The [Release Action](../../.github/workflows/release-prepare.yml) is dispatched
explicitly with `release_version=2.0.0`. It runs the three targets on self-hosted
macOS arm64, Linux x64 and Windows x64 runners. It has read-only repository
permissions and performs no npm, tag, PR or GitHub Release writes. Ordinary pushes
do not start publication or create version PRs. Final dispatch is coordinated.

Each build runs source checks, builds a remapped release binary, stages its native
package plus the common wrapper, installs the packed bytes offline with lifecycle
scripts disabled, then repeats every enumerated native test executable through the
installed entrypoint. The Windows profile includes console cancellation. Source
and installed regression steps allow 30 minutes on the Windows VM and 15 minutes
on Linux/macOS. Native jobs allow 90 minutes on Windows and 45 minutes elsewhere;
the Windows TypeScript CI job allows 60 minutes. The aggregate job requires all three
successful jobs and verifies actual native/launcher hashes, exact source/version,
complete profile accounting, identical wrapper bytes, and tarball integrity.
Ordinary installed profiling checks the same approved executable inventory as
release assembly, including the zero-test `specgit-process-fixture` target. A
regression compares that inventory with Cargo's actual compiled test executables.

Local qualification uses the same scripts, from a clean committed source tree:

```sh
node runtime/distribution/stage.mjs --target aarch64-apple-darwin --output /tmp/new-stage
node runtime/distribution/verify-install.mjs --stage /tmp/new-stage --output /tmp/new-install
```

Output directories must be fresh. `--binary` accepts an already remapped binary;
the staging host still executes its offline schema, so cross-compilation alone is
not qualification. `stage.mjs` also checks ELF/Mach-O/PE architecture, known private
build paths, dependency licenses, and Linux's actual minimum glibc requirement.
The wrapper contains no lifecycle scripts and never downloads or compiles code.
It checks exact platform versions and binary digests before forwarding argv/I/O.
Unix signals reach the native child; Windows Ctrl-C is delivered by the attached
console rather than Node's forceful process-termination API.

The bundle artifact is `specgit-release-<source SHA>`. It contains four npm `.tgz`
files (three binaries plus one wrapper), `release.json`, `SHASUMS256.txt`, and
portable installation/profile evidence. Platform `.tgz` assets also contain the
standalone executable under `package/bin/`; direct execution does not require
Node.js. All necessary license texts are bundled. Evidence exported into the
bundle omits runner/home/Node paths. Package contents exclude Rust source and debug
sidecars. Paths are remapped and text uses LF to keep wrapper bytes identical.
The JavaScript launcher is archived with mode `0644` on every platform; npm's
bin installation makes the installed command executable. Native binaries retain
their platform executable permissions. A real pack/offline-install regression
checks both identical wrapper archives and the installed command.

## Publish the exact verified bytes

The user has authorized this stable v2.0.0 release. The coordinating task performs
the final writes after applicable acceptance. Actions does not receive an npm
token. The coordinator uses its existing authenticated npm and `gh` sessions;
`npm whoami` and package permissions are checks, not proof that new package creation
will succeed. Never read/copy tokens or mistake an OIDC dry run for publication.

1. Merge the accepted delivery into `main`, then dispatch the three-platform build
   for that exact main commit. Download its successful bundle without modifying it.
2. Re-read the run's repository, workflow, branch, commit and successful conclusion.
3. Publish with the native release script from this checkout:

```sh
node runtime/distribution/publish.mjs \
  --directory /absolute/downloaded-bundle \
  --version 2.0.0 --source <main-commit-sha> --build-run <actions-run-id> \
  --npm --github
```

The script verifies the run and current main identity, rereads every tarball and
its installed profile, and uses the existing npm session. Native packages publish
first under `v2-staging`. Each exact version/integrity must be visible before the
wrapper is published. Only a complete matching set can advance `latest`; the
wrapper's tag advances last and is read back. Private-source publication uses no
provenance claim. These operations never change source visibility.

GitHub tag/Release creation follows verified npm versions and latest tags. An
existing tag must resolve to the selected source. Existing Release assets are
read back and compared byte-for-byte; conflicting bytes are not overwritten.
The four package tarballs, source manifest and SHA-256 file are attached to the
stable `v2.0.0` Release. A successful local build is not a published version.

Without `--npm` or `--github`, the same command performs read-only bundle/registry
verification and reports missing versions. With only `--npm`, the coordinator can
finish and inspect npm publication before separately using `--github` on the same
bundle and build run.

## Recovery

A matching already-published package is reused. Different bytes at the same
immutable version stop the operation and require a new version. Lost write
responses stop; the next explicit run reads native state before issuing further
writes. Registry propagation waits are bounded. An incomplete set never advances
the wrapper's `latest`. Missing GitHub assets can be attached during recovery;
existing conflicting assets are never clobbered. Keep the same bundle and source
for recovery and keep `main` stable during this coordinated release.

The previous five-architecture staging plan is superseded by this release's three
actually tested targets. Linux arm64, Intel macOS and musl are not advertised as
supported v2.0.0 targets. The [v1 migration guide](../../docs/migration-v2.md) describes
project cutover separately from installation and publication.
