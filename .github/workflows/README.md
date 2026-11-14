# Workflows

- CI: repository contracts, three native Rust platforms, installed regressions,
  Required verification and the protected SpecGit Acceptance status.
- Security: dependency review, Cargo audit and private Node tooling audit.
- Release: explicit main dispatch, three native builds, signed ZIP publication.
- Pages: main-only deployment of the static bilingual site in `site/`; no build
  step, Node.js or third-party assets.
- CodeQL: GitHub-managed default setup; its repository setting selects the standard
  GitHub runner independently of these tracked workflow files.

Runner routing depends on the event. On pull requests the Rust matrix runs Linux
only. Pushes to main route Linux and Windows to the owner's self-hosted Azure
runners and macOS to GitHub-hosted `macos-15` (ARM64); same-repository PRs use the
same Linux route. Fork PRs use GitHub-hosted runners for the Linux job; merge
groups and manual runs use GitHub-hosted runners for all three platforms. Other
CI jobs and release builds use GitHub-hosted runners. CodeQL routing is selected
by its native repository setting, independently of these tracked workflow files.
No v1 verifier or completion controller remains. GitHub owns native auto-merge
and Issue closure. [CI scope](../../docs/ci-scope.md) is the only source for
routing details.
