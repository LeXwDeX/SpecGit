# SpecGit

**Issue specifications → code changes → native PR/MR → verified completion.**

SpecGit gives coding agents a shared delivery workflow for GitHub and GitLab.
Issues hold the specification. A PR or MR gathers the selected Issues and the
implementation. SpecGit reads the forge's current state so the agent can repair
failures and distinguish pending work from completed delivery.

The [runtime architecture](docs/architecture.md) describes module ownership,
program checks and agent guidance.

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
specgit pr --ready --request 42 --dry-run --json
specgit pr --ready --request 42 --json
specgit watch --request 42 --session task-42 --goal lifecycle --json
# After platform review and merge, re-read the native request and Issues:
specgit pr --status --request 42 --json
```

Replace the example IDs with real Issues and the resulting request number.
Previews do not authorize later writes. A branch without pushed changes remains
pending; SpecGit does not create an empty delivery just to attach a PR.
Marking the request ready requires existing user authorization. Review and merge
happen on GitHub or GitLab; watch observes current evidence but does not perform
review, merge, or Issue closure. After merge, verify the native request and every
associated Issue with the explicit status read above.
For a read from another checkout, use `specgit pr --status --request <id>`; it
reports same-repository native state and a separate local-applicability result.
Implicit lookup and `watch` remain bound to the current worktree.

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

SpecGit 2.4 is permanently **project-only**: `specgit setup` writes owned
project entry points for the explicitly selected agents
(`--agent generic|claude|codex|opencode`, repeatable), and `--scope project` is
the default and only scope. It never copies the runtime binary into a project
and never installs global or host-level integration state; project hooks invoke
the one shared user-installed executable directly, so no global setup
prerequisite exists. The 2.3 global integration scope and its `--root`,
`--provider`, `--api-host`, `--register-*` and per-host root/settings options
are removed; `watch`, `hook` and `inbox` state is always Git-private. A custom
OpenCode fork can opt in to claude-code-format project hooks with the explicit
`--opencode-claude-hooks` choice (requires `--agent opencode`); official
OpenCode keeps the skill and guidance only.
`specgit init` stays unchanged and project-scoped — agent integration is
optional and separate. Setup preserves unrelated guidance, reports ownership
conflicts, and preserves manual edits and foreign hooks. Written registration
is reported separately from actual host discovery or event delivery; a reload, a
host trust review (Codex `/hooks`), or another turn may be needed to verify the
host. Coordinated removal of a whole
project's SpecGit integration is the separate `specgit remove` command (preview,
digest-bound apply, offline rollback), introduced in the 2.3 runtime contract;
project-scope `--uninstall` covers only the recorded agent assets.

Upgrading from 2.3 refreshes existing project receipts in place (the 2.4
receipt omits `shared_root`) without reading or writing the retired global
root. Existing 2.3 global data is preserved; 2.4 ships no global cleanup
command — back up first and use the 2.3 CLI's exact owned cleanup before
upgrading if that data must go, never a blind delete.

Codex and Claude PreToolUse hooks reject tracked edits in an initialized v2
project until the current repository and branch have a complete selected-Issue
checkpoint. `specgit guard --install` adds owned pre-commit and pre-push blocks
to the effective native/custom hook path, including Husky user scripts, and
`--uninstall` removes only those blocks. The installed pre-push block buffers
and replays Git's standard ref stdin for the existing user hook.

After CLI upgrades, use the [agent installation document](docs/agent-install.md)
again to verify the executable selected by PATH and refresh the existing project
and host integration. Existing settings are preserved unless a change is selected.

For a v1 project, follow the [v1 → v2 migration guide](docs/migration-v2.md) before
replacing its declaration or lifecycle workflows. `finish`, `accept`, `bind` and
the old acceptance controller are retired in the native v2 CLI. Binary installation
alone does not migrate a repository. Use the migration guide for a v1 project's
repository-specific cutover; retired v1 command workflows are no longer maintained.

## Documentation

- [Agent installation and initialization](docs/agent-install.md)
- [Supported coding agents and delivery flow](docs/supported-tools.md)
- [Manual installation](docs/installation.md)
- [Native commands, configuration and JSON contract](runtime/REFERENCE.md)
- [Migration from v1](docs/migration-v2.md)
- [Release procedure and recovery](runtime/distribution/README.md)
- [Runtime development](runtime/README.md)
- [Current glossary](CONTEXT.md)
- [English / 中文 Wiki](https://github.com/LeXwDeX/SpecGit/wiki)
- [Documentation audit and source inventory](docs/documentation-audit-2.2.1.md)

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
an explicit dispatch with a stable version. GitHub-hosted standard Linux/Windows x64
and macOS ARM64 runners compile and smoke-test the native binaries. The final job creates ZIPs and signs `SHA256SUMS`
using the main Release workflow identity. Publication verifies source identity, signature, SHA-256 and
uploaded bytes, and preserves existing immutable releases. Full source and
installed-binary regressions run in ordinary CI.

See [CI scope](docs/ci-scope.md) for current checks. The installed CLI help/schema
and [native command reference](runtime/REFERENCE.md) define current behavior;
dated design records preserve rationale rather than release status.
