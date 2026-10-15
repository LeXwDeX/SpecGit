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
`--manual-observe` choice, which writes `agent.native_auto_merge=false`. The README
request permits that fallback for new/default-false or existing-false configuration.
If the selected setup requires a preference change, apply it within the installation
task delegation and use the same flag/configuration in check, preview and apply.
Preserve preferences when the task does not require a change, then read back the result. Do not weaken protections or administer the
forge to make initialization pass. An applicable preview with no conflicts is
sufficient to continue the delegated local setup without another confirmation.

Read back `.specgit.yaml` and the managed project guidance after initialization.
Run `specgit status --remote <remote> --json` and `specgit doctor --provider <provider> --remote <remote> --json` and preserve their actual
reported state. Do not create a test Issue or PR to demonstrate installation.

## 4. Select the active agent and review the full refresh scope

Select the host running this task; multiple installed host directories do not mean
the user wants new hosts added, and noninteractive operation never guesses
a host. Setup also refreshes every previously recorded host; `--agent` does not
confine its effects to that host. Inspect `specgit setup --help` and preview the integration, passing the
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

These calls omit purposes to preserve recorded modes on ordinary refresh. Explicit
purposes affect every recorded and newly selected host; keep them within current task scope. Review/report every affected host's assets.
Choose only supported SessionStart/PreToolUse hooks. SessionStart gives brief rules
and the Skill entry; PreToolUse provides relevant context or recovery. No PostToolUse,
Stop callback or idle wake is supported. `guard` configures native commit/push hooks.
`none` adds no purposes and preserves valid purposes and native Git guard.
Refresh still removes owned retired PostToolUse/Stop registrations.
It does not skip existing hosts' asset refresh. See the
[maintenance guide](agent-project-refresh.md#5-review-the-full-host-refresh-scope) for
capability checks, additive choices and selective-receipt downgrade limits.

Project integration remains project-only: `--scope project` is the default and
the only scope value. Setup writes documented checkout assets with a
worktree-private receipt, never copies the runtime binary into a project, and
never installs user-global host assets or state. Project hooks invoke the
currently installed shared user executable directly, so there is no global setup
prerequisite. The retired global integration scope and its selectors —
`--root`, `--provider`, `--api-host`, `--register-claude`,
`--register-codex`, `--register-opencode`, `--claude-settings`, `--codex-root`
and `--opencode-root` — are rejected input, not deprecated aliases. Preserve
foreign skills, hooks and instructions. Refresh replaces complete, proven-owned
assets and unique managed blocks, including edited body text; preserve outside
content, config, checkpoints and other hooks. Unknown ownership or damaged/duplicate
markers still require reconciliation. `watch`, `hook` and `inbox` always use
Git-private state; their retired `--state-root` option is rejected.

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

### Project agent integration

`specgit init` installs the common project Skill and stable guidance entry points
in each checkout; it does not install host hooks. Select the active host separately
with `specgit setup`. Stable entry points are in root `AGENTS.md` for generic and
official OpenCode, root `CLAUDE.md` for Claude, and root `AGENTS.md` or an existing
nonempty `AGENTS.override.md` for Codex. Each points to the canonical
`.agents/skills/specgit-native/SKILL.md`; Claude also gets
`.claude/skills/specgit-native/SKILL.md` for host discovery. Inside the actual
target repository:

```sh
specgit setup --agent codex --dry-run --json
specgit setup --agent codex --json
```

Project scope resolves the Git checkout and private absolute Git directory,
writes selected host assets and records the receipt at
`<git_dir>/specgit-v2/agent-assets/ownership.json`. New transaction journals are
stored under `<git_dir>/specgit-v2/assets/`; older journals in `agent-assets/`
serve only as migration evidence or for recovery. Each linked worktree integrates
independently. The 2.4 receipt format omits `shared_root`.
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
guidance. A custom OpenCode fork with claude-compatible
hook support can opt in through `--opencode-claude-hooks` (requires
`--agent opencode`): setup then generates project `.opencode/hooks.json` with
top-level event entries, one single-quoted command string
(`<executable> hook --event <event>`, no separate args entries) and
`inputFormat: claude-code`. Only SessionStart and PreToolUse are supported; do not configure PostToolUse, Stop
or idle wake. If observation cannot be delivered through allowed host events, use
bounded `specgit watch`/`inbox` or manual continuation. Verify actual behavior before
relying on registration.
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
File existence alone does not prove host import or hook delivery;
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

`init` maintains one owned block in Git's local `info/exclude`, resolved by Git
and shared by linked worktrees. The block excludes `.specgit.yaml` and the generated
`.agents/skills/specgit-native/SKILL.md`. It adds
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
