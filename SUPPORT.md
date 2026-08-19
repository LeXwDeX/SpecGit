# Support

Where to get help with SpecGit, and where each kind of report belongs.

## Routes

| I need… | Where to go |
| --- | --- |
| To understand the product | [README](README.md) · [Documentation home](docs/README.md) · [Product Baseline v1](docs/baseline-v1.md) |
| To install and start | [Installation](docs/installation.md) · [Getting Started](docs/getting-started.md) |
| Every command, flag, exit code | [CLI Reference](docs/cli.md) |
| To fix a failing verdict | [Troubleshooting](docs/troubleshooting.md) — every diagnostic code mapped to a fix · [FAQ](docs/faq.md) |
| To adopt (or remove) SpecGit in an existing repo | [Existing Projects](docs/existing-projects.md) — adoption and uninstall, step by step |
| To report a bug | [Open a bug report](https://github.com/LeXwDeX/SpecGit/issues/new?template=bug_report.md) — include the `--json` output and exit code |
| To propose a feature | [Open a feature request](https://github.com/LeXwDeX/SpecGit/issues/new?template=feature_request.md) |
| To report a security vulnerability | **Privately** — see [SECURITY.md](SECURITY.md). Do not open a public issue. |
| To contribute code or docs | [CONTRIBUTING.md](CONTRIBUTING.md) |

## Before you file a bug

1. Run the failing command with `--json` and note the exit code
   (`0`/`1`/`2`/`3`; `130` = Ctrl-C interruption).
2. Check [Troubleshooting](docs/troubleshooting.md) for the diagnostic `code`
   in `errors[]` — most codes have a documented fix.
3. If it is genuinely a SpecGit defect, the bug template asks for: SpecGit
   version (`specgit --version`), Node version, OS, the `--json` output, and
   the smallest reproduction.

## Response expectations

This is a small maintainer team
([MAINTAINERS.md](MAINTAINERS.md)). Bugs with clear reproductions get
priority; feature proposals are triaged against the
[Public Launch v1.0 milestone](https://github.com/LeXwDeX/SpecGit/milestone/1)
and the [product baseline](docs/baseline-v1.md). Please use the issue
templates — complete reports are answered faster.

## Code of Conduct

All interactions in this project follow the [Code of Conduct](CODE_OF_CONDUCT.md).
