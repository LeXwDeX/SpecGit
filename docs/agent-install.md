# Install and initialize SpecGit — agent instructions

Carry out the user's requested installation on their selected machine and Git
repository. This is a local setup task: it does not include implementing a feature,
creating an Issue/PR, committing, pushing, merging or publishing a release.
The user's existing instructions and authorization control any additional work.

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
existing `.specgit.yaml`. Preserve unrelated changes. Determine the provider and
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
Installing a binary is still distinct from completing that project migration.

**For a fresh or v2 project:** inspect capabilities, preview initialization, then
apply the same selected options. Run these in the target repository, replacing
`<provider>` with `github` or `gitlab`:

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
`--manual-observe` choice. The README installation prompt explicitly selects this
fallback: when that is the user's request, include `--manual-observe` in both the
preview and apply commands without asking again. Otherwise present that specific
choice unless it is already selected in the session. Do not weaken protections or administer the
forge to make initialization pass. An applicable preview with no conflicts is
sufficient to continue the user's authorized local setup without another generic
confirmation.

Read back `.specgit.yaml` and the managed project guidance after initialization.
Run `specgit status --json` and `specgit doctor --provider <provider> --json` and preserve their actual
reported state. Do not create a test Issue or PR to demonstrate installation.

## 4. Register the active agent

Select the host running this task; multiple installed host directories do not mean
the user wants all of them configured, and noninteractive operation never guesses
a host. Inspect `specgit setup --help` and preview the integration, passing the
host explicitly and repeatably through `--agent`:

| Active host | Setup selection |
| --- | --- |
| Codex | `--agent codex` |
| Claude Code | `--agent claude` |
| OpenCode (official build) | `--agent opencode` |
| OpenCode custom fork with claude-compatible hooks | `--agent opencode --opencode-claude-hooks` |
| Host that documents `.agents/skills` discovery | `--agent generic` |

For example, in Codex:

```sh
specgit setup --agent codex --dry-run --json
specgit setup --agent codex --json
```

SpecGit 2.4 is permanently project-only: `--scope project` is the default and
the only scope value. Setup writes documented checkout assets with a
worktree-private receipt, never copies the runtime binary into a project, and
never installs user-global host assets or state. Project hooks invoke the
currently installed shared user executable directly, so there is no global setup
prerequisite. The retired global integration scope and its selectors —
`--root`, `--provider`, `--api-host`, `--register-claude`,
`--register-codex`, `--register-opencode`, `--claude-settings`, `--codex-root`
and `--opencode-root` — are rejected input, not deprecated aliases. Preserve
foreign skills, hooks and instructions; ownership conflicts require
reconciliation, not overwriting. `watch`, `hook` and `inbox` always use
Git-private state; their retired `--state-root` option is rejected.

### Project agent integration

`specgit init` stays unchanged and project-scoped; agent integration is
optional and separate. Inside the actual target repository:

```sh
specgit setup --agent codex --dry-run --json
specgit setup --agent codex --json
```

Project scope resolves the Git checkout and private absolute Git directory,
writes only documented checkout assets (the canonical `.agents/skills` skill
plus each selected host's skill copy, guidance and hook files), and records its
receipt and journal under `<git_dir>/specgit-v2/agent-assets/`, so each linked
worktree integrates independently. The 2.4 receipt format omits `shared_root`.
A 2.3-era project receipt is refreshed, removed or recovered locally with
foreign content and manual edits preserved, and setup never reads or writes the
retired 2.3 global root. That global 2.3 data stays preserved: 2.4 ships no
global cleanup command. If it must be removed, back it up first and use the 2.3
CLI's exact owned cleanup before upgrading; never blind-delete.
Selection is additive: refresh preserves previously recorded agents and
explicit choices, and a new project integration fails unless at least one
`--agent` is selected. Project uninstall removes every recorded project asset
of the current worktree and must omit `--agent`; `--rollback` restores from the
project journal only:

```sh
specgit setup --uninstall --dry-run --json
specgit setup --uninstall --json
specgit setup --rollback <transaction>
```

`setup --uninstall` is deliberately narrow: it removes only this
worktree's recorded agent assets and keeps the declaration, guidance blocks,
guard hooks and local routing. Removing a whole project's SpecGit integration
is the separate `specgit remove` command, not part of `setup`. That command is
introduced in the 2.3 runtime contract; confirm `specgit remove --help` on the
installed executable before offering it. It previews first, applies only the
exact inspected preview digest, and rolls back a transaction offline:

```sh
specgit remove --dry-run --json
specgit remove --apply --expect <preview_sha256> --json
specgit remove --rollback <transaction>
```

Declaration and local-routing removal requires exact bytes and permissions
proven by a committed init or migration journal; an unowned or edited declaration, a tracked
`.specgit.yaml` (removal never changes the Git index), a pending transaction or
an unfinished delivery blocks the preview with listed conflicts and no writes.
An existing delivery checkpoint additionally requires the verified native
target merge with every selected Issue closed before any removal can proceed. Sibling initialized worktrees
keep shared exclude and hook blocks they still consume.

When Codex is selected, project hooks live in `<repo>/.codex/hooks.json`, and
Codex runs them only after the user reviews and trusts the project `.codex/`
layer in the host's `/hooks` menu. Setup reports
`codex_trust: review_in_host_required`; never mark that review as done, and do
not automate, bypass or assume host trust.

### OpenCode integration boundaries

The official OpenCode build receives the `.agents` skill and `AGENTS.md`
guidance only — no hooks. Only a custom OpenCode fork with claude-compatible
hook support can opt in through `--opencode-claude-hooks` (requires
`--agent opencode`): setup then generates project `.opencode/hooks.json` with
top-level event entries, one single-quoted command string
(`<executable> hook --event <event>`, no separate args entries) and
`inputFormat: claude-code`, without an asynchronous observer. Observe
pending events manually with bounded `specgit watch`. Verify actual
deny/allow/context behavior on the installed fork before relying on it. The
[observed custom-host behavior](supported-tools.md#observed-custom-host-behavior)
records working tool-event context and the SessionStart delivery gap in
`opencode run` on the qualified build; registration is not a compatibility guarantee.
The fork's
`/import-claude-hooks` command is an interactive LLM prompt that reads the
project's Claude settings and asks about each entry individually — it is not an
automatic read. Do not import hook entries that native setup already owns as
unmanaged duplicates.

For other hosts, report CLI/project setup separately and use the native reference
rather than inventing an unsupported registration flag.

Verify that the active host discovers the installed `specgit-native` entry point
and project guidance. If discovery requires a reload or next turn, report
registration as written but not yet verified and name that remaining action.
File existence alone does not prove host import, hook delivery or idle wake;
the setup report itself lists registration as `written_not_verified` and host
delivery facts as `not_checked`. After CLI upgrades, repeat the binary checks
and preview the existing project/host
refresh; do not replace their settings with fresh defaults.

## Completion report

Report the installed version, Release URL, binary path, verified ZIP and binary
SHA-256 values, and verified signer identity;
the target repository and actual init/status/doctor outcomes; the selected host
and whether its registration/discovery was verified; and any remaining concrete
blocker or user action. Include the backup location if a file was replaced.
Distinguish completed installation, project initialization and host integration.
A failed or unknown check remains failed or unknown.

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
