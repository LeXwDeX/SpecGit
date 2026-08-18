# SpecGit skills

Agent skills that drive the SpecGit delivery workflow. Each skill wraps the
`specgit` CLI — the evidence-based acceptance gate for deliveries (a branch or
worktree, bound GitHub issues, one PR, and required CI checks).

| Skill | Purpose |
| --- | --- |
| [`specgit-setup-policy`](specgit-setup-policy/SKILL.md) | Initialize `spec_git/policy.yaml` with the team's required check names |
| [`specgit-bind-delivery`](specgit-bind-delivery/SKILL.md) | Create/update the delivery record (`.specgit.yaml`) from live git |
| [`specgit-accept-delivery`](specgit-accept-delivery/SKILL.md) | Take a delivery to an accepted verdict and fix what the gates name |

## Install

Copy or link the skill directories into your agent's skills location, or add
this repository as a skills source if your agent supports it. The skills are
plain Markdown and are maintained by hand — there is no generation pipeline.

## Requirements

The skills operate the CLI; they add nothing to it:

- `git` — SpecGit runs only inside a repository
- [`specgit`](../docs/installation.md) — the CLI itself
- `gh` authenticated via `gh auth login` — required by `accept` (GitHub evidence)

## Operating discipline (what the skills encode)

1. Context comes from **live git**: be on the delivery branch, then `specgit bind`.
2. The PR body must **close every bound issue** with closing references.
3. `specgit accept` is the only definition of done. Exit `0` — accepted;
   exit `1` — fix the named gates; exit `3` — fix the environment first.
4. Never fabricate evidence: no editing the record or policy to force a verdict.

Full normative rules: [Agent Contract](../docs/agent-contract.md).
