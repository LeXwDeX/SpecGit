# Workflows

- CI: repository contracts, three native Rust platforms, installed regressions,
  Required verification and the protected SpecGit Acceptance status.
- Security: dependency review, Cargo audit and private Node tooling audit.
- Release: explicit main dispatch, three native builds, signed ZIP publication.
- CodeQL: GitHub-managed default setup; its repository setting selects the standard
  GitHub runner independently of these tracked workflow files.

All CI, security, and release jobs use GitHub-hosted standard runners: `ubuntu-24.04`,
`macos-15` (ARM64), and `windows-2025`. These runners are free and unlimited for
public repositories. No v1 verifier or completion controller remains.
GitHub owns native auto-merge and Issue closure. See [CI scope](../../docs/ci-scope.md).
