# Install and initialize SpecGit — agent instructions

**CLI already installed?** Use the [project maintenance guide](agent-project-refresh.md)
and its English/Chinese copyable requests. It covers safe inspection, separate CLI
updates and project refresh without replaying this first-install procedure.

Carry out the user's requested installation on their selected machine and Git
repository. Installing and enabling SpecGit delegates the task-related workflow for this project
without repeated approval at each delivery step. Explicit task limits remain controlling;
a declaration or old receipt cannot expand task or publication scope. The user's current
request controls whether release publication is included.

Use the repository and active agent already identified in the session. If the
repository path or target machine is unknown, resolve that before initialization.
Reading this document from the SpecGit source repository does not make that source
checkout the user's target project.

## 1. Establish the installation target

Record the OS, native CPU architecture, target repository root, current `specgit`
executables on PATH, and the active agent host. On macOS, account for a translated
shell when selecting the native CPU. Supported Release assets are:

| System | Release asset | Installed filename |
| --- | --- | --- |
| macOS Apple Silicon | `specgit-<version>-darwin-arm64.zip` | `specgit` |
| Linux x64 with glibc | `specgit-<version>-linux-x64-gnu.zip` | `specgit` |
| Windows x64 | `specgit-<version>-win32-x64.zip` | `specgit.exe` |

Unsupported architectures and Linux musl do not have a matching binary. Report
that concrete gap; npm, a different architecture and unofficial mirrors are not
fallback distribution channels.

Use an existing user-owned bin directory on PATH. If none exists, use a user-local
directory such as `~/.local/bin` or `%USERPROFILE%\.local\bin`, add it to the user's
PATH without replacing existing entries, and retain the previous PATH setting.
Use this shared user-level binary for all repositories and worktrees; do not create
a project-local operational CLI copy. Preserve an existing executable before replacement. Do not uninstall an old npm
package, alter a system-owned executable or remove other PATH entries as a shortcut.

## 2. Download and verify one stable Release

The only publication repository is `LeXwDeX/SpecGit` on GitHub. Read its latest
stable Release, or the exact version selected by the user. With an authenticated
GitHub CLI, for example:

```sh
gh api repos/LeXwDeX/SpecGit/releases/latest
```

A public HTTPS/API read is also sufficient for public Release metadata and assets;
GitHub authentication is not required solely because the target project uses
GitLab. When access is unavailable, report it instead of falling back to npm.
Do not print, copy or request a token value.

Keep the returned tag, version and asset URLs from that same Release. Require a
non-draft, non-prerelease stable version and exactly one ZIP matching the machine,
plus `SHA256SUMS` and `SHA256SUMS.sigstore.json`. The ZIP version omits the tag's `v`
prefix. Download these three assets into a fresh temporary directory. Do not
resolve `latest` again between selecting and downloading. An older Release with
only bare executables lacks this signed-package contract; report that gap and stop.

