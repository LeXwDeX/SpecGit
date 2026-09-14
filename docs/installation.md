# Installation

GitHub Releases are the only supported distribution channel. Download from the
[latest stable Release](https://github.com/LeXwDeX/SpecGit/releases/latest).

| Platform | Download |
| --- | --- |
| macOS Apple Silicon | `specgit-darwin-arm64` |
| Linux x64 glibc | `specgit-linux-x64-gnu` |
| Windows x64 | `specgit-win32-x64.exe` |

Compare the SHA-256 with the Release description using `shasum -a 256 <file>` on
macOS, `sha256sum <file>` on Linux or `Get-FileHash <file> -Algorithm SHA256` in
PowerShell. Rename the executable to `specgit` (`specgit.exe` on Windows) and put
it in a directory on PATH. Run `chmod +x specgit` on macOS/Linux.

Installation does not require Node.js, npm or a Rust compiler. Git and an
already authenticated `gh` or `glab` session are required for repository work.
Unsupported platform binaries are not supplied by npm as a fallback.

```sh
specgit --human --version
specgit --help
specgit --schema
specgit status --json
specgit doctor --json
```

Help/schema checks are offline; they do not prove forge access. `doctor` probes
read-only native capabilities and authentication in the target repository.

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
