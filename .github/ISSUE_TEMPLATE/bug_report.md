---
name: Bug report
about: Something in SpecGit behaves contrary to the documented contract
title: 'fix: <english title>'
labels: bug
---

## What happened

A clear description of the defect.

## What I expected

The behavior the docs promise (cite the page if you can: README, docs/cli.md,
docs/reference.md, docs/baseline-v1.md).

## Evidence

- SpecGit version: `specgit --version` →
- Node version: `node --version` →
- OS:
- The command run (with `--json` if possible) and its **exit code**
  (`0`/`1`/`2`/`3`; `130` = Ctrl-C interruption):

```
<paste the --json envelope or the human output>
```

- The diagnostic `code` from `errors[]` (if any):

## Reproduction

The smallest sequence of commands that reproduces the defect:

```bash
git clone …
specgit init …
specgit issue …
specgit finish …
```

## Notes

Did you check [Troubleshooting](https://github.com/LeXwDeX/SpecGit/blob/main/docs/troubleshooting.md)
for the code first? What did it suggest, and why didn't it fix it?
