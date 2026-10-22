<!--
GitHub Release notes template. runtime/distribution/publish.mjs renders this file for every release.
Placeholders: {{version}}, {{previous_version}}, {{changes}}, {{source}}, {{build_run}}, {{checksums}}.
{{changes}} is the matching `# <version>` section of CHANGELOG.md; write user-facing notes there before release.
This comment is removed from the published notes.
-->
# SpecGit {{version}}

Native Rust CLI for macOS arm64, Linux x64 (glibc) and Windows x64. No Node.js, npm or Rust installation is required to run SpecGit.

## Changes

{{changes}}

## Install or upgrade

- New installation: ask your coding agent to follow the [v{{version}} Agent installation guide](https://github.com/LeXwDeX/SpecGit/blob/v{{version}}/docs/agent-install.md). It verifies the Sigstore signature and ZIP SHA-256, then selects the project capabilities.
- Installed CLI: follow the [v{{version}} project maintenance guide](https://github.com/LeXwDeX/SpecGit/blob/v{{version}}/docs/agent-project-refresh.md) to update the shared executable with `specgit update`, then preview and refresh each clone or worktree.
- SpecGit v1 projects: read the [v2 migration guide](https://github.com/LeXwDeX/SpecGit/blob/v{{version}}/docs/migration-v2.md) before replacing a v1 project configuration.

## Verification

Required verification and SpecGit Acceptance passed on the exact release source commit [`{{source}}`](https://github.com/LeXwDeX/SpecGit/commit/{{source}}) before signing. Each binary passed version, help and schema smoke checks on its GitHub-hosted runner (`ubuntu-24.04`, `macos-15` or `windows-2025`). Before this release became latest, the publisher verified the checksum signature against the main Release workflow identity and downloaded every asset again to compare its bytes.

Native build run: [workflow run](https://github.com/LeXwDeX/SpecGit/actions/runs/{{build_run}})

SHA-256 values for the three native ZIPs, matching the signed `SHA256SUMS` manifest:

{{checksums}}

[Compare v{{previous_version}} to v{{version}}](https://github.com/LeXwDeX/SpecGit/compare/v{{previous_version}}...v{{version}}) · [License](https://github.com/LeXwDeX/SpecGit/blob/{{source}}/LICENSE)
