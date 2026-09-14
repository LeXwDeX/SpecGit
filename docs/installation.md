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

After CLI upgrades, verify the downloaded executable and its selected PATH first:
`command -v specgit` on Unix or `Get-Command specgit` in PowerShell. An older npm
shim can otherwise continue selecting the retired CLI. Back up the previous
executable before replacing it; restore that file to roll back the local upgrade.

In a v2 project, inspect the current declaration and preview entry-point changes:

```sh
specgit init --check --json
specgit setup --dry-run --json
specgit status --json
```

Apply the intended `setup` selection from its help after reviewing the preview.
Do not use v1 `init --force`, `finish` or npm installation instructions with v2.
For a v1 project, follow the [migration guide](migration-v2.md): prepare a complete
v2 declaration, inspect `specgit migrate --config-file <file> --json`, resolve old
writers without weakening native protections, then apply the exact reviewed digest.
Replacing a binary alone does not migrate project configuration.

See the [native command reference](../runtime/REFERENCE.md) and
[release procedure](../runtime/distribution/README.md). Old v1 documentation is
retained as historical engineering evidence, not as current setup guidance.

### Local generated files

`init` and v2 migration maintain one owned block in Git's local `info/exclude`
(resolved by Git, including linked worktrees). It excludes `.specgit.yaml` and
wholly generated `AGENTS.md` / `CLAUDE.md`. Repeated initialization refreshes
the block without duplication and preserves surrounding user rules. Preview
and rollback include this file. Damaged or duplicated markers require reconciliation.

The JSON `local_exclusion` result lists exclusions, mixed guidance and already
tracked generated files. Git ignore rules do not remove tracked files from the
index. Review and explicitly untrack whole generated files with `git rm --cached`
when authorized; keep local copies. Preserve manually maintained guidance and
omit generated hunks from commits. Global `setup` assets live under the selected
host/install roots, outside the project by default; do not commit them either.