Use Cosign 3.1.3 or a compatible newer version from the
[official installation guide](https://docs.sigstore.dev/cosign/system_config/installation/).
Verify the checksum manifest before trusting its hashes:

```sh
cosign verify-blob --bundle SHA256SUMS.sigstore.json --certificate-identity 'https://github.com/LeXwDeX/SpecGit/.github/workflows/release-prepare.yml@refs/heads/main' --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' SHA256SUMS
```

Require successful signature, certificate identity, issuer and transparency-log
verification. Do not disable verification or accept another workflow identity.
Match exactly one SHA-256 row for the selected ZIP in the verified manifest.
Compare it with `shasum -a 256`, `sha256sum` or PowerShell
`Get-FileHash -Algorithm SHA256`. If GitHub's asset digest is present it must agree.
Missing, mismatching or unverified evidence stops installation before extraction.

Extract the verified ZIP into a fresh directory using `unzip` or PowerShell
`Expand-Archive`. Require exactly the expected root-level `specgit` / `specgit.exe`
regular file. Copy it to the chosen bin directory, preserving an existing executable
first. On Unix give it executable permission. Compare the installed binary hash
with the extracted binary hash; the ZIP hash identifies the archive, not the binary.
Run the absolute installed path before testing the PATH-selected command:

```sh
specgit --human --version
specgit --help
specgit --schema
```

The version must match the selected Release. Read this installed executable's
`--help` and `--schema` for the available commands and options; do not apply v1
flags or remembered options. Confirm `command -v specgit` / `Get-Command specgit`
selects the verified file. Report an unresolved older shim or PATH conflict as
incomplete setup, even if the absolute-path smoke checks pass.

## 3. Initialize the selected repository

In the actual target repository, inspect its `AGENTS.md`, Git status, remotes and
existing `.specgit.yaml`. Classify it using the [maintenance guide](agent-project-refresh.md#3-classify-before-project-writes):
a missing declaration with private state is not fresh adoption. Restore the original
configuration; never delete receipts, private state or hooks to start over.
Preserve unrelated changes. Determine the provider and
intended remote from the repository, and use the native default target unless the
user has selected another branch. Do not infer `main` from this document.

Repository operations require Git and a usable authenticated `gh` (GitHub) or
`glab` (GitLab) session. A missing prerequisite can be installed within the existing
setup authorization; interactive account login belongs to the user. Help/version
success alone does not prove native API access.

**If the declaration is v1:** retain it and use the [migration guide](migration-v2.md).
A complete v2 declaration and a reviewed migration preview are required before
activation. Old workflow retirement, unknown ownership or missing native evidence
may block migration; report the exact result and keep the old integration intact.
After migration, run `specgit init` in every clone and worktree to install its
local declaration, common Skill and stable guidance entry points. Migration alone
does not create these per-checkout assets.

Before project writes, inspect the installed CLI's offline capability catalog.
It also works outside a Git project and does not initialize or modify one:

```sh
specgit setup --catalog --json
```

Use the installed `--help` and `--schema` alongside the catalog. The next section
covers how the Agent selects project integration from the actual host capabilities.

**For a fresh or v2 project:** inspect, preview and apply initialization with the
same selected options. Run these in the target repository, replacing `<provider>`
with `github` or `gitlab`:

```sh
specgit init --provider <provider> --check --json
specgit init --provider <provider> --dry-run --json
specgit init --provider <provider> --json
```

Include `--remote`, `--target`, `--language` or `--api-host` only when selected or
needed by the actual repository and supported by the installed schema. Existing
configuration is authoritative for a refresh. For fresh setup, leave automatic
merge/closure preferences at their defaults unless the user already chose them.

If native capabilities are unavailable, `init` may require an explicit
`--manual-observe` choice, which writes `agent.native_auto_merge=false`. The README
request permits that fallback for new/default-false or existing-false configuration.
If the selected setup requires a preference change, apply it within the installation
task delegation and use the same flag/configuration in check, preview and apply.
Preserve preferences when the task does not require a change, then read back the result. Do not weaken protections or administer the
forge to make initialization pass. An applicable preview with no conflicts is
sufficient to continue the delegated local setup without another confirmation.

Read back `.specgit.yaml` and the managed project guidance after initialization.
Run `specgit status --remote <remote> --json` and
`specgit doctor --offline --json` for local state. When native capability checks
are relevant and access is available, also run `doctor` with the repository's
provider and preserve the reported state. Do not create a test Issue or PR to
demonstrate installation.

## 4. Choose project integration by capability

Use `setup --catalog` and the active host's documentation to determine what this
Agent can discover, load, trust and invoke. The Agent chooses the useful
capabilities and any host-specific glue; SpecGit does not require a particular
host brand. Keep the installed CLI's `--help` and `--schema` as the command and
protocol contract. The catalog is offline and independent of project setup.

| Capability | Purpose and scope | Requirement and check |
| --- | --- | --- |
| Shared CLI and native tools | One user-level SpecGit executable shared by repositories and worktrees; authenticated `gh`/`glab` for forge work | SpecGit operations require the CLI; native Issue/PR operations also require access |
| SpecGit Skill | Canonical task workflow | Recommended project Skill at `.agents/skills/specgit-native/SKILL.md` |
| Static guidance | Stable entry into the Skill | Recommended `AGENTS.md` entry; may contain manual text and remain tracked |
| Dynamic context | Current task or checkpoint context | Optional; 2.13 delivers through SessionStart and PreToolUse where supported |
| Agent event hooks | Host protocol that loads guidance/context | Optional; inspect host discovery and trust requirements; 2.13 does not support PostToolUse, Stop or idle wake |
| Git guard | Native commit/push checkpoint enforcement, independent of the Agent process | Optional unless project policy requires it; verify actual guard behavior |
| Observation | Bounded `watch`/`inbox` and private event state | Optional; reads native forge state when requested, with no automatic host wake |
| Local project files | `.specgit.yaml`, generated Skill paths and Git `info/exclude` entries | Exclude only exact local paths; ignore rules never untrack files; mixed guidance may be tracked |
| Private receipts and checkpoints | Ownership, recovery and selected Issue state in Git-private metadata | Per checkout/worktree; shared Git hook blocks stay while active consumers need them |

Missing optional capability blocks only operations that depend on it. If policy
requires the Git guard, its absence blocks guard-dependent commit/push work; a
prompt or guidance text cannot substitute for enforcement or count as acceptance.
Offline catalog, `status` and `doctor --offline` support local inspection. Forge
state remains unknown until the relevant native read succeeds. Missing CLI
tooling is not a checkpoint exception; report a concrete CLI defect and use the
documented native recovery path when the selected workflow is blocked.

```sh
specgit status --json
specgit doctor --offline --json
```

For a new project, initialize the declaration in section 3 first. Then review and
apply setup's recommended shared Skill and stable guidance entry point. New setup
does not add Agent hooks. Existing setup choices are retained on refresh. The
legacy `--agent generic|claude|codex|opencode` selection remains available for
compatibility and existing host receipts; a compatible custom OpenCode can also
use `--opencode-claude-hooks`. These options are not required for the recommended
new-project flow. Review the complete preview before applying:

```sh
specgit setup --dry-run --json
specgit setup --json
```

Add Git guard independently when needed:

```sh
specgit guard --install --dry-run --json
specgit guard --install --json
```

Keep custom host settings and glue under a clear owner. The Agent must verify and
maintain custom glue; SpecGit manages only recorded SpecGit assets, and `doctor`
does not validate arbitrary host configuration. Verify each layer separately:
written files do not prove that the host loaded them, and loading does not prove
context delivery or enforcement. Follow host import/trust steps, read back the
Skill and guidance, verify actual context delivery, and verify allow/deny behavior
for Git guard only. Do not describe PreToolUse context delivery as an edit gate.
See the [maintenance guide](agent-project-refresh.md#5-review-the-full-host-refresh-scope)
for refreshing existing host choices and ownership.

## Project scope and removal

Setup remains project-only. It writes selected checkout assets and a worktree
receipt, never a project-local CLI or user-global host state. Linked worktrees
have independent project receipts; common Git hook blocks can have multiple
consumers. Preserve foreign content, manual guidance and unrelated hooks. Use
`--agent` or host-specific options only when maintaining a compatible existing
receipt or the installed catalog requires them.

`setup --uninstall` previews and removes only the current worktree's recorded
setup assets. Setup-owned Git guard blocks remain while an active setup or sibling
worktree consumes them; setup does not remove independently owned guard blocks.
The standalone guard commands manage independent guard ownership. Preview before
uninstalling:

```sh
specgit setup --uninstall --dry-run --json
specgit setup --uninstall --json
specgit guard --uninstall --dry-run --json
specgit guard --uninstall --json
```

An independently installed guard stays outside setup's uninstall scope. Shared
guard blocks remain while consumers need them; ownership or permission ambiguity
is a conflict to reconcile through the owning CLI transaction. Do not hand-edit
managed blocks or remove receipts to force cleanup.

Whole-project removal remains a separate operation. Use the installed CLI's
`remove --help`, preview the exact plan, then apply only that reviewed digest:

```sh
specgit remove --dry-run --json
specgit remove --apply --expect <preview_sha256> --json
specgit remove --rollback <transaction>
```

Declaration and local-routing removal requires exact bytes and permissions proven
by a committed init or migration journal; an unowned or edited declaration, a
tracked `.specgit.yaml`, a pending transaction or an unfinished delivery blocks
the preview. An existing delivery checkpoint also requires the verified native
target merge and every selected Issue closed. Sibling worktrees retain shared
exclude and hook blocks they still consume.

### Optional user Skill

Project integration remains project-only. The only user-level asset is the
explicitly installed Skill file; no global hooks, state or receipts.
Do not install it by default as part of this guide. Only when the user explicitly
chooses a shared Skill, preview and install:

```sh
specgit skill --user --dry-run --json
specgit skill --user --json
```

This writes only `~/.agents/skills/specgit-native/SKILL.md` (Windows uses
`%USERPROFILE%`). The embedded Skill ends with a SHA-256 managed marker. Foreign
files conflict; edited managed files are refreshed with a transactional backup
reported by the CLI. Symlink paths below home are refused.
`--remove` removes only managed, unedited content; preview it with `--dry-run`.
`--refresh-only` never creates or adopts a missing or foreign Skill.

After a successful `specgit update`, an already managed user Skill is refreshed
through the newly installed executable. No user Skill means no automatic install.
Refresh failure does not roll back the binary; inspect the update report and run
`specgit skill --user` to recover. Run `specgit init` in each checkout to
refresh its project Skill and stable guidance entry points. See the
[native reference](../runtime/REFERENCE.md#user-skill) for ownership and reports.

## Completion report

Report the installed version, Release URL, binary path, verified ZIP and binary
SHA-256 values, and verified signer identity;
the target repository and actual init/status/doctor outcomes; the selected host
and whether its registration/discovery was verified; and any remaining concrete
blocker or user action. Include the backup location if a file was replaced.
Distinguish completed installation, project initialization and host integration.
A failed or unknown check remains failed or unknown.

### Local generated files

`init` maintains one owned block in Git's local `info/exclude`, resolved by Git
and shared by linked worktrees. The block excludes only `.specgit.yaml` and the
generated `.agents/skills/specgit-native/SKILL.md`. Project guidance such as
`AGENTS.md` and `CLAUDE.md` can contain manual and generated sections and remain
eligible for tracking. It adds
`.claude/skills/specgit-native/SKILL.md` only when Claude is selected. A v1 migration
may carry forward legacy exclusion rules; run `init` afterward to reconcile current
local assets. Rules retained for another initialized worktree can keep a selected
Claude Skill excluded. The block does not hide `.agents/` or `.claude/` directories.
Repository or user ignore rules still apply; use `git check-ignore -v <path>` to
identify them and review their purpose before changing them. Repeated initialization
refreshes the block without duplicating it and preserves surrounding user rules.
Preview and rollback include this file; damaged markers require reconciliation.
`init --check` reports the block state (`absent`, `current`, `refresh` or
`damaged`) and already tracked files without writing. `init --rollback` and
`migrate --rollback` keep the shared file, and report it under `retained`, while
another linked worktree still has a declaration or SpecGit private state.

The JSON `local_exclusion` result reports exclusions and already tracked files.
Ignore rules never untrack a file. Review project guidance changes under the
repository's normal documentation policy; preserve manual content and owned
markers. Do not hide or untrack guidance merely because SpecGit generated part
of it. Untracking an already committed local declaration requires an explicit,
reviewed repository change. Committing `git rm --cached .specgit.yaml` deletes
the local declaration in every other clone or worktree that later fast-forwards,
pulls or switches across that commit. Back up `.specgit.yaml` in those checkouts
first; afterwards restore it and rerun `specgit init` there. A worktree whose
declaration is missing while its SpecGit private state (guidance receipt, routing
or checkpoint) remains is not treated as uninitialized: Git guard fails closed,
host hooks offer recovery context, and `init --check` reports its `private_state`
without claiming `initial_adoption`, and `remove` in a sibling still counts it as
a consumer of shared assets. Project `setup` writes documented checkout assets
and keeps its receipt under that worktree's Git directory; 2.4 has no global
setup assets.
