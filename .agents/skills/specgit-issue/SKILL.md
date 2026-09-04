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

Local CLI installation, upgrades, and `init` / `setup` refreshes need no
issue, PR, product build, or release when no product or shared-rule change is
intended for commit. Review tracked diffs before choosing what to share.
For intended deliveries, follow the host project's verification policy for
the actual changed inputs; documentation may itself be a product input.
Ignore rules are never CI exemptions. Publishing requires explicit authorization.

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

- Follow the policy's `language` for issue/PR prose. Enabled
  `validation` rules check live titles and labels. In `kind` mode,
  select exactly one catalog kind plus only declared extras; in `project`
  mode, select only from policy `tags`.
- Every bootstrap applies the title's `kind::<type>` member by default;
  pass `--tags <a,b>` to choose the full set yourself instead.
- Selection is pool-first: existing on-spec labels win verbatim; anything
  missing is seeded from the built-in kind:: catalog or the policy's
  `tags:` declarations — unknown vocabulary exits 2 naming what exists.
- Pick at most one label per axis (`kind::`, `module::`, ...).
  Omit uncertain optional labels; the selected policy determines which
  labels are required. An existing pool label cannot override that policy.

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
- The trigger is the decision to deliver an intended tracked change:
  when you begin implementing that delivery, run this command FIRST, before tracked
  implementation edits. Preparing temporary body files belongs to bootstrap.
  Working without a binding is a contract violation, not a style
  choice.
- After bootstrap, verify each issue contains the discussed Why / Scope /
  Approach / Acceptance. Fill missing content with `gh issue edit <n>` or
  `glab issue update <n>`, preserve complete remote bodies, then implement.
- With selected body rules, prepare complete content before creation using
  `--body-file` and `--pr-body-file`. Otherwise fill the built-in scaffold
  during delivery. Enabled content rules must pass; keep closing references
  and existing remote edits intact.
- The PR body is written once at creation; no SpecGit command edits it
  afterwards, and the repository's own PR template is never read.
- If it fails mid-chain, re-run the same command — completed steps are
  detected and resumed; never hand-edit `.specgit.yaml`.
- When the title yields no ASCII slug, the command asks for a kebab-case
  delivery name on an interactive terminal; a scripted session must pass
  `--delivery <slug>` (exit 2 otherwise). Bootstrap never invents a name.
