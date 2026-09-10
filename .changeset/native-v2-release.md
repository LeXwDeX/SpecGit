---
---

Release SpecGit 2.0.0 through the native distribution channel, replacing the
1.15.1 TypeScript package with a thin npm launcher and native packages for
macOS arm64, Linux x64 GNU, and Windows x64. The native CLI manages issue/PR
bindings and observations; platform-native operations and authorized Agents
handle delivery completion.

The 2.0.0 version is already set explicitly in Cargo and the generated native
package manifests. The root TypeScript workspace is private and retained for
engineering verification. This empty changeset records publication intent and
the channel migration without requesting another version bump. Do not run the
legacy Changesets version/publish workflow or advance the root to 3.0.0.
The existing 2.0.0 CHANGELOG entry remains the release summary.

Build and qualify the three-platform bundle from the accepted main commit,
then publish those exact bytes using the native release procedure documented
in `runtime/distribution/README.md`.
