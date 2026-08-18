# CLI Reference

The `specgit` CLI has six commands. All evaluation is evidence-derived and fail-closed: commands either report verified facts or report why they cannot.

## Command summary

| Command | Purpose | Network | Exit codes |
| --- | --- | --- | --- |
| `specgit init` | Create the project policy (`spec_git/policy.yaml`) | no | 0 · 2 |
| `specgit bind` | Create/update the delivery record (`.specgit.yaml`) | no | 0 · 2 · 3 |
| `specgit unbind` | Delete the delivery record | no | 0 · 2 |
| `specgit status` | Local evidence only (record, policy, git facts, drift) | no | 0 · 2 · 3 |
| `specgit accept` | Full evaluation against git + GitHub | yes | 0 · 1 · 2 · 3 |
| `specgit doctor` | Probe prerequisites (git, repo, origin, gh, policy) | gh auth only | 0 · 3 |

Plus `--version` and `--help` (exit 0; usage errors exit 2).

## Exit-code contract

| Code | Meaning |
| --- | --- |
| `0` | Success / **accepted** (all gates passed with evidence) |
| `1` | **Rejected** with complete evidence (all evidence gathered, ≥1 gate failed) |
| `2` | Usage error (bad flags, invalid arguments) |
| `3` | Fail-closed **unknown** — evidence could not be gathered: record/policy missing or invalid, provider missing or unauthenticated, transport failure, not a git repository |

The distinction between `1` and `3` is contractual: `1` means the evidence was gathered and says no; `3` means no verdict is possible. Automation should treat them differently.

## Global flags

- `--json` — available on every command. stdout becomes a single valid JSON document (the envelope below); all human-readable text goes to stderr.

## `specgit init`

Creates `spec_git/policy.yaml`. Refuses to overwrite an existing policy.

```bash
specgit init --required-check "All checks passed"
specgit init --required-check build --required-check test    # repeatable
```

| Flag | Meaning |
| --- | --- |
| `--required-check <name>` | A CI check name every delivery must pass. Repeatable; required in non-interactive terminals. |

Creates the policy file and nothing else — SpecGit generates no skills, commands, or instructions.

## `specgit bind`

Creates or updates `.specgit.yaml` at the repository root. The execution context is **auto-resolved from live git**; no context flags exist.

```bash
specgit bind --delivery add-login-flow --issue 123
specgit bind --issue 124            # merges into issues
specgit bind --pr 42                # sets/replaces the PR
```

| Flag | Meaning |
| --- | --- |
| `--delivery <kebab-id>` | Delivery id. Accepted only on the first bind. |
| `--issue <n>` | GitHub issue number or full issue URL. Repeatable. New values merge with existing ones, deduplicated, first-seen order kept. Opaque tracker ids (e.g. `JIRA-123`) are rejected (`issue_ref_not_github`). |
| `--pr <ref>` | Pull request number or URL. Replaces any previous value. At most one PR per delivery. |

Exits `3` outside a git repository (`not_a_git_repo`). Never calls the network — bind is local-only.

## `specgit unbind`

Deletes `.specgit.yaml` for the current checkout.

```bash
specgit unbind --yes
```

Requires `--yes`; there is no interactive prompt. The policy is untouched.

## `specgit status`

Reports local evidence only — record, policy, live git context, upstream drift, origin — with **zero network calls**. Safe to run anywhere, any time. Exit `0` when record and policy are locally valid, `3` when they are missing/invalid or the directory is not a git repo.

```bash
specgit status --json
```

## `specgit accept`

Runs the full ten-gate evaluation (record → policy → completeness → context → origin → provider → issues → PR → closing refs → checks). Checks are verified at the **PR head commit**, via `gh`.

```bash
specgit accept            # human-readable verdict
specgit accept --json     # machine-readable verdict
```

Exit semantics: `0` accepted · `1` rejected with complete evidence · `3` cannot determine (missing record/policy, `gh` absent or unauthenticated, transport failure). See [Reference](reference.md) for the gate table and every code, and [Troubleshooting](troubleshooting.md) for fixes.

## `specgit doctor`

Probes prerequisites and reports the first failing probe with a remediation: git present → inside a repository → `origin` parses to `owner/repo` → `gh` present → `gh` authenticated → policy present.

```bash
specgit doctor --json
```

Exit `0` when all probes pass, otherwise `3`.

## JSON envelope

Every `--json` invocation writes exactly one JSON document to stdout:

```json
{
  "tool": "specgit",
  "version": "1.0.0",
  "command": "accept",
  "status": "rejected",
  "state": "bound",
  "verdict": {
    "accepted": false,
    "gates": [
      {
        "id": "closing",
        "status": "fail",
        "code": "closing_refs_incomplete",
        "detail": { "missing": [124] },
        "fix": "Add \"Closes #124\" to the PR body"
      }
    ],
    "evidence": {
      "repo": "LeXwDeX/SpecGit",
      "branch": "feat/123-login",
      "context": { "kind": "branch" },
      "pr": 42,
      "prHead": "abc123…"
    }
  },
  "errors": [
    {
      "severity": "error",
      "code": "closing_refs_incomplete",
      "message": "PR 42 does not close issue #124",
      "target": "pr:42",
      "fix": "Add \"Closes #124\" to the PR body"
    }
  ]
}
```

Fields:

- `status` — `ok` | `rejected` | `unknown` | `error`
- `state` — derived delivery state: `unbound` | `draft` | `bound` | `accepted` | `rejected` | `unknown`
- `verdict.gates[]` — one entry per evaluated gate with `id`, `status`, failure `code`, structured `detail`, and a `fix`
- `verdict.evidence` — the facts the verdict was derived from (repo, branch, context, PR, PR head SHA)
- `errors[]` — diagnostics with `severity`, `code`, `message`, `target`, `fix`

In `--json` mode nothing else touches stdout; parse the whole document, not fragments.
