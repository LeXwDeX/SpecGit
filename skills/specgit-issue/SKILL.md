---
name: specgit-issue
description: Start a SpecGit delivery — create or reuse GitHub issues, branch, draft PR that closes them, and record the binding, in one command.
allowed-tools: Bash(specgit:*), Bash(git:*), Bash(gh:*), Bash(glab:*)
license: MIT
metadata:
  author: specgit
---

<!-- specgit-managed-entry-point -->

# specgit-issue

The delivery bootstrap. One command binds the whole aggregate: N issues, one
branch, one draft pull request, one record (`.specgit.yaml`).

## Usage

```bash
specgit issue "<title>"                 # create one issue and start
specgit issue "<title A>" "<title B>"   # N issues, one delivery
specgit issue 42                        # reuse an existing issue
specgit issue "<no-slug title>" --delivery my-name   # explicit delivery name
specgit issue "<title>" --tags kind::fix,module::auth  # explicit tag selection
```

New titles must start with `<type>: `; allowed types: feat, fix, refactor, perf, docs, test, chore, style, build, ci, revert, security, deprecate, dogfood.

## Tagging (choose before you bootstrap)

- Every bootstrap applies the title's `kind::<type>` member by default;
  pass `--tags <a,b>` to choose the full set yourself instead.
- Selection is pool-first: existing on-spec labels win verbatim; anything
  missing is seeded from the built-in kind:: catalog or the policy's
  `tags:` declarations — unknown vocabulary exits 2 naming what exists.
- Pick with restraint: at most one label per axis (`kind::`,
  `module::`, ...), none when unsure. The pool, not your guess, is the
  source of truth.

## What it does (idempotent; re-run resumes)

1. Creates (or reuses) the issues — one issue = one independently verifiable
   WHY.
2. Creates and checks out the delivery branch.
3. Opens a draft PR pre-filled with a deterministic scaffold: the
   `Closes #n` line for every bound issue first, then Why / What changed /
   Evidence / Checklist sections.
4. Writes `.specgit.yaml` and commits it.
5. Pushes the branch.

## Rules

- Run it from the repository root; context comes from live git.
- The trigger is the decision to start: the moment you begin turning the
  discussed plan into changes, run this command FIRST — before any file
  edit. Working without a binding is a contract violation, not a style
  choice.
- Immediately after bootstrap succeeds, fill each issue body it created
  (Why / Scope / Approach / Acceptance) from the discussion with
  `gh issue edit <n>`, then implement.
- Fill in the PR scaffold sections as you deliver; placeholders are advisory,
  never gates. Keep the closing references intact.
- The PR body is written once at creation; no SpecGit command edits it
  afterwards, and the repository's own PR template is never read.
- If it fails mid-chain, re-run the same command — completed steps are
  detected and resumed; never hand-edit `.specgit.yaml`.
- When the title yields no ASCII slug, the command asks for a kebab-case
  delivery name on an interactive terminal; a scripted session must pass
  `--delivery <slug>` (exit 2 otherwise). Bootstrap never invents a name.
