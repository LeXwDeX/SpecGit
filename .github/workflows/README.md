# Workflows

- CI: repository contracts, three native Rust platforms, installed regressions,
  Required verification and the protected SpecGit Acceptance status.
- Security: dependency review, Cargo audit and private Node tooling audit.
- Release: explicit main dispatch, three native builds, signed ZIP publication.

All jobs use self-hosted runners. No v1 verifier or completion controller remains.
GitHub owns native auto-merge and Issue closure. See [CI scope](../../docs/ci-scope.md).
