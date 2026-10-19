# Agent reference: release asset verification

The [agent installation guide](agent-install.md) is the operational procedure for
installing SpecGit through the coding agent. This page records the supported release
assets and signature/SHA-256 verification contract; it is not an end-user manual install path.

GitHub Releases are the only supported distribution channel. The latest stable
Release is listed at [GitHub Releases](https://github.com/LeXwDeX/SpecGit/releases/latest).

| Platform | Download |
| --- | --- |
| macOS Apple Silicon | `specgit-<version>-darwin-arm64.zip` |
| Linux x64 glibc | `specgit-<version>-linux-x64-gnu.zip` |
| Windows x64 | `specgit-<version>-win32-x64.zip` |

The agent selects the matching ZIP, `SHA256SUMS` and
`SHA256SUMS.sigstore.json` from one Release, using the version without its `v` tag.
Older Releases with only bare executables do not meet this signed-package contract.

The required manifest verification uses [Cosign](https://docs.sigstore.dev/cosign/system_config/installation/)
(3.1.3 or compatible newer):

```sh
cosign verify-blob --bundle SHA256SUMS.sigstore.json --certificate-identity 'https://github.com/LeXwDeX/SpecGit/.github/workflows/release-prepare.yml@refs/heads/main' --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' SHA256SUMS
```

After successful signature verification, the agent calculates the ZIP SHA-256 using
`shasum -a 256 <file.zip>` on macOS, `sha256sum <file.zip>` on Linux or
`Get-FileHash <file.zip> -Algorithm SHA256` in PowerShell. Compare it with the exact
filename's single row in the signed manifest. Stop on missing or mismatched
signatures or hashes; do not disable verification.

The archive contains `specgit` (`specgit.exe` on Windows). The agent preserves any
existing executable, installs the binary in a user-owned PATH directory, sets Unix
execute permission, and confirms the installed executable hash matches the extracted
binary hash. This hash differs from the ZIP archive hash.

Installation needs no Node.js, npm or Rust compiler. Git and an authenticated
`gh` or `glab` session are required for repository work. Unsupported platform
binaries are not supplied by npm as a fallback. The agent verifies the selected
executable with `--version`, `--help` and `--schema`; help/schema are offline and
do not prove forge access. `doctor` reads native capabilities and authentication.

## Upgrade and refresh

For an already installed CLI, the [project maintenance guide](agent-project-refresh.md)
is the canonical Agent procedure, with English/Chinese copyable requests. It
separates binary update from project refresh, classifies missing declarations and
legacy/conflicting assets, and preserves receipts, checkpoints and host choices.
Do not replay first installation or delete private state to repair a project.
Refresh updates recorded assets and complete unique managed blocks even
when their body text was edited; malformed/duplicate markers or unknown ownership
remain conflicts. Follow the maintenance guide's final status, doctor, readback and
dry-run checks after all updates.

Use the built-in update. It needs an authenticated `gh` session
and Cosign, and enforces the verification above:

```sh
specgit update --check --json
specgit update --dry-run --json
specgit update --json
```

`--check` only reads release metadata. `--dry-run` downloads and verifies the
release without replacement. The default replaces only the running executable,
keeps `specgit.backup-<previous-version>` beside it and reports that path; move
the backup back to roll back. Use `--version <x.y.z>` for an exact release,
including a deliberate downgrade. See [self-update](../runtime/REFERENCE.md#self-update).
For installed users, `specgit update` is the upgrade entry point; the agent guide
covers legacy executable cases and permissions that block an update.

After CLI upgrades, verify the executable and its selected PATH first:
`command -v specgit` on Unix or `Get-Command specgit` in PowerShell. An older npm
shim can otherwise continue selecting the retired CLI. The agent preserves the previous executable before any explicit replacement and
can restore that backup to roll back the local upgrade.

After installing or upgrading the shared CLI, use the [agent installation guide](agent-install.md#4-choose-project-integration-by-capability)
to discover host constraints and choose project integration. The catalog is
offline and does not require a Git project. Each clone and linked worktree still
has its own project assets and private receipt; the CLI binary is shared. The
following init commands apply to a new project; existing projects use the
maintenance flow described below.

```sh
specgit setup --catalog --json
specgit init --inspect --json
specgit init --dry-run --json
specgit init --json
specgit setup --dry-run --json
specgit setup --json
specgit status --json
specgit doctor --offline --json
```

For a new project, initialize its required declaration with `init` before setup.
Setup can write project agent assets without a declaration, but that alone does
not fully initialize the project. The new-project setup default recommends the
shared Skill and stable guidance entry point without installing agent hooks.
Selecting a new host with `--agent` adds its guidance and Skill only. Explicitly
pass `--hook-purpose guard` and/or `--hook-purpose context` to add hooks; omitting
purposes on refresh preserves existing choices. Use `--remove-hook-purpose guard`
or `--remove-hook-purpose context` to remove one recorded purpose while keeping
the rest. The selector affects `--agent` hosts, or all recorded hosts when omitted.
Existing projects follow the maintenance flow and refresh their recorded integration. Review each preview before applying. Add SessionStart or PreToolUse
context delivery only when supported by the installed CLI and host.
PostToolUse, Stop and idle-wake integration are unsupported. Preview Git guard
installation separately with `specgit guard --install --dry-run --json` when
needed by the project. If policy requires a Git guard, its absence blocks the
guard-dependent operation; prompts cannot substitute for it.

For provider checks when network and native access are available, for example:

```sh
specgit doctor --provider github --json
```

Read back the generated Skill and guidance, then repeat the same dry-run. Written
files do not prove host loading; use the documented host trust flow and verify
actual context delivery. Verify allow/deny behavior for Git guard only.
Setup is project-only (`--scope project` is the default and only scope). It
migrates consistent legacy receipts locally to v4 without reading or writing the
retired global root. V4 receipts require CLI 2.13 or newer; recovering version 3
transaction journals requires CLI 2.14 or newer. Check both formats before a
binary downgrade, which does not undo receipt, journal or asset changes.
Do not use v1 `init --force`, `finish` or npm installation instructions with v2.
For a v1 project, follow the [migration guide](migration-v2.md): prepare a complete
v2 declaration, inspect `specgit migrate --config-file <file> --json`, resolve old
writers without weakening native protections, then apply the exact reviewed digest.
Replacing a binary alone does not migrate project configuration.

See the [native command reference](../runtime/REFERENCE.md) and
[release procedure](../runtime/distribution/README.md). The v1 commands `finish`,
`accept`, `bind` and `unbind`, along with npm distribution, are retired. For an
existing v1 project, follow the migration guide above.

### Local generated files

`init` maintains one owned block in Git's local `info/exclude`, resolved by Git
and shared by linked worktrees. The block excludes only `.specgit.yaml` and the
generated `.agents/skills/specgit-native/SKILL.md`. Project guidance such as
`AGENTS.md` can contain both manual and generated sections and remains eligible
for tracking; receipts live in Git-private metadata. It adds
`.claude/skills/specgit-native/SKILL.md` only when Claude is selected. A v1 migration
may carry forward legacy exclusion rules; run `init` afterward to reconcile current
local assets. Rules retained for another initialized worktree can keep a selected
Claude Skill excluded. The block does not hide `.agents/` or `.claude/` directories.
Ignore rules do not untrack already committed files.
If a generated Skill is tracked, review an explicit `git rm --cached` change
before applying it: that commit removes the file in other clones that advance
past it, and each clone must run `specgit init` to regenerate local files.
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
and keeps its receipt under that worktree's Git directory. It installs no global
host assets.

## Removal and rollback

Use one shared user-level executable for operational work across repositories and
worktrees. Each participating project has its own initialization. Isolated test
installations used by maintainers do not replace that shared PATH entry.

Use `specgit remove` for coordinated removal of
one project's owned local integration: it previews by default (`--dry-run`),
`--apply --expect <preview_sha256>` applies exactly the inspected digest, and
`--rollback <transaction>` restores that transaction offline. Removal never
changes the Git index (a tracked `.specgit.yaml` blocks removal) and preserves
user edits, global assets, the shared executable and remote data; shared exclude
and hook blocks remain while sibling initialized worktrees still consume them,
and an unfinished native delivery blocks removal. Confirm
`specgit remove --help` on the installed executable before offering the command.

`init --rollback <transaction>` undoes only its recorded local transaction when
ownership still matches; it is not a full project uninstall. `guard --uninstall`
removes independently owned Git-hook blocks only when no active consumer needs
them; otherwise it retains the shared blocks and receipt. Setup-owned guard
blocks remain under setup ownership. `guard --install` in a worktree whose shared
hooks another worktree owns names that owner instead of changing the hooks.
`setup --uninstall` removes this
worktree's recorded project agent assets. `setup --remove-hook-purpose guard`
and `setup --remove-hook-purpose context` remove only the selected recorded
purpose, preserving the other purpose and unrelated host entries. Setup-owned guard blocks are retained
while an active setup or sibling worktree needs them, and independently owned
guard blocks remain outside setup's uninstall scope. When a setup owner retires,
remaining guard ownership and recovery evidence stay in shared Git metadata, so
pruning that worktree does not prevent the last setup consumer from cleaning up.
Any legacy global data remains outside the current CLI's cleanup scope. Preserve
its recovery records and foreign content; do not delete it as a project repair.

A binary rollback restores the previously backed-up executable. It does not undo
project migration or host asset refreshes; assess those recorded transactions
separately. Follow reported ownership conflicts rather than deleting state to
force an uninstall or upgrade.
