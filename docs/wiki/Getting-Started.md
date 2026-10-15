# Getting Started: Manual Installation and Project Initialization

The shared SpecGit executable, initialization of each project, and registration with a host such as Codex are separate steps. The first two steps are enough to use the CLI in a project.

**Already installed?** Open your Agent in the target repository and copy the
[English maintenance request](https://github.com/LeXwDeX/SpecGit/blob/main/docs/agent-project-refresh.md#english-request)
([中文请求](https://github.com/LeXwDeX/SpecGit/blob/main/docs/agent-project-refresh.md#中文请求)).
It asks the Agent to inspect and perform safe project maintenance, including fresh
adoption, rather than repeat installation or just suggest commands. Enabling SpecGit
delegates the current task workflow without repeated step approvals. The guide covers
stable CLI updates separately and preserves configuration, checkpoints and receipts. Missing declaration plus private state
is not a fresh project; restore the original configuration, never delete state.

## 1. Install the executable

The supported public distribution channel is [GitHub Releases](https://github.com/LeXwDeX/SpecGit/releases/latest). Follow the [installation guide](https://github.com/LeXwDeX/SpecGit/blob/main/docs/installation.md): download the platform ZIP, `SHA256SUMS`, and `SHA256SUMS.sigstore.json` from the **same stable Release**; verify the signer, check the ZIP SHA-256 against the signed manifest, then extract `specgit` (`specgit.exe` on Windows) into a user-owned PATH directory. Supported targets are macOS arm64, Linux x64 glibc, and Windows x64. Running a release executable requires no Node.js, npm, or Rust compiler.

To install **your own checked-out source** manually on macOS/Linux, build it locally. This is a development or commit-verification path, not a substitute for verifying a signed Release. Check the selected Git commit and worktree contents first:

```sh
cd /path/to/SpecGit/runtime
cargo build --locked --release --bin specgit

mkdir -p "$HOME/.local/bin"
# Back up an existing binary; the timestamp and -n preserve earlier backups.
if [ -f "$HOME/.local/bin/specgit" ]; then cp -np "$HOME/.local/bin/specgit" "$HOME/.local/bin/specgit.backup.$(date +%Y%m%d-%H%M%S)"; fi
install -m 755 target/release/specgit "$HOME/.local/bin/specgit"
cmp target/release/specgit "$HOME/.local/bin/specgit"
```

Building uses the Rust toolchain pinned in `runtime/rust-toolchain.toml`. For either installation method, check which command PATH selects. Resolve an older shim or competing `specgit` path before proceeding:

```sh
command -v specgit
specgit --human --version
specgit --help
specgit --schema
```

## 2. Initialize the target project

Go to the **target Git repository root** and inspect its worktree, remotes, and existing declaration. Repository operations need Git and authenticated `gh` (GitHub) or `glab` (GitLab); successful help output does not prove forge access.

```sh
cd /path/to/your-project
git status --short --branch
git remote -v
ls -la .specgit.yaml AGENTS.md CLAUDE.md 2>/dev/null
```

This example uses GitHub and a remote named `origin`. Inspect capabilities and preview the plan first. Run the final write command only after the preview is applicable and has no unresolved conflicts:

```sh
specgit init --provider github --remote origin --check --json
specgit init --provider github --remote origin --dry-run --json
specgit init --provider github --remote origin --json
```

`--check` inspects the project and native capabilities; `--dry-run` previews proposed writes. Neither initializes the project. With multiple Git remotes, use `--remote` to select the intended forge remote; omit it when a single remote is unambiguous. Do not assume the target branch is `main` from this example: let the command read the actual default branch, or pass `--target` when the project's selected target requires it. For GitLab use `--provider gitlab`; add `--api-host` when an actual self-hosted API requires it.

If native support is unknown or unavailable, manual observation is one operating
choice. `--manual-observe` writes `agent.native_auto_merge=false`. For new/default-false
or existing-false configuration, the copied request already selects it. Preserve configured preferences unless a specific change is required by the current
task. Use consistent options/configuration in check, preview and apply, then read back
the preference. Do not alter
platform settings under this maintenance request or ignore conflicts. Initialization
maintains `.specgit.yaml`, managed guidance and Git's local exclusion record; preserve
content outside managed blocks in `AGENTS.md` and `CLAUDE.md`.

Read back the configuration and status afterward:

```sh
cat .specgit.yaml
git status --short
specgit status --remote origin --json
specgit doctor --provider github --remote origin --json
```

For an existing **v2** project, retain its declaration and use the same inspect, preview, and apply sequence to refresh it; do not overwrite manual configuration. Migrate an existing **v1** project using the [explicit migration guide](https://github.com/LeXwDeX/SpecGit/blob/main/docs/migration-v2.md) first. Replacing the executable does not migrate a project. The old `init --force`, `finish`, and `bind` commands are retired.

## 3. Register a host only when needed

For hook selection and actual host verification, follow the
[maintenance guide](https://github.com/LeXwDeX/SpecGit/blob/main/docs/agent-project-refresh.md#5-review-the-full-host-refresh-scope).
Only SessionStart and PreToolUse are supported: SessionStart gives brief rules and
the Skill entry; PreToolUse provides relevant context or recovery. Do not configure
PostToolUse, Stop or idle wake. `guard` configures native Git commit/push hooks. If
automatic observation is unavailable through supported events, use bounded watch/inbox
or continue manually. Setup includes all recorded hosts plus the `--agent` selection;
review/report every host's effects, including shared Skill refresh.

Project initialization **does not register any host**. Only when you decide to integrate the active host should you separately inspect `specgit setup --help` and preview the relevant `--agent codex`, `--agent claude`, `--agent opencode`, or `--agent generic` selection. Since 2.4, setup is permanently project-only: `--scope project` is the default and the only scope value, assets live in the checkout with a worktree-private receipt, hooks invoke the installed shared executable directly (no global setup prerequisite), and the retired global options (`--root`, `--provider`, `--api-host`, `--register-*`, per-host roots) are rejected. Installing the executable and initializing a project does not require `setup`.

See [Upgrading Existing Projects](Upgrading-Existing-Projects), [Team Workflow](Team-Workflow), and [CLI Reference](CLI-Reference).
