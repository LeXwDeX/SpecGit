# Native npm distribution

`stage.mjs` builds the locked release executable and prepares `specgit` plus one
exact-version platform package. Linux glibc x64/arm64, macOS x64/arm64 and Windows
x64 have explicit package identities. Unknown architectures/libc fail before
execution. Linux packages record the actual linked glibc requirement from ELF
version metadata. Mach-O, ELF and PE machine headers must match the selected target.

```sh
node runtime/distribution/stage.mjs --target aarch64-apple-darwin --output /tmp/new-stage
node runtime/distribution/verify-install.mjs --stage /tmp/new-stage --output /tmp/new-install
```

Output directories must be new. `--binary` can stage an already remapped release
artifact; architecture and checksum inspection do not prove its version or runtime
compatibility. The target's actual installed verification remains mandatory.
The scripts never publish. The repository's TypeScript package remains its 1.x
publication surface during this staged rewrite.

The wrapper has no lifecycle scripts and never downloads binaries or compiles
source. npm's platform-specific optional dependencies carry precompiled bytes.
The wrapper checks its platform package's exact version and binary digest, then
spawns the native executable with inherited stdin/stdout/stderr and exact arguments.
Unix signals are forwarded; native INT/TERM/HUP cancellation reports JSON exit 130
after process cleanup. Windows console Ctrl-C reaches both attached processes,
so the wrapper lets the native handler finish instead of calling Node's forceful
Windows `kill(SIGINT)`. Windows process termination is not a POSIX signal emulation
or a guarantee of graceful JSON output.

`verify-install.mjs` packs both packages and verifies tarball integrity and the
asset allowlist, then installs them offline with scripts disabled. It exercises
version, invalid input, missing-executable diagnostics and hook stdin/stdout with
an empty PATH and empty credential variables. `installed.json` names the actual
entrypoints and digests. This local artifact check does not prove public-registry
availability. CI then runs the native public journeys against the installed npm
entrypoint. Tests about the exact native lease PID explicitly launch the installed
native file; cancellation through the wrapper has separate signal/console cases.

Release builds remap checkout/home paths, strip debug symbols, and reject known
private build paths in executable bytes. Packages contain only the executable,
launcher, manifest and license information, including selected dependencies'
license texts. Cross-compilation alone is never installed-platform evidence.

## Publication boundary and recovery requirements

`release-check.mjs --evidence <installed.json>` accepts five repeated evidence
arguments. It rereads each immutable tarball's manifest, native machine header,
binary digest and package integrity, requires one exact version and identical
wrapper bytes across builds, and refuses incomplete qualification. Add `--registry`
to read exact versions from the public npm registry with bounded response size and
timeouts. Its resumable state names missing platforms before the wrapper; missing,
unauthorized, malformed and changed-integrity observations are never success.
`can_promote_latest` requires all six registry artifacts to agree and a stable
version. This is a read-only packaging check, not forge acceptance or publication
authorization. It performs no publication, dist-tag mutation or Git tag mutation.

No 2.0 publication is authorized by this implementation. Before publication,
collect installed-bin evidence for all five declared platform packages, then verify
that every tarball's immutable version and integrity agree with the same wrapper.
Publish platform packages first under a staging tag. Read each exact version and
integrity back from the registry, retrying bounded propagation delays. A matching
already-published platform is reusable; a different integrity at the same version
requires a new version. Do not overwrite versions, publish a wrapper with missing
platforms, or move `latest` to a partial release. Wrapper publication and its final
registry readback precede release tags/metadata reconciliation; native merge method
or commit-message wording does not substitute for those observations.

The current owned-runner matrix contains Linux x64, macOS arm64 and Windows x64.
Linux arm64 and macOS x64 installed execution still require qualification. The
macOS runner currently has no working x64 execution translation. These targets
remain advertised design targets, not accepted release artifacts.

As verified on 2026-09-09, npm trusted publishing supports hosted providers and
explicitly excludes self-hosted runners. The configured owned-runner-only policy
therefore cannot establish the requested OIDC publishing path. Private source
must remain private, and private-repository publication must not claim provenance
that npm does not support. Resolving the actual publisher configuration requires
an authorized publishing arrangement; local packing is independent of it.

Sources: [npm platform metadata](https://docs.npmjs.com/files/package.json/),
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[Node subprocess signals](https://nodejs.org/api/child_process.html#subprocesskillsignal),
[Windows console events](https://learn.microsoft.com/en-us/windows/console/generateconsolectrlevent).
