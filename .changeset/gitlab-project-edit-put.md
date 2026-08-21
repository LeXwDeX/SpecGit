---
"specgit": patch
---

## GitLab provider

- Fix `setPipelineGate` to edit the project with `PUT` instead of `PATCH`:
  GitLab's edit-project endpoint is routed for `PUT` only, so every
  pipeline-gate call returned HTTP 404 and `specgit init` could never enable
  branch protection / auto-merge on a declared GitLab origin (#229, #230)
