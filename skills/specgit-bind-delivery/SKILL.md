---
name: specgit-bind-delivery
description: Create or update the SpecGit delivery record (.specgit.yaml) — bind the delivery id, GitHub issues, and PR from the live git context.
allowed-tools: Bash(specgit:*), Bash(git:*), Bash(gh:*)
license: MIT
compatibility: Requires the specgit CLI and git. Bind is local-only; no network calls.
metadata:
  author: specgit
  version: "1.0"
---

Bind the current delivery: attach the delivery id, the GitHub issues it closes,
and the pull request that merges it. The record is `.specgit.yaml` at the
repository root, and it must be committed on the delivery branch.

## Preflight

1. Confirm the working location. The execution context is resolved from **live
   git** — there are no flags to set it, so the checkout decides it:

```bash
git rev-parse --show-toplevel
git symbolic-ref --quiet --short HEAD
```

The second command must print the delivery's branch. If HEAD is detached or on
the wrong branch, check out the delivery branch first and start over.

2. Read current state:

```bash
specgit status --json
```

- No record yet → this is a first bind (you must supply `--delivery`).
- Record exists → re-binds only add issues or set the PR. `--delivery` is
  rejected after the first bind.

## First bind

Agree with the user on a kebab-case delivery id (lowercase, single hyphens),
then bind with every known GitHub issue number:

```bash
specgit bind --delivery add-login-flow --issue 123 --issue 124
```

Rules:

- `--issue` takes **GitHub issue numbers only** (or full issue URLs). Opaque
  tracker references (e.g. `JIRA-123`) fail with `issue_ref_not_github` — if
  work is tracked elsewhere, ask the user to open a GitHub issue linking it.
- The context block (`kind: branch` or `kind: worktree` + label) is written
  automatically from live git. Never hand-edit it.
- Inside a linked worktree the record gets `kind: worktree` with the checkout
  basename as a portable label; this is correct — do not convert it.

Confirm what was written:

```bash
specgit status --json
```

## Binding the PR

Once the pull request exists (create it with `gh pr create` if the user asks,
with closing references in the body — see the accept skill), bind it:

```bash
specgit bind --pr 42
```

`--pr` accepts a number or a URL and **replaces** any previous value — one PR
per delivery. Re-run `--issue` any time to merge additional issue numbers;
values deduplicate with first-seen order kept.

## Finish

1. Verify the record:

```bash
cat .specgit.yaml
```

Expected shape (context reflects live git):

```yaml
version: 1
delivery: add-login-flow
context:
  kind: branch
  branch: feat/123-login
issues: [123, 124]
pr: 42
```

2. Commit `.specgit.yaml` on the delivery branch (or tell the user to), so the
   binding travels with the work and every checkout can evaluate it.

See: [Getting Started](../../docs/getting-started.md), [Reference](../../docs/reference.md).
