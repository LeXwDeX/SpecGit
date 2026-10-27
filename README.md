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
and follow it to install or update the shared native CLI on this machine, then
initialize this repository. Use the latest stable signed GitHub Release and verify
its signature and SHA-256. In this project, `setup` installs the shared Skill and
guidance baseline without host hooks; add `--hook-purpose guard` or `context` only
when the active host supports that integration and the task needs it. When native
capability is unsupported or unknown and an operating choice is required, use manual
observation; it records `native_auto_merge=false`. Preserve an explicit true preference
unless the current task delegates a necessary change.
Installation and enablement delegate
the SpecGit workflow required for this project and task; carry it through without asking
again at each step. Use repository and agent context already available; ask only when
a task decision or real blocker requires user input. Finish the
installation and verification, rather than only giving me commands to run.
If the document is inaccessible, retrieve it through my authenticated gh session
or report the access problem; do not guess its contents.
```

SpecGit is installed through the coding agent, which reads the [agent installation
guide](docs/agent-install.md), verifies the signed release and selects project
capabilities. The guide covers signatures, checksums, PATH, existing installations,
project initialization and host registration.
It works with Codex, Claude Code and OpenCode through their supported integrations;
other agents can use the CLI and project guidance directly.

SpecGit is distributed **only through GitHub Releases** as native macOS arm64,
Linux x64 glibc and Windows x64 ZIP packages, accompanied by `SHA256SUMS` and its
Sigstore signature bundle. End-user installation needs no Node.js,
npm or Rust compiler. Repository work needs Git and an authenticated `gh` or `glab`.
`specgit update` upgrades the shared executable from GitHub Releases with signature
and checksum verification and keeps a backup. One user-level executable serves all
repositories and worktrees; initialize each clone or worktree separately.

## Already installed? Inspect and refresh your project

Use the [project maintenance guide](docs/agent-project-refresh.md), not the first-install
procedure. Open your Agent in the target repository and copy its
[English request](docs/agent-project-refresh.md#english-request) or
[中文请求](docs/agent-project-refresh.md#中文请求). The request asks the Agent to
actually inspect and apply safe local maintenance, with a separate verified stable
CLI update when needed. It preserves project settings and checkpoints. When native
capability is unsupported or unknown and an operating choice is required,
`--manual-observe` records `native_auto_merge=false`. Preserve an explicit true
preference unless the current task delegates a necessary change. Setup refreshes all recorded hosts and any named `--agent`
host, but explicit purpose changes apply only to the named host or hosts; without
`--agent`, they apply to all recorded hosts. Omit purposes on ordinary refresh to
preserve recorded choices. A newly named host gets guidance and Skill only. Hooks
require explicit `--hook-purpose guard` and/or `context`; `none` adds no hooks.
Enablement delegates task-related Issue, implementation, verification, commit/push,
PR/MR, review, merge and closure work. Publication is included only when the task
itself includes release work. A declaration or old receipt cannot expand task scope.
Use `--remove-hook-purpose guard` or `--remove-hook-purpose context` to remove one
recorded purpose while keeping the other; omitting `--agent` targets all recorded
hosts. `setup --uninstall` removes this worktree's recorded project integrations.

## How delivery works

| Stage | What happens |
| --- | --- |
| Specify | Put larger goals in a Milestone; create/select complete Issues for independently verifiable outcomes. |
| Implement | The agent changes code, runs the relevant checks, commits and pushes. |
| Propose | SpecGit creates or adopts a native PR/MR and preserves the Issue references. |
| Observe | SpecGit reports current checks and lifecycle state; the agent repairs failures. |
| Complete | The forge confirms the merge and associated Issue closures. |

One Issue represents one independently verifiable need. Split larger goals by outcome
and dependency, not implementation step. TDD and PR Actions/CI follow-up are strongly
recommended; project and platform requirements still govern. Work interrupted by a tool or network failure can be
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
Previews do not authorize later writes by themselves; task enablement delegates the
required workflow within its scope. A branch without pushed changes remains pending;
SpecGit does not create an empty delivery just to attach a PR. Marking ready, review
and merge happen within that delegation on GitHub or GitLab; watch observes current evidence but does not perform
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

The native CLI is installed once in a user-owned PATH directory and shared by
repositories and worktrees. Run `specgit init` in every clone and worktree to
maintain its project declaration, Skill, guidance entry and local records. On a
new project's main worktree with hooks in the Git directory, init also installs the
native Git guard: every commit needs a selected
Issue, and pushed commits carry an `Issue: #N` trailer. Init does not install host
hooks. `specgit setup` is project-only and installs or
refreshes the shared project Skill and guidance baseline; it never copies the CLI
into a project or scans other repositories. A new `--agent` selection adds that
host's guidance and Skill only. Hooks require explicit `--hook-purpose guard` or
`context`. Omitted purposes preserve recorded choices; explicit purposes apply to
the named host or hosts, or to every recorded host when `--agent` is omitted.
`observe` is recognized but declined; use bounded `watch`/`inbox` instead. Only
SessionStart and PreToolUse context hooks are supported. PostToolUse, Stop and idle
wake are retired. A custom
OpenCode fork can opt in to claude-code-format project hooks with the explicit
`--opencode-claude-hooks` choice (requires `--agent opencode`); official
OpenCode keeps the skill and guidance only. Refresh migrates recorded, uniquely
owned legacy guidance blocks; unknown ownership or damaged/duplicate markers
remain conflicts. Manual text outside managed blocks is preserved. Registration
is reported separately from actual host discovery or event delivery; a reload,
a host trust review (Codex `/hooks`), or another turn may be needed to verify the
host. Use `specgit remove` to preview and reversibly remove the whole project's
proven owned integration; `setup --uninstall` removes only recorded agent assets.

