---
"specgit": minor
---

### SpecGit 0.0.1 — initial release

SpecGit is a delivery binding and acceptance harness. This is the first release of the new product; OpenSpec is retired with no compatibility or migration path.

- **Product identity.** Package `specgit`, CLI `specgit`, project data root `spec_git/`, delivery record `.specgit.yaml`. Canonical repository: https://github.com/LeXwDeX/SpecGit.
- **Delivery model.** A change binds one git branch or one git worktree to `issues[]` and one pull request; one PR may bind and close N issues.
- **Evidence-derived acceptance.** `specgit accept` derives its verdict fail-closed from real git, PR, and check evidence through mockable provider adapters (`git` locally, `gh` as the GitHub seam). Spec artifacts, `tasks.md`, or any other file contents can never change acceptance. Exit contract: 0 accepted · 1 rejected · 2 usage · 3 fail-closed unknown.
- **Command surface.** `specgit init` (write `spec_git/policy.yaml`), `bind`, `unbind`, `status`, `accept`, `doctor`. Non-interactive; one JSON document on stdout with `--json`.
