# Installation

To have an agent install and initialize SpecGit, use the [agent guide](agent-install.md).

GitHub Releases are the only supported distribution channel. Download from the
[latest stable Release](https://github.com/LeXwDeX/SpecGit/releases/latest).

| Platform | Download |
| --- | --- |
| macOS Apple Silicon | `specgit-<version>-darwin-arm64.zip` |
| Linux x64 glibc | `specgit-<version>-linux-x64-gnu.zip` |
| Windows x64 | `specgit-<version>-win32-x64.zip` |

Use the version without the tag's `v` prefix. Download the matching ZIP,
`SHA256SUMS` and `SHA256SUMS.sigstore.json` from that same Release. Older Releases
with only bare executables do not meet this signed-package contract.

Install [Cosign](https://docs.sigstore.dev/cosign/system_config/installation/)
(3.1.3 or compatible newer), then verify the manifest:

```sh
cosign verify-blob --bundle SHA256SUMS.sigstore.json --certificate-identity 'https://github.com/LeXwDeX/SpecGit/.github/workflows/release-prepare.yml@refs/heads/main' --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' SHA256SUMS
```

After verification succeeds, calculate the ZIP's SHA-256 using
`shasum -a 256 <file.zip>` on macOS, `sha256sum <file.zip>` on Linux or
`Get-FileHash <file.zip> -Algorithm SHA256` in PowerShell. Compare it with the exact
filename's single row in the signed manifest. Stop on missing or mismatched
signatures or hashes; do not disable verification.

Extract with `unzip <file.zip> -d <fresh-directory>` or
`Expand-Archive -LiteralPath <file.zip> -DestinationPath <fresh-directory>`.
The ZIP contains `specgit` (`specgit.exe` on Windows). Back up any existing
installation and copy the executable into a user-owned directory on PATH.
Run `chmod +x specgit` on macOS/Linux. Confirm the installed executable hash equals
the extracted executable hash; it is different from the archive hash.

Installation does not require Node.js, npm or a Rust compiler. Git and an
already authenticated `gh` or `glab` session are required for repository work.
Unsupported platform binaries are not supplied by npm as a fallback.

```sh
specgit --human --version
specgit --help
specgit --schema
specgit status --json
specgit doctor --provider github --json
```

Help/schema checks are offline; they do not prove forge access. `doctor` probes
read-only native capabilities and authentication in the target repository. Use
`--provider gitlab` and the appropriate `--api-host` for GitLab.

## Upgrade and refresh

From 2.6 on, prefer the built-in update. It needs an authenticated `gh` session
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
The manual download, verification and replacement above remain the fallback,
for example for 2.5 and older executables or a directory you cannot write.

After CLI upgrades, verify the executable and its selected PATH first:
`command -v specgit` on Unix or `Get-Command specgit` in PowerShell. An older npm
shim can otherwise continue selecting the retired CLI. For a manual upgrade, back
up the previous executable before replacing it; restore that file to roll back
the local upgrade.

In a v2 project, inspect the current declaration and preview entry-point changes:

```sh
specgit init --check --json
specgit init --dry-run --json
specgit init --json
specgit setup --dry-run --json
specgit status --json
```

Apply project changes only after an applicable conflict-free preview. Resolve any
required manual-observation choice explicitly in both preview and apply.
Apply the intended `setup` selection from its help after reviewing the preview.
From 2.4 on, setup is permanently project-only (`--scope project` is the
default and only scope): refreshing a 2.3-era project receipt rewrites it into
the 2.4 format locally without `shared_root` and without reading or writing the
retired global root.
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

`init` and v2 migration maintain one owned block in Git's local `info/exclude`,
resolved by Git and shared by linked worktrees. Since 2.2 it excludes only
`.specgit.yaml`. SpecGit does not add exclusions for project `AGENTS.md` /
`CLAUDE.md`: one worktree cannot establish ownership of another worktree's guidance.
Repository or user ignore rules still apply; use `git check-ignore -v <path>` to
identify them and review their purpose before changing them. Repeated initialization
refreshes the block without duplicating it and preserves surrounding user rules.
Preview and rollback include this file; damaged markers require reconciliation.

The JSON `local_exclusion` result reports exclusions and already tracked files.
Ignore rules never untrack a file. Review project guidance changes under the
repository's normal documentation policy; preserve manual content and owned
markers. Do not hide or untrack guidance merely because SpecGit generated part
of it. Untracking an already committed local declaration requires an explicit,
reviewed repository change. Project `setup` writes documented checkout assets
and keeps its receipt under that worktree's Git directory; 2.4 has no global
setup assets.

## Removal and rollback

Use one shared user-level executable for operational work across repositories and
worktrees. Each participating project has its own initialization. Isolated test
installations used by maintainers do not replace that shared PATH entry.

SpecGit 2.3 introduces the `specgit remove` command for coordinated removal of
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
removes recorded Git-hook blocks.
SpecGit 2.4 is permanently project-only: `setup --uninstall` removes only the
current worktree's recorded project agent assets and never touches global or
host-level integration state. Existing 2.3 global data is preserved; 2.4 ships
no global cleanup command. If that data must be removed, back it up first and
use the 2.3 CLI's exact owned cleanup before upgrading — never a blind delete.
Preserve recovery records and foreign content.

A binary rollback restores the previously backed-up executable. It does not undo
project migration or host asset refreshes; assess those recorded transactions
separately. Follow reported ownership conflicts rather than deleting state to
force an uninstall or upgrade.
