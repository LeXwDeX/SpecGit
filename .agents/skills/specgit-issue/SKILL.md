---
name: specgit-issue
description: Start a SpecGit delivery — create or reuse forge issues, branch, draft PR or MR that closes them, and record the binding, in one command.
allowed-tools: Bash(specgit:*), Bash(git:*), Bash(gh:*), Bash(glab:*)
license: MIT
metadata:
  author: specgit
---

<!-- specgit-managed-entry-point -->

# specgit-issue

The delivery bootstrap. One command binds the whole aggregate: N issues, one
branch, one draft pull or merge request, one record (`.specgit.yaml`).

Local CLI installation, upgrades, and `init` / `setup` refreshes need no
issue, PR/MR, product build, or release when no product or shared-rule change is
intended for commit. Review tracked diffs before choosing what to share.
After a package upgrade, a human may run plain `specgit init` and approve its
guided refresh when it proves drift. Non-interactive agents run
`specgit init --force --no-protect`, then `specgit setup --tool all`, then
verify `specgit status --json`. Append `--no-ignore` to init when
authoritative delivery files are intentionally tracked without the managed
ignore block; setup preserves that proven choice.
For intended deliveries, follow the host project's verification policy for
the actual changed inputs; documentation may itself be a product input.
Ignore rules are never CI exemptions. Publishing requires explicit authorization.

## Usage

```bash
specgit issue "fix: correct cache invalidation"       # create one issue and start
specgit issue "feat: add login" "security: harden sessions" # N issues, one delivery
specgit issue 42                        # reuse an existing issue
specgit issue "docs: 更新安装说明" --delivery docs-install # zh policy; explicit ASCII name
specgit issue "fix: validate session" --tags kind::fix,module::auth
```

New titles must start with `<type>: `; allowed types: feat, fix, refactor, perf, docs, test, chore, style, build, ci, revert, security, deprecate, dogfood.

## Before creating an issue

Search for the same WHY on the configured forge before creating new work:

```bash
gh issue list --state open --search "<keywords>"       # GitHub
glab issue list --search "<keywords>" --in title      # GitLab
```

Open and read every plausible candidate with `gh issue view <n>` or
`glab issue view <n>`. Reuse a candidate that covers the same WHY; if it is
close but different, record the distinction. Ask the requester only when the
evidence does not decide whether the work is a duplicate.

## Tagging (choose before you bootstrap)

- Follow the policy's `language` for issue and PR/MR prose. Enabled
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
   WHY — and writes the initial binding.
2. Creates and checks out the delivery branch.
3. Commits the authoritative binding and pushes the branch, so the request has
   a real remote head distinct from its base.
4. Opens a draft PR/MR pre-filled with the supplied body, selected policy
   template, or built-in scaffold, including one `Closes #n` line per bound
   issue.
5. Records the request number, commits the completed binding, and pushes again.

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
  `--body-file` and `--pr-body-file`. Without enforced body rules, fill the
  selected policy template or built-in scaffold during delivery. Enabled
  content rules must pass; keep closing references and existing remote edits
  intact.
- The PR/MR body is written once at creation; no SpecGit command edits it
  afterwards, and the repository's default PR/MR template is never read.
- If it fails mid-chain, re-run the same command — completed steps are
  detected and resumed; never hand-edit `.specgit.yaml`.
- When the title yields no ASCII slug, the command asks for a kebab-case
  delivery name on an interactive terminal; a scripted session must pass
  `--delivery <slug>` (exit 2 otherwise). Bootstrap never invents a name.
