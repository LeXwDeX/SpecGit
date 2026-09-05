# Getting Started

## Install and initialize

Use Node.js `>=20.19`, Git, and an authenticated forge CLI. Run repository
commands in the project you intend to adopt.

```bash
npm install -g specgit@latest
specgit --version
gh auth status
specgit init
specgit setup
```

For GitLab, authenticate `glab` for the exact host and initialize with
`specgit init --gitlab-host gitlab.example.com`. See [GitLab Support](GitLab-Support).
Review detected check names; repeat `--required-check` when naming them explicitly.
An intentionally empty list means no business-CI requirements, while the platform
acceptance integration remains the gate. Never make the acceptance job wait on itself.

Init writes shared integration assets and local hooks. Review those changes
before sharing them. Automatic merge defaults to **no**; only the user's explicit
yes enables it. Agent entry points installed by `setup` are local conveniences.

SpecGit uses the repository's proved default branch, which may be `master`,
`trunk`, or another name. If default-branch evidence is missing, run
`git fetch origin` and `git remote set-head origin -a`, then retry. An explicit
automation target chooses the PR/MR destination; it does not identify the trusted
default branch used by initialization.

## Deliver

```bash
specgit issue "feat: add login flow"
# Implement, run applicable checks, commit, and push.
gh pr ready <number>                 # GitLab: glab mr update <number> --ready
specgit finish
```

One issue describes one independently verifiable WHY. A title creates an issue;
a number reuses one. Several arguments may bind several issues to one PR/MR.
New titles need a supported `<type>:` prefix; project policy controls language
and validation. For a Chinese title, supply an ASCII delivery name, for example
`specgit issue "docs: 更新简介" --delivery refresh-introduction`.

Supply `--body-file` per new issue and `--pr-body-file` when selected body rules
require complete content at creation. Preserve every `Closes #n` reference.
Re-run the same bootstrap to resume an interruption without creating duplicates.

Exit `0` means accepted. `finish` does not merge or close issues. Enabled
completion automation continues after CI; `specgit pr --merge` is its recovery
command. Without automation, follow the team's authorized merge process.
Confirm merge and all issue closures before reporting completed.

For prose-only work, review relevant content and use lightweight checks. Product
builds and repeated code reviews are unnecessary. See [Team Workflow](Team-Workflow).

## Upgrade and refresh

Updating the package and refreshing a repository are separate operations:

```bash
npm install -g specgit@latest
specgit --version
specgit init --force --no-protect
specgit setup --tool all
specgit status --json
```

Review the diff before committing shared assets. Consult the
[installation guide](https://github.com/LeXwDeX/SpecGit/blob/main/docs/installation.md)
for ownership conflicts and an intentional committed-authoritative `--no-ignore`
setup. Use `doctor` only for a reported prerequisite or provider problem.
The explicit sequence above refreshes the repository after a package upgrade.

[CLI Reference](CLI-Reference) · [中文](Getting-Started-zh)
