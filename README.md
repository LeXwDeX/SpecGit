# SpecGit 2.0

SpecGit manages Issue specifications, gathers several Issues into one GitHub PR or
GitLab MR, and reports native state to the Agent. The Agent implements and repairs;
the forge owns checks, review rules, merge and ordinary Issue closure.

The Rust core, watch and hooks cannot merge requests, close Issues, delete branches
or change repository settings. An authorized Agent uses `gh` or `glab` for native
auto-merge registration or optional supplementary closure. Configuration and hook
messages do not grant new permission.

## Install

Supported targets are macOS Apple Silicon, Linux x64 with glibc, and Windows x64.
GitHub Releases and npm are independent distribution channels. A GitHub release
does not imply the corresponding npm version is already available.

### npm

After the requested version is available on npm, use Node.js 20.19 or newer:

```sh
npm install -g specgit@2.0.0 --ignore-scripts
specgit --human --version
```

The thin launcher selects the native package for your operating system. No Rust
compiler or installation lifecycle script is required. Until npm publication of
2.0.0 completes, the registry's `latest` tag may still select version 1.x.

### Manual GitHub installation

Download the matching `.tgz` and `SHASUMS256.txt` from the
[GitHub Release](https://github.com/LeXwDeX/SpecGit/releases). These are the native
archives produced and verified by our Actions runners; no installer or npm wrapper
is included as a separate Release asset.

| Platform | Archive |
| --- | --- |
| macOS Apple Silicon | `specgit-darwin-arm64-2.0.0.tgz` |
| Linux x64 glibc | `specgit-linux-x64-gnu-2.0.0.tgz` |
| Windows x64 | `specgit-win32-x64-2.0.0.tgz` |

Calculate the archive's SHA-256 (`shasum -a 256 <archive>` on macOS,
`sha256sum <archive>` on Linux, or `Get-FileHash <archive> -Algorithm SHA256`
in PowerShell) and compare the full hash with its exact entry in the checksum file.
Then extract the archive with `tar -xzf <archive>`. Place `package/bin/specgit`
(`package/bin/specgit.exe` on Windows) in a directory on PATH and keep the bundled
license texts. On macOS/Linux preserve the executable permission, or use
`chmod +x specgit`. Run `specgit --human --version` to confirm the installed version.
Manual installation needs neither Node.js nor npm nor a Rust compiler. Check PATH
if an older npm installation is selected instead.

## Start a delivery

Use your existing authenticated `gh` or `glab` session. Native API access must work;
`--help` and `--version` alone do not establish authentication or permissions.

```sh
git switch -c feat/selected-specs
specgit init --provider github --check --json
specgit init --provider github --manual-observe --dry-run --json
specgit init --provider github --manual-observe --json
specgit issue 21 22 --dry-run --json
specgit issue 21 22 --json
```

Create the feature branch before init writes project configuration. Without an
explicit branch choice, Issue selection does not create one.

Check duplicates and keep each Issue's Why, Scope, Approach and Acceptance complete.
Commit and push actual changes, then prepare the PR/MR with its selected references:

```sh
specgit pr --title 'feat: implement selected specs' --body-file request.md --dry-run --json
specgit pr --title 'feat: implement selected specs' --body-file request.md --json
specgit pr --status --json
specgit watch --request 42 --session task-42 --goal lifecycle --json
```

A branch without pushed changes remains pending instead of creating a binding-only
commit. Unknown write outcomes retain a recovery intent; retries reconcile exact
native objects and stop on ambiguity. Issue/PR previews do not write business state.
Missing labels require an explicit `--create-labels` choice.

Native auto-merge support, target rules, registration and merge state are separate
facts. When a capability cannot be proven, `init` reports it and requires an
explicit manual-observation choice. A successful observation of failed CI exits
zero because the read succeeded; it is not merge permission. An unknown read stays
unknown. Merged requests with open or uncertain Issues are not reported completed.

## Integrate and migrate

[Command reference](runtime/REFERENCE.md) covers the actual machine interface,
configuration, `setup`, watch/inbox and host framing. A written integration file is
not proof that a host imported it or delivered a message; next-turn delivery and
idle wake capability are reported separately.

After installing the package, register the hosts you use:

```sh
specgit setup --provider github --register-codex --register-opencode --dry-run --json
specgit setup --provider github --register-codex --register-opencode --json
```

Select `--provider gitlab --api-host <host>` for GitLab. Each host flag is optional;
omit the host you do not use. The command installs `specgit-native` and a managed
global `AGENTS.md` block, preserving unrelated instructions. Codex uses
`CODEX_HOME` or `~/.codex` (and an existing nonempty `AGENTS.override.md`);
OpenCode uses `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`. Explicit
`--codex-root` and `--opencode-root` select alternative configuration directories.
Restart or reload the host to discover its new guidance. Registration reports
`written_not_verified` until actual host import is checked; it does not install
unverified event hooks. Existing unowned skills or edited managed blocks produce
an ownership conflict instead of being overwritten.

After CLI upgrades, inspect `specgit setup --provider github --dry-run` and
`specgit init --dry-run --json`, apply the chosen refresh, and verify the installed
project and host state.

Follow the [v1 → v2 migration guide](docs/migration-v2.md) before replacing an old
project declaration or lifecycle workflow. `finish`, `accept`, `merge`, promotion
and the old acceptance-controller contract are retired in the public v2 CLI.
Native protections remain on the forge. The [historical v1 guide](docs/legacy/v1-readme.md)
is retained for old installations and engineering evidence.

## Development and releases

The root `package.json` is a **private development workspace**. TypeScript sources,
`bin/specgit.js` and their tests remain available for this repository's existing
engineering gates and historical regression coverage; they are not the public v2
npm runtime. Root `npm publish` is refused. Public packages are generated by
`runtime/distribution/stage.mjs` from the committed Rust source.

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm test
cargo test --manifest-path runtime/Cargo.toml --locked --features test-fixtures
```

The [Release Action](.github/workflows/release-prepare.yml) compiles and independently
installs macOS arm64, Linux x64 and Windows x64 on self-hosted runners, repeats the
native journeys through each installed entrypoint, then assembles the package set
and checksums. It does not publish. The coordinator publishes those exact bytes
through the existing authenticated `gh` session and reads back the stable tag
and every Release asset. npm is no longer a publication target.
See [distribution and recovery](runtime/distribution/README.md) and the retained
[engineering release gates](docs/release-gates.md).

The [lightweight design](docs/design/specgit-2-rust-design.md) and
[history dispositions](docs/design/specgit-2-rust-history.md) explain ownership and
retained requirements. CLI reference suggestions are optional; implemented features
are verified on their real interfaces.

The retained Nix target is explicitly named `legacy-engineering` (`nix run .#legacy-engineering`). It builds the old TypeScript engineering CLI. Nix has no default v2 package; install native v2 through the GitHub Release scripts or platform archives above.
