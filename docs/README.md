# SpecGit Documentation

Welcome. This is the home for everything SpecGit.

SpecGit binds each delivery to real, checkable evidence: **a git branch or worktree, one or more GitHub issues, one pull request, and required CI checks.** Acceptance is derived from live git, PR, and check evidence — never from spec artifacts, task checklists, or self-declared completion.

```text
delivery + execution context + issues[] + PR + required checks = accepted
```

If you read nothing else, read these two pages:

1. [Getting Started](getting-started.md): install, initialize the policy, and take your first delivery to acceptance.
2. [Concepts](concepts.md): the delivery binding aggregate and why acceptance is derived, never asserted.

New: the [Workflow Guide](workflow-guide.md) (中文) is the canonical
step-by-step walkthrough — machine setup, repo init, the one-command
per-delivery loop (`specgit issue` → `specgit finish`), and the agent
operating loop (managed AGENTS.md block → dev loop), with
troubleshooting at the end.

## Pick your path

**I'm brand new.** Start with [Getting Started](getting-started.md), then skim [Concepts](concepts.md). When something feels mysterious, the [FAQ](faq.md) and [Glossary](glossary.md) are nearby.

**I want every command, flag, and exit code.** The [CLI reference](cli.md) covers the ten commands, the `--json` envelope, and the exit-code contract.

**I want the exact schemas and gate table.** [Reference](reference.md) documents `.specgit.yaml`, `spec_git/policy.yaml`, the eleven gates, and every diagnostic code.

**I want the versioned product contract.** [Product Baseline v1](baseline-v1.md) fixes the supported platforms, the ten commands, state and assets, compatibility, non-goals, and the deprecation policy.

**I run GitHub Actions.** [GitHub Actions](actions.md) defines how check names are chosen, how required checks are wired, and the security guidance for workflows.

**I just want to see it work.** [Examples & Recipes](examples.md) walks real deliveries end to end: a feature branch, a worktree bug fix closing two issues, and diagnosing a rejected verdict.

**I'm adopting SpecGit in a real codebase.** [Existing Projects](existing-projects.md) shows how to bootstrap the policy around the CI you already have.

**I work on a team.** [Team Workflow](team-workflow.md) shows how one delivery maps onto one branch (or worktree), N issues, one PR, and the checks everyone agrees are required.

**An AI agent does my work.** Read the [Agent Contract](agent-contract.md) — and run `specgit init`, which injects the managed agent block into `AGENTS.md`. Agents run `specgit finish` and trust the verdict — they never declare completion themselves.

**Something is failing.** [Troubleshooting](troubleshooting.md) maps every diagnostic code to its cause and fix.

**I want to contribute, get support, or report a problem.** See [Contributing](../CONTRIBUTING.md), [Support](../SUPPORT.md), and the issue templates on GitHub. Security reports follow [SECURITY.md](../SECURITY.md).
