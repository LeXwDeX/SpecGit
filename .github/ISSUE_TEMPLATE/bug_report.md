---
name: Bug report
about: Something in SpecGit behaves contrary to the documented contract
title: 'fix: <english title>'
labels: kind::fix
---

## Why

Describe the defect, user impact and expected behavior. Cite the current
[native reference](https://github.com/LeXwDeX/SpecGit/blob/main/runtime/REFERENCE.md)
where applicable. Search existing Issues for the same cause before creating another.

## Scope

Identify the affected command, platform and scenario, plus any important boundary.

## Approach

Describe the smallest reproduction and proposed investigation or repair. If the
cause is unknown, say so; do not invent a fix to complete the specification.

## Acceptance

Describe the observable behavior and regression evidence that will prove this
specific defect is fixed, including applicable installed/runtime verification.

## Evidence

- SpecGit version: `specgit --human --version`
- OS and architecture:
- Exact command and exit code:
- Sanitized `--json` report and diagnostic code:
- Reproduction steps, expected result and actual result:
- Recovery suggested by the diagnostic, and why it did not resolve the issue:

Do not include credentials, private source or personal data. Report security
vulnerabilities through [private vulnerability reporting](https://github.com/LeXwDeX/SpecGit/security/advisories/new).
