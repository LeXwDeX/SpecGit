---
'specgit': minor
---

Generate a portable acceptance harness for external repositories (#63).

- `specgit init` now selects the workflow template by repository: the SpecGit repository itself (root package name `specgit`) keeps the local-build template; every other (adopting) repository gets a portable template that installs the published CLI at the exact running version (`specgit@<version>`, no ranges), sets up only Node at the engine floor, parameterizes the adopting repo's remote default branch, and never assumes or invokes the adopting project's toolchain, lockfile, layout, or build. The `--json` envelope reports the choice as `harness.template`.
- No-CI repositories: init's detection fallback now writes an empty `required_checks` list instead of the unsatisfiable aggregate name "All checks passed" (never a check-run name — it deadlocked the generated wait step and made the verdict impossible). The policy schema accepts the empty list as the no-CI policy; the SpecGit Acceptance job, enforced through branch protection, is the gate. This is a schema widening with rationale documented in `schemas/specgit/schema.yaml`.
- An unresolvable remote default branch falls back to `main` with a `default_branch_unresolved` warning (same fallback the protection probe already uses).
