---
name: Bug report
about: Something in SpecGit behaves contrary to the documented contract
title: 'fix: <english title>'
labels: kind::fix
---

## What happened

A clear description of the defect.

## What I expected

The behavior the docs promise (cite the page if you can: README,
docs/installation.md, docs/migration-v2.md, docs/ci-scope.md, or
runtime/REFERENCE.md).

## Evidence

- SpecGit version: `specgit --version` →
- OS:
- The command run (with `--json` if possible) and its **exit code**
  (include the exact number):

```
<paste the --json envelope or the human output>
```

- The diagnostic `code` from `diagnostics[]` (if any):

## Reproduction

The smallest sequence of commands that reproduces the defect:

```bash
git clone …
specgit init …
specgit issue …
specgit pr --status --json
```

## Notes

Did you check [Native reference](https://github.com/LeXwDeX/SpecGit/blob/main/runtime/REFERENCE.md)
for the code first? What did it suggest, and why didn't it fix it?