The only user-level asset is the explicitly installed Skill file; no global
hooks, state or receipts. To opt in, preview `specgit skill --user --dry-run --json`,
then run `specgit skill --user --json`. It owns only
`~/.agents/skills/specgit-native/SKILL.md` (Windows uses `%USERPROFILE%`) with a
transaction backup for recovery. `--remove` keeps user edits and
foreign files; `--refresh-only` skips missing or foreign files. After a successful
`update`, the new executable refreshes an already managed user Skill, never
installs one by default. Refresh failure retains the binary and reports the
remedy `specgit skill --user`. Project Skill refresh remains separate.

Host integration uses SessionStart for brief rules and the Skill entry, and
PreToolUse for relevant context or recovery. It does not gate ordinary edits.
`specgit guard --install` adds owned pre-commit and pre-push blocks
to the effective native/custom hook path, including Husky user scripts, and
`--uninstall` removes only those blocks. The installed pre-push block buffers
and replays Git's standard ref stdin for the existing user hook.

After CLI upgrades, use the [project maintenance guide](docs/agent-project-refresh.md)
to verify the executable selected by PATH and refresh each project integration.
Omit hook purposes to preserve recorded modes; review all hosts whose assets will
refresh. Only SessionStart and PreToolUse are supported; `observe` is declined and
bounded `watch`/`inbox` is the fallback. The current runtime is 2.17.1. After project updates, run status and doctor, read back
the generated Skill/guidance, then repeat dry-runs to check convergence.

For a v1 project, follow the [v1 → v2 migration guide](docs/migration-v2.md) before
replacing its declaration or lifecycle workflows. `finish`, `accept`, `bind` and
the old acceptance controller are retired in the native v2 CLI. Binary installation
alone does not migrate a repository. Use the migration guide for a v1 project's
repository-specific cutover; retired v1 command workflows are no longer maintained.

## Documentation

- [Agent installation and initialization](docs/agent-install.md)
- [Installed-CLI project maintenance — English / 中文 Agent requests](docs/agent-project-refresh.md)
- [Supported coding agents and delivery flow](docs/supported-tools.md)
- [Release asset verification reference](docs/installation.md)
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
