---
"specgit": minor
---

Shield the local delivery assets from git by default: `specgit init` now appends a managed, idempotent block to the root `.gitignore` covering `/.specgit.yaml` and `/spec_git/`, so record rewrites and policy regens never leak into unrelated commits (#292). `.gitignore` only hides untracked files, so the bootstrap's own binding commit force-stages the authoritative delivery files (record always; policy and providers when present) onto the delivery branch — the CI verdict still reads them there. Pass `--no-ignore` to keep the classic committed model.
