# Getting Started

Follow the [installation guide](https://github.com/LeXwDeX/SpecGit/blob/main/docs/installation.md) to download one stable Release's native ZIP, SHA256SUMS and signature. Verify the signer and ZIP hash before installing on the shared user PATH. Supported targets are macOS arm64, Linux x64 glibc and Windows x64. No Node.js, npm or Rust is needed at runtime; repository work requires Git and authenticated gh/glab.

Run this GitHub example in the target repository; use `--provider gitlab` for GitLab and the actual `--api-host` when needed. Migrate v1 projects first.

```sh
specgit --human --version
specgit --help
specgit --schema
specgit init --provider github --check --json
specgit init --provider github --dry-run --json
specgit init --provider github --json
specgit status --json
specgit doctor --provider github --json
```

`--check` and `--dry-run` do not initialize anything. Apply within authorized local setup only after an applicable conflict-free preview. If unknown capability requires a choice, explicitly select `--manual-observe` in both preview and apply. The declaration grants no remote permission.

See [Upgrading Existing Projects](Upgrading-Existing-Projects) for host integration and [Team Workflow](Team-Workflow) for delivery. For agent-led installation, use the [agent guide](https://github.com/LeXwDeX/SpecGit/blob/main/docs/agent-install.md).
