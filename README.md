<p align="center">
  <a href="https://github.com/LeXwDeX/SpecGit"><strong>SpecGit</strong></a><br/>
  <em>Acceptance for deliveries, derived from evidence — not artifacts.</em>
</p>

<p align="center">
  <a href="https://github.com/LeXwDeX/SpecGit/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/LeXwDeX/SpecGit/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square" /></a>
</p>

---

## What SpecGit is

SpecGit defines **done** as a verifiable fact. A delivery is one aggregate:

```text
execution context (branch or worktree)
  + issues[]  (GitHub issues it closes)
  + one pull request
  + required CI checks
```

`specgit accept` re-derives the verdict from **live evidence** — your git
checkout, the issues, the PR's closing references, and the check runs
reported at the PR head commit. There are no spec files, no task lists, no
artifact states that can claim completion for themselves. If the evidence
can't be gathered, the answer is `unknown`, never `accepted` — SpecGit
**fails closed**.

## The loop

```bash
# once per repository: declare which CI checks a delivery must pass
specgit init --required-check "All checks passed"      # → spec_git/policy.yaml

# per delivery, on the delivery branch (context comes from live git)
git checkout -b feat/123-add-login
specgit bind --delivery add-login --issue 123          # → .specgit.yaml

# work, commit, push, open PR #42 with “Closes #123”, make CI green
specgit bind --pr 42

specgit accept
# exit 0 → accepted · exit 1 → rejected (evidence attached) · exit 3 → cannot determine
```

Two committed files, zero other state. One PR may close N issues; every bound
issue must be closed from the PR body; checks are matched byte-for-byte
against the names in `spec_git/policy.yaml`.

## Why evidence, not artifacts

Checklists and task files let whoever edits them declare "done." SpecGit
instead asks git and GitHub:

- Is this checkout the record's branch/worktree? *(context gates)*
- Do the bound issues exist? *(issue gates)*
- Is the PR open (or merged), on the right branch, in this repo? *(PR gates)*
- Does the PR body close **every** bound issue? *(closing-ref gate)*
- Is every required check green **at the PR head commit**? *(check gates)*

Ten ordered gates, each reporting stable diagnostic codes with fixes. Verdicts
are computed per invocation and never persisted, so they cannot drift from
reality.

## Commands

| Command | Does | Network |
| --- | --- | --- |
| `specgit init` | Creates the policy `spec_git/policy.yaml` | no |
| `specgit bind` | Creates/updates the record `.specgit.yaml` (context auto-resolved from live git) | no |
| `specgit unbind` | Deletes the record | no |
| `specgit status` | Local evidence snapshot (record, policy, git facts, drift) | no |
| `specgit accept` | Full evaluation → accepted / rejected / unknown | yes (`gh`) |
| `specgit doctor` | Probes prerequisites (git, repo, origin, gh, policy) | gh auth |

Every command supports `--json` (one JSON document on stdout, human text on
stderr). Exit-code contract: `0` accepted/success · `1` rejected with complete
evidence · `2` usage error · `3` fail-closed unknown. Requirements: Node ≥
20.19, `git`, and `gh` (authenticated) for GitHub evidence. There is no
telemetry and no configuration beyond the two files.

## Built for teams and agents

- **Teams**: the policy is a committed contract — change required checks the
  way you change code, aligned with branch protection. See
  [Team Workflow](docs/team-workflow.md) and
  [GitHub Actions guidance](docs/actions.md).
- **AI agents**: stable commands, contractual exit codes, one JSON envelope —
  and the rule that `specgit accept` exit `0` is the *only* definition of
  done. See the [Agent Contract](docs/agent-contract.md) and the
  [skills](skills/README.md).

## Documentation

- [Documentation home](docs/README.md)
- [Getting Started](docs/getting-started.md) · [Installation](docs/installation.md)
- [Concepts](docs/concepts.md) · [Overview](docs/overview.md)
- [CLI Reference](docs/cli.md) · [Reference (schemas, gates, codes)](docs/reference.md)
- [GitHub Actions usage & security](docs/actions.md)
- [Examples & Recipes](docs/examples.md) · [Existing Projects](docs/existing-projects.md)
- [Troubleshooting](docs/troubleshooting.md) · [FAQ](docs/faq.md) · [Glossary](docs/glossary.md)

## Security

SpecGit reads git facts and GitHub evidence (via your existing `gh` session);
it writes only its two YAML files. It never reads, prints, or stores tokens,
performs no telemetry, and sanitizes API-sourced strings before rendering.
For workflow-side guidance — permissions, secrets, fork PRs, supply chain —
see [GitHub Actions security](docs/actions.md#security-guidance). To report a
vulnerability in SpecGit itself, open a private security advisory on this
repository.

## License

MIT — see [LICENSE](LICENSE).
