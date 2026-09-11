# SpecGit 2.0 distribution and release recovery

GitHub Releases is the only publication channel. The shell and PowerShell
installers download verified standalone native executables; Node.js and npm are
not needed on the installation host. The qualified `.tgz` format and thin launcher
remain in the build for offline regression compatibility. Existing npm versions
are historical and are not updated by this workflow.

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
and installed regression steps allow 60 minutes on the Windows VM and 15 minutes
on Linux/macOS. Native jobs allow 60 minutes on Windows and 45 minutes elsewhere;
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
files (three binaries plus one wrapper), `install.sh`, `install.ps1`, `release.json`,
`SHASUMS256.txt`, and portable installation/profile evidence. Platform `.tgz` assets also contain the
standalone executable under `package/bin/`; direct execution does not require
Node.js. All necessary license texts are bundled. Evidence exported into the
bundle omits runner/home/Node paths. Package contents exclude Rust source and debug
sidecars. Paths are remapped and text uses LF to keep wrapper bytes identical.
The JavaScript launcher is archived with mode `0644` on every platform; npm's
bin installation makes the installed command executable. Native binaries retain
their platform executable permissions. A real pack/offline-install regression
checks both identical wrapper archives and the installed command.

## Publish the exact verified bytes

The coordinator performs final writes through its existing authenticated `gh`
session after applicable acceptance. Actions builds and verifies; it does not
publish. Never read or copy credentials.

1. Merge the accepted delivery into `main`, then dispatch the three-platform build
   for that exact main commit. Download its successful bundle without modifying it.
2. Re-read the run's repository, workflow, branch, commit and successful conclusion.
3. Publish with the native release script from this checkout:

```sh
node runtime/distribution/publish.mjs \
  --directory /absolute/downloaded-bundle \
  --version 2.0.0 --source <main-commit-sha> --build-run <actions-run-id> \
  --github
```

The script verifies current main and the successful build, all installed profiles,
all tarballs, both installer scripts and SHA-256 checksums. It creates a draft,
uploads the four tarballs, `install.sh`, `install.ps1`, `release.json` and
`SHASUMS256.txt`, downloads and verifies every asset, then publishes a stable latest
Release and reads it back. No npm lookup, publication or dist-tag promotion is
required. The retired `--npm` option fails before publication.

Without `--github`, the command verifies only the local bundle and performs no
network access. The [installation instructions](../../README.md#install) describe
script downloads, version pinning, custom directories and manual extraction.

## Recovery

An existing tag must resolve to the selected source. Matching assets are reused;
conflicting bytes are never overwritten. A lost write response stops the command;
the next explicit run reads native state before continuing. Incomplete drafts
remain recoverable and cannot be reported as a completed release. Keep the exact
bundle/source for recovery and keep `main` stable during coordinated publication.

Do not delete or republish historical npm versions as part of release recovery.
Deprecation or removal is a separate owner-selected maintenance action.

The previous five-architecture staging plan is superseded by this release's three
actually tested targets. Linux arm64, Intel macOS and musl are not advertised as
supported v2.0.0 targets. The [v1 migration guide](../../docs/migration-v2.md) describes
project cutover separately from installation and publication.
