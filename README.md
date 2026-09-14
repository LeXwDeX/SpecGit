# SpecGit

**Issue specifications → code changes → native PR/MR → verified completion.**

SpecGit gives coding agents a shared delivery workflow for GitHub and GitLab.
Issues hold the specification. A PR or MR gathers the selected Issues and the
implementation. SpecGit reads the forge's current state so the agent can repair
failures and distinguish pending work from completed delivery.

## Install

Open your coding agent in the repository you want to use with SpecGit, then paste:

```text
Read https://raw.githubusercontent.com/LeXwDeX/SpecGit/main/docs/agent-install.md
and carry out the installation and initialization described there for this machine
and the current repository. Install the latest stable SpecGit ZIP from GitHub
Releases, verify its signature and SHA-256, extract it, initialize the project with specgit init, and configure the
integration for the agent running this task. Use manual observation if native
capabilities cannot be verified, preserve existing settings, and do not enable new
merge or closure automation. Use the repository and agent context already available;
ask only for information that cannot be determined. Finish the
installation and verification, rather than only giving me commands to run.
If the document is inaccessible, retrieve it through my authenticated gh session
or report the access problem; do not guess its contents.
```

The [agent installation document](docs/agent-install.md) covers signatures, checksums,
PATH, existing installations, project initialization and agent registration.
It works with Codex, Claude Code and OpenCode through their supported integrations;
other agents can use the CLI and project guidance directly.

SpecGit is distributed **only through GitHub Releases** as native macOS arm64,
Linux x64 glibc and Windows x64 ZIP packages, accompanied by `SHA256SUMS` and its
Sigstore signature bundle. End-user installation needs no Node.js,
npm or Rust compiler. Repository work needs Git and an authenticated `gh` or `glab`.
For installation without an agent, see the [manual guide](docs/installation.md).

## How delivery works

| Stage | What happens |
| --- | --- |
| Specify | Create or select Issues with Why, Scope, Approach and Acceptance. |
| Implement | The agent changes code, runs the relevant checks, commits and pushes. |
| Propose | SpecGit creates or adopts a native PR/MR and preserves the Issue references. |
| Observe | SpecGit reports current checks and lifecycle state; the agent repairs failures. |
| Complete | The forge confirms the merge and associated Issue closures. |

One Issue represents one independently verifiable need. Several Issues can be
delivered in the same PR/MR. Work interrupted by a tool or network failure can be
resumed by reconciling the exact native objects and saved intent.

After initialization, a typical delivery uses existing Issue numbers:

```sh
git switch -c feat/selected-specs
specgit issue 21 22 --dry-run --json
specgit issue 21 22 --json

# Implement, verify, commit and push the actual changes.
specgit pr --title 'feat: implement selected specs' --body-file request.md --dry-run --json
specgit pr --title 'feat: implement selected specs' --body-file request.md --json
specgit pr --status --json
specgit watch --request 42 --session task-42 --goal lifecycle --json
```

Replace the example IDs with real Issues and the resulting request number.
Previews do not authorize later writes. A branch without pushed changes remains
pending; SpecGit does not create an empty delivery just to attach a PR.

## Responsibilities and evidence

The agent implements and repairs. GitHub or GitLab owns checks, review rules,
merge and ordinary Issue closure. SpecGit's Rust core, watch and hooks cannot
merge requests, close Issues, delete branches or administer repository settings.
An authorized agent can use the native `gh` / `glab` operations for those actions.

A successful read can report failed CI. Exit zero means the requested operation
succeeded; it does not mean a delivery is accepted or merged. Missing evidence
stays unknown. A merged request with open or uncertain Issues is not complete.
Auto-merge preferences do not grant permission to change native protections.

## Agent integration and upgrades

`specgit setup` installs owned entry points for the selected host. It preserves
unrelated guidance and reports ownership conflicts. Written registration is
reported separately from actual host discovery or event delivery; a reload or
another turn may be needed to verify the host.

After CLI upgrades, use the [agent installation document](docs/agent-install.md)
again to verify the executable selected by PATH and refresh the existing project
and host integration. Existing settings are preserved unless a change is selected.

For a v1 project, follow the [v1 → v2 migration guide](docs/migration-v2.md) before
replacing its declaration or lifecycle workflows. `finish`, `accept`, `bind` and
the old acceptance controller are retired in the native v2 CLI. Binary installation
alone does not migrate a repository. The [v1 guide](docs/legacy/v1-readme.md) remains
available as historical engineering evidence.

## Documentation

- [Agent installation and initialization](docs/agent-install.md)
- [Manual installation](docs/installation.md)
- [Native commands, configuration and JSON contract](runtime/REFERENCE.md)
- [Migration from v1](docs/migration-v2.md)
- [Release procedure and recovery](runtime/distribution/README.md)
- [Runtime development](runtime/README.md)

## Development and releases

The runtime lives in `runtime/`; its pinned Rust toolchain builds the executable.
The v1 TypeScript implementation and its test/build workflows are retired.
The private root Node workspace contains only repository verification tooling.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
node scripts/ci-metadata-check.mjs
cd runtime
cargo fmt --all --check
cargo clippy --locked --all-targets --features test-fixtures -- -D warnings
cargo test --locked --all-targets --features test-fixtures
```

The [Release workflow](.github/workflows/release-prepare.yml) runs from `main` after
an explicit dispatch with a stable version. Three self-hosted runners compile and
smoke-test the native binaries. The final job creates ZIPs and signs `SHA256SUMS`
using the main Release workflow identity. Publication verifies source identity, signature, SHA-256 and
uploaded bytes, and preserves existing immutable releases. Full source and
installed-binary regressions run in ordinary CI.

See [CI scope](docs/ci-scope.md) for current checks. Historical v1 documents are
reference material, not executable workflows or supported commands.
