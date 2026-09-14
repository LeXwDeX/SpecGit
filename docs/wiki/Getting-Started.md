# Getting Started

Install a native executable from [GitHub Releases](https://github.com/LeXwDeX/SpecGit/releases/latest).
Choose macOS arm64, Linux x64 glibc or Windows x64, verify its SHA-256 against the
Release description, rename it to `specgit` (`specgit.exe` on Windows), and put it
on PATH. Unix platforms also need `chmod +x specgit`. No Node.js, npm or Rust
compiler is needed. Repository operations need Git and an authenticated `gh` / `glab`.

```sh
specgit --human --version
specgit --help
specgit --schema
specgit init --check --json
specgit setup --dry-run --json
```

Preview Issue and PR changes with `specgit issue <number> --dry-run --json` and
`specgit pr --dry-run --json`. The Agent implements and repairs; the forge owns
checks, merge and ordinary Issue closure. Preview does not authorize a later write.

After CLI upgrades, confirm PATH selects the new binary. Migrate v1 projects
explicitly before using v2; old `finish` and `init --force` instructions are retired.
See the [installation guide](https://github.com/LeXwDeX/SpecGit/blob/main/docs/installation.md),
[migration guide](https://github.com/LeXwDeX/SpecGit/blob/main/docs/migration-v2.md), and
[native reference](https://github.com/LeXwDeX/SpecGit/blob/main/runtime/REFERENCE.md).
