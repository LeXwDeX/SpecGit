# SpecGit Wiki

SpecGit is a lightweight delivery binding and acceptance tool for teams and
coding agents. It connects a branch or worktree, one or more issues, one PR/MR,
and the project's required checks, then verifies their Git and platform evidence.

**Acceptance and completion are separate facts.** `specgit finish` exit `0`
means accepted. A delivery is completed only after its merge and every bound
issue closure are confirmed. Missing evidence yields `unknown`; it never grants
acceptance. The command itself is read-only.

## Keep verification proportional

A README introduction or ordinary project-guidance edit needs a relevant content
review and lightweight checks. It does not need product builds, full tests,
mutation testing, repeated agent reviews, or a package release. Source and
executable inputs use their applicable product checks. A mixed PR still needs
product verification.

SpecGit's own repository retains lightweight remote metadata validation and
acceptance before merge. Adopting projects choose their own check scope; the
source repository's CI policy is not imposed on their business pipelines.

## Start here

| Guide | What it explains |
| --- | --- |
| [Getting Started](Getting-Started) | Install, initialize, deliver, and upgrade |
| [CLI Reference](CLI-Reference) | Ten commands, flags, exit codes, and JSON |
| [Concepts](Concepts) | Binding, evidence, acceptance, and completion |
| [Team Workflow](Team-Workflow) | Policy, proportional verification, review, and merge |
| [GitLab Support](GitLab-Support) | Host declaration, compatibility, and pipeline ownership |
| [Provider Architecture](Provider-Architecture) | Local Git and forge capabilities |

Install with `npm install -g specgit@latest`; requirements are Node.js `>=20.19`,
Git, and an authenticated `gh` or `glab`. Use `specgit --version` to identify the
installed runtime and consult the [release notes](https://github.com/LeXwDeX/SpecGit/releases)
for changes in that version.

Detailed contracts live in the [repository docs](https://github.com/LeXwDeX/SpecGit/tree/main/docs).
The editable Wiki copies are maintained under `docs/wiki/`; publishing them to
this separate Wiki is an explicit step.

中文：[首页](Home-zh) · [快速开始](Getting-Started-zh)
