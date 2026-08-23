---
"specgit": patch
---

Fix the adoption cold-start ordering: the acceptance wait step now diagnoses an absent `spec_git/policy.yaml` at the PR head with an actionable message instead of an ENOENT crash (all three template copies), the interactive protection prompt warns that a fresh adoption must merge its adoption PR before the acceptance check becomes required, and README/existing-projects agree on the ordering — protect after the adoption merge, never before (#297).
