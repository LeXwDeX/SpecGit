# SpecGit plugin for Claude Code

SpecGit gives coding agents a shared delivery workflow for GitHub and GitLab.
Issues hold the specification, a pull request or merge request gathers the
selected Issues and the implementation, and the forge remains the source of
truth for checks, review, merge, and closure.

This plugin is a thin distribution wrapper. It ships the `specgit-native` Skill
and onboarding guidance only. It contains no native binary, installs no hooks,
and writes no global state.

## Requirements

The Skill drives the user-level `specgit` executable on your machine:

```sh
command -v specgit
specgit --version
```

You also need Git and an authenticated `gh` (GitHub) or `glab` (GitLab) session
for forge operations.

If `specgit --version` fails, install the latest stable release from
[GitHub Releases](https://github.com/LeXwDeX/SpecGit/releases):

```sh
# Download the ZIP for your system together with SHA256SUMS, then verify:
shasum -a 256 specgit-<version>-darwin-arm64.zip                  # macOS
sha256sum specgit-<version>-linux-x64-gnu.zip                     # Linux
Get-FileHash .\specgit-<version>-win32-x64.zip -Algorithm SHA256  # Windows
```

The computed digest must match the corresponding row in `SHA256SUMS`. Stop and
report the mismatch when the row is missing or does not match. Extract the
archive, put the root-level `specgit` (`specgit.exe` on Windows) on a user-level
directory in `PATH`, and confirm `specgit --version`. GitHub Releases is the only
distribution channel; do not use npm or unofficial mirrors. The
[agent installation guide](https://github.com/LeXwDeX/SpecGit/blob/main/docs/agent-install.md)
covers the signed checksum manifest, PATH setup, and project initialization.

## Use

Initialize the repository once with `specgit init`; existing projects use
`specgit setup` and preserve recorded host choices. Then describe the work and
the Skill loads automatically for Issues, pull/merge requests, branches,
worktrees, checkpoints, CI or review follow-up, merge delivery, releases, and
project status reviews. For example: "Implement issue 42, verify it, open a PR,
and follow CI through merge."

Project hooks remain opt-in through `specgit setup --agent claude`; this plugin
never installs hooks or global state.

## Behavior and data disclosure

- The plugin itself makes no network requests and stores no credentials.
- The bundled Skill instructs Claude Code to run the local `specgit` CLI.
- That CLI reads and writes Issues, pull requests, and merge requests on GitHub
  or GitLab through your configured `gh`/`glab` credentials and the repository
  remote. It also reads CI status, reviews, branches, and checkpoints. Writes
  are limited to the task you authorize; previews such as `--inspect`,
  `--dry-run`, and `--schema` are available before changes.
- No repository content is sent anywhere except the forge API selected by the
  repository remote.

## License

MIT. See [LICENSE](LICENSE).