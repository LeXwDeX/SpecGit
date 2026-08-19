# CLI Reference

The `specgit` CLI has nine commands. The human story is `issue` → `finish`; `bind`/`unbind`/`accept` are machine aliases for scripts. All evaluation is evidence-derived and fail-closed: commands either report verified facts or report why they cannot.

## Command summary

| Command | Purpose | Network | Exit codes |
| --- | --- | --- | --- |
| `specgit issue` | One-command delivery bootstrap (issues, branch, draft PR, record, commit, push) | yes | 0 · 2 · 3 |
| `specgit finish` | The verdict — full evaluation against git + GitHub | yes | 0 · 1 · 2 · 3 |
| `specgit pr` | Repair the PR binding (auto-discover by head branch, or bind explicitly) | yes | 0 · 2 · 3 |
| `specgit init` | Create the project policy and generate the harness | no | 0 · 2 · 3 |
| `specgit bind` | Create/update the delivery record (`.specgit.yaml`) — script alias | no | 0 · 2 · 3 |
| `specgit unbind` | Delete the delivery record — script alias | no | 0 · 2 |
| `specgit status` | Local evidence only (record, policy, git facts, drift) | no | 0 · 2 · 3 |
| `specgit accept` | Same evaluation as `finish` — script/CI alias | yes | 0 · 1 · 2 · 3 |
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

Creates `spec_git/policy.yaml` (write-once; refuses to overwrite) and generates the delivery harness idempotently:

- `.github/workflows/specgit-accept.yml` — the job **SpecGit Acceptance** runs `node bin/specgit.js finish --json` with `GH_TOKEN: ${{ github.token }}`. The workflow is never listed in `policy.required_checks` (self-deadlock avoidance).
- a managed prompt block `<!-- specgit:block:start --> … <!-- specgit:block:end -->` injected into `AGENTS.md` (created if missing) and `CLAUDE.md` (only if present). Re-running `init` rewrites only the block.

```bash
specgit init --required-check "All checks passed"
specgit init --required-check build --required-check test    # repeatable
```

| Flag | Meaning |
| --- | --- |
| `--required-check <name>` | A CI check name every delivery must pass. Repeatable; required in non-interactive terminals. |
| `--gitlab-host <hostname>` | Declare the origin's platform as GitLab on a self-hosted instance (bare hostname, must match the origin host; rejected for github.com origins). Persists to `spec_git/providers.yaml`. |
| `--protect` | Enable branch protection + auto-merge without asking. |
| `--no-protect` | Skip the protection probe and warning entirely. |

**Platform mode.** `init` resolves a platform: a `github.com` origin defaults to GitHub; any other origin asks on an interactive terminal (GitHub or GitLab) or takes an explicit `--gitlab-host`. The declaration persists in `spec_git/providers.yaml` (`gitlab.host` bare hostname, `gitlab.insecure_ssl` reserved for the glab roadmap) and is committed, so the team shares one declaration. Origin classification (`parseRepoRef`, the evaluator, `doctor`, `status`) honors the declared host: matching origins report `gitlab_unsupported` instead of the generic `origin_unresolvable`. An undeclared non-github origin leaves mode `undecided` with a `platform_undecided` warning; the `--json` envelope carries a `platform` section (`{ mode, gitlabHost? }`). Evidence providers are the official CLIs only — `gh` for GitHub, `glab` for GitLab (see [gitlab-support.md](gitlab-support.md)).

After writing the policy and harness, `init` probes the default branch through `gh`: if the check `SpecGit Acceptance` is not a required status check there, the acceptance gate can be bypassed by a direct push or merge — `init` warns. On an interactive terminal it asks for confirmation (default yes) and, when confirmed, requires `SpecGit Acceptance` on the default branch and enables repository auto-merge. Without a TTY it only warns (exit 0) and the `--json` envelope carries a `protection` section with the exact `gh api` command as the fix; pass `--protect` to apply it from scripts. Protection is a guardrail, not a gate: provider or permission failures leave `init` succeeding with `protection.action: "unavailable"`.

## `specgit issue`

The one-command bootstrap: create/reuse N issues (one issue = one independently verifiable WHY), create the branch `<type>/<first-issue#>-<slug>`, open a draft PR whose body says `Closes #n` for every issue, write `.specgit.yaml`, commit, and push. Re-running resumes: completed steps (record with issues → branch → PR → commit → push) are detected and skipped, so a failure between steps heals on the next invocation.

```bash
specgit issue "feat: add login" "Harden the session model"   # two new issues, one delivery
specgit issue 4 "Extend the harness"                          # reuse #4, create one
specgit issue                                                 # resume an incomplete bootstrap (no args + no record → exit 2)
```

Each positional argument is a quoted title (a new issue is created from a required/optional template) or a pure number (an existing issue is reused). Every new title must match `<type>: <english title>`: `<type>` is validated against a fixed whitelist (`feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `chore`, `style`, `build`, `ci`, `revert`, `security`, `deprecate`, `dogfood`) and the title body must be English (printable ASCII). A missing or unknown type, or a non-English title, is a usage error (exit 2) listing the valid types; all titles are validated before any issue is created. The slug is kebab-case from the first three ASCII words of the title, falling back to `issue<N>` when there are none. The PR base is the remote's default branch (`origin/HEAD`, `main` fallback).

```json
{
  "tool": "specgit",
  "version": "1.0.0",
  "command": "issue",
  "status": "ok",
  "state": "bound",
  "record": {
    "version": 1,
    "delivery": "add-login",
    "context": { "kind": "branch", "branch": "feat/11-add-login" },
    "issues": [11, 12],
    "pr": 77
  }
}
```

Diagnostics: `issue_args_required` / `issue_title_empty` / `issue_resume_drift` (exit 2); provider failures (`gh_missing`, `gh_unauthenticated`, `gh_transport`), `no_origin`, `record_write_failed`, `git_branch_failed`, `git_commit_failed`, `git_push_failed` (exit 3, resumable).

## `specgit finish`

The verdict command of the human story — the CI gate (`.github/workflows/specgit-accept.yml`) runs it with `--json` on every PR. Runs the full ten-gate evaluation (record → policy → completeness → context → origin → provider → issues → PR → closing refs → checks) through the same fail-closed evaluator as `accept`; checks are verified at the **PR head commit**, via `gh`.

```bash
specgit finish            # human-readable verdict
specgit finish --json     # machine-readable verdict (what CI parses)
```

Exit semantics: `0` accepted · `1` rejected with complete evidence · `3` cannot determine (missing record/policy, `gh` absent or unauthenticated, transport failure). See [Reference](reference.md) for the gate table and every code, and [Troubleshooting](troubleshooting.md) for fixes.

## `specgit pr`

Repairs the PR binding of the current delivery. Without arguments it auto-discovers the open pull request whose head is the record's branch: exactly one candidate binds; zero fails with a fix; several refuse and list. With an explicit number or URL the PR binds directly without contacting GitHub.

```bash
specgit pr                 # auto-discover by head branch
specgit pr 42              # bind explicitly
```

Diagnostics: `pr_not_found` (zero candidates, with fix), `pr_ambiguous` (several candidates, with the list), `record_missing` (nothing to repair — run `specgit issue` first); all exit 3.

## `specgit bind`

Script alias: creates or updates `.specgit.yaml` at the repository root, one field at a time (`specgit issue` is the one-command form). The execution context is **auto-resolved from live git**; no context flags exist.

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

Script/CI alias of `specgit finish`: the identical ten-gate evaluation and exit codes, differing only in the envelope's `command` field. Prefer `finish` in human flows and new automation; `accept` stays stable for existing scripts.

```bash
specgit accept --json
```

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
