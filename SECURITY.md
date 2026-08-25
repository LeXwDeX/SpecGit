# Security Policy

## Reporting a vulnerability

Report privately through [GitHub Security Advisories](https://github.com/LeXwDeX/SpecGit/security/advisories/new). Please don't open a public issue for a suspected vulnerability.

Include what you can: affected version, reproduction steps, and the impact you believe it has. We aim to acknowledge within 3 business days and to ship a fix or a decision within 30 days. Valid reports are credited in the advisory unless you'd rather stay anonymous.

## Supported versions

Fixes ship in the latest published version on npm. Older versions are not patched — upgrade to pick up a fix.

## Threat model

SpecGit is a local command-line tool. It has no server, no network listener, and no privileged daemon. It reads git state from the repository you run it in and talks to the forge APIs exclusively through your existing authenticated CLI sessions — `gh` for GitHub, `glab` for a declared self-managed GitLab host. No direct REST client, and no tokens are stored or logged by SpecGit.

That shapes what is and isn't a vulnerability here:

| In scope | Out of scope |
| --- | --- |
| Code execution triggered by parsing git, PR, or CI evidence | Reading or writing a file path you passed to the CLI yourself |
| Escaping the repository SpecGit was pointed at, via untrusted input | Static-analysis findings on file-path joins with no untrusted input |
| Leaking credentials or file contents through logs or output | Vulnerabilities in devDependencies that don't ship in the published package |
| Injection into the `git`/`gh`/`glab` command lines SpecGit builds | Denial of service against your own machine using your own input |

If you think something sits on the boundary, report it and we'll work it out together.

## Published package contents

The `specgit` npm package publishes `dist/`, `bin/`, and `schemas/`. Build and test tooling (vitest, eslint, typescript, and their transitive dependencies) is not published. Scanners that read `pnpm-lock.yaml` without separating dependency scope will report advisories for packages that never reach an installed copy of SpecGit.

`pnpm audit --prod` in this repository reports the same scope, and CI runs it on every pull request.

## Automated checks

| Tool | Covers |
| --- | --- |
| [Dependabot](https://github.com/LeXwDeX/SpecGit/security/dependabot) | Dependency advisories plus weekly update pull requests for the CLI and CI actions |
| Dependency review | Blocks a pull request that introduces a high-severity dependency |
| `pnpm audit` | Published dependencies are audited on every pull request, on pushes to `main`, and weekly |
| Pinned actions | Every GitHub Action runs from a commit SHA, so a moved tag cannot change what CI executes |

Alerts are triaged against the threat model above, so a finding in build-only tooling is fixed on the normal update cadence rather than treated as an incident.
