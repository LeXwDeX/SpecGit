# CLI Reference

The `specgit` CLI has ten commands. The human story is `issue` → `finish`; `setup` installs agent entry points; `bind`/`unbind`/`accept` are machine aliases for scripts. All evaluation is evidence-derived and fail-closed: commands either report verified facts or report why they cannot.

## Command summary

| Command | Purpose | Network | Exit codes |
| --- | --- | --- | --- |
| `specgit init` | Create the project policy and generate the harness | gh (protection probe) | 0 · 2 · 3 |
| `specgit setup` | Install agent entry points (commands for opencode, portable skills for other tools) | no | 0 · 2 · 3 |
| `specgit issue` | One-command delivery bootstrap (issues, branch, draft PR, record, commit, push) | yes | 0 · 2 · 3 |
| `specgit finish` | The verdict — full evaluation against git + GitHub | yes | 0 · 1 · 2 · 3 |
| `specgit pr` | Repair the PR binding (auto-discover by head branch, or bind explicitly) | yes | 0 · 2 · 3 |
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
| `130` | **Interruption exception** — Ctrl-C (SIGINT) during an interactive prompt. The process prints `Interrupted.` to stderr and exits 130. |

The distinction between `1` and `3` is contractual: `1` means the evidence was gathered and says no; `3` means no verdict is possible. Automation should treat them differently.

`130` is the single interruption exception and sits outside the JSON envelope contract: on that path stdout stays empty — no envelope is emitted — which is the documented, deterministic behavior. Automation should treat `130` as "interrupted, no verdict", distinct from both `1` and `3`.

## Global flags

- `--json` — available on every command. stdout becomes a single valid JSON document (the envelope below); all human-readable text goes to stderr. The one exception is the [Ctrl-C `130` interruption](#exit-code-contract), which emits no envelope.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `SPECGIT_GH` | Path to the `gh` executable used for all GitHub evidence. Resolved per invocation; defaults to `gh` on `PATH`. Useful for testing against a scripted `gh`. |
| `SPECGIT_GH_TIMEOUT_MS` | Per-call timeout for `gh` invocations, in milliseconds. Defaults to `15000` (15 s). Raise it on slow networks; the timeout is what turns a hung call into `gh_transport` (exit 3). |

These are the only SpecGit-specific environment inputs. Standard `NO_COLOR`/`CI` detection also applies. No tokens are ever read from the environment — authentication is your existing `gh` session.

## `specgit init`

Creates `spec_git/policy.yaml` (write-once; refuses to overwrite) and generates the delivery harness. Initialization is non-destructive:

- **Validation before mutation.** Every check that can reject the run — flag validation, `--gitlab-host` validation, `policy_exists`, and a root-writability preflight — happens before any filesystem or remote change. A rejected init leaves the repository byte-identical (no probes, no writes).
- **Error-atomic harness writes.** All harness targets are computed first; if any write fails mid-sequence, prior writes are rolled back (bytes and modes restored, created files/directories removed) and init exits 3.
- **Hooks are merged, never overwritten.** An existing `.opencode/hooks.json` keeps every user entry and unknown key; the specgit guard entry is added once (an unparseable file is left untouched with a `hooks_json_unmerged` warning). A user-owned git `pre-push` hook is preserved verbatim with the specgit guard appended inside managed markers; the hook installs into the directory `git rev-parse --git-path hooks` resolves, so linked worktrees and `core.hooksPath` (husky/lefthook) behave correctly.
- **Re-init semantics.** Running `init` again with an existing policy exits 2 (`policy_exists`) having written nothing and probed nothing; `specgit init --force` rebuilds the policy and refreshes the harness (the managed block region is replaced, drift in generated artifacts repaired).
- **Workflow template selection.** The SpecGit repository itself (root package name `specgit`) keeps the local-build template; every other (adopting) repository gets the portable external template: it installs the published CLI at the exact running version (`specgit@<version>`, no ranges), sets up only Node at the engine floor, parameterizes the adopting repo's remote default branch, and never assumes the adopting project's toolchain, lockfile, layout, or build. An unresolvable remote default branch falls back to `main` with a `default_branch_unresolved` warning. The `--json` envelope reports the choice as `harness.template` (`self` | `external`).

Artifacts:

- `.github/workflows/specgit-accept.yml` — the job **SpecGit Acceptance**. In the self template it runs the local build and `node bin/specgit.js finish --json`; in the external template it installs the pinned published CLI and runs `npx --no-install specgit finish --json`. Both wait for sibling checks to reach a terminal state first (through the authenticated `gh` CLI). The workflow is never listed in `policy.required_checks` (self-deadlock avoidance).
- a managed prompt block `<!-- specgit:block:start --> … <!-- specgit:block:end -->` injected into `AGENTS.md` (created if missing) and `CLAUDE.md` (only if present). A harness rewrite replaces only the block region.

```bash
specgit init                       # auto-detect required checks from CI files
specgit init --required-check build --required-check test    # repeatable
```

| Flag | Meaning |
| --- | --- |
| `--required-check <name>` | A CI check name every delivery must pass (the exact check-run name). Repeatable. Omitted: names are auto-detected from CI files; a repository with no CI at all gets an empty list — the acceptance job itself, enforced through branch protection, is then the gate (a fallback name the harness cannot produce would deadlock the wait step). |
| `--gitlab-host <hostname>` | Declare the origin's platform as GitLab on a self-hosted instance (bare hostname, must match the origin host; rejected for github.com origins). Persists to `spec_git/providers.yaml`. |
| `--protect` | Enable branch protection + auto-merge without asking. |
| `--no-protect` | Skip the protection probe and warning entirely. |

**Detection trust boundary.** Auto-detected checks are suggestions until proven on a PR head. Only workflows whose triggers include `pull_request` (or `pull_request_target`, which also reports its check runs on the PR head) contribute required-check candidates; a workflow with an omitted `on` keeps GitHub's default triggers (push and pull_request) and qualifies. Push-triggered workflows (branch-filtered or not), scheduled jobs, and dispatch-only workflows never report check runs on a PR head, so their jobs are never armed as required checks — a policy that named them could only produce a permanent `checks_missing` ([#121](https://github.com/LeXwDeX/SpecGit/issues/121)). When such workflows exist, `init` warns (`checks_not_pr_visible`) listing them in `detected.nonPrWorkflows`; name a job explicitly with `--required-check` only if it genuinely reports on PR heads.

**Platform mode.** `init` resolves a platform: a `github.com` origin defaults to GitHub; any other origin asks on an interactive terminal (GitHub or GitLab) or takes an explicit `--gitlab-host`. The declaration persists in `spec_git/providers.yaml` (`gitlab.host` bare hostname, `gitlab.insecure_ssl` reserved for the glab roadmap) and is committed, so the team shares one declaration. Origin classification (`parseRepoRef`, the evaluator, `doctor`, `status`) honors the declared host: matching origins report `gitlab_unsupported` instead of the generic `origin_unresolvable`. An undeclared non-github origin leaves mode `undecided` with a `platform_undecided` warning; the `--json` envelope carries a `platform` section (`{ mode, gitlabHost? }`). Evidence providers are the official CLIs only — `gh` for GitHub, `glab` for GitLab (see [gitlab-support.md](gitlab-support.md)).

After writing the policy and harness, `init` probes the default branch through `gh`: if the check `SpecGit Acceptance` is not a required status check there, the acceptance gate can be bypassed by a direct push or merge — `init` warns. On an interactive terminal it asks for confirmation (default yes) and, when confirmed (or with `--protect` from scripts), requires `SpecGit Acceptance` on the default branch and enables repository auto-merge. The protection update is read-modify-write and never weakens governance: existing required checks, pull-request reviews (including dismissal rules), push restrictions, and admin enforcement are read first and preserved, with `SpecGit Acceptance` the only addition; the reported fact comes from the server's post-update payload. Without a TTY it only warns (exit 0) and the `--json` envelope carries a `protection` section with non-weakening fix guidance (the settings-UI path that preserves existing rules); pass `--protect` to apply it from scripts. Protection is a guardrail, not a gate: provider or permission failures leave `init` succeeding with `protection.action: "unavailable"` and the remote unchanged.

## `specgit setup`

Installs the agent entry points — the pieces that make AI coding agents first-class SpecGit users. Complements `init` (which creates the policy and harness); idempotent, safe to re-run.

```bash
specgit setup                 # auto-detect the tool
specgit setup --tool opencode # commands for opencode only
specgit setup --tool generic  # portable skills for any tool
specgit setup --tool all      # everything
```

| Flag | Meaning |
| --- | --- |
| `--tool <tool>` | `opencode` \| `generic` \| `all`. Omit to auto-detect (opencode when `.opencode/` exists, otherwise generic). |

`opencode` installs command entry points under `.opencode/command/`; `generic` installs the portable skills (see [`skills/`](../skills/README.md)) that work with any agent that reads files. Exits `2` for an unknown tool (`setup_tool_invalid`), `3` outside a git repository or on write failure.

## `specgit issue`

The one-command bootstrap: create/reuse N issues (one issue = one independently verifiable WHY), create the branch `<type>/<first-issue#>-<slug>`, open a draft PR whose body is a deterministic scaffold — the `Closes #n` line for every bound issue, then Why / What changed / Evidence / Checklist sections — write `.specgit.yaml`, commit, and push. Re-running resumes: completed steps (record with issues → branch → PR → commit → push) are detected and skipped, so a failure between steps heals on the next invocation.

The scaffold is a pure function of the bound issues: the same binding always renders the identical body, and the renderer reads none of the adopting repository's files — the repository keeps full ownership of its own pull-request templates (an explicit body means GitHub never applies them). The closing references come first, so a later edit cannot hide them; the section placeholders are advisory and add no gate. The body is written exactly once, at draft creation: resume and `specgit pr` repair bind or adopt the existing PR and never edit its body, so user edits survive every re-run.

Resume matches the arguments onto the record positionally, split by record completeness. A **partial** record (issues recorded, no PR yet) continues issue creation from the first unconsumed argument — numeric arguments for consumed positions must match the bound issues. A **complete** record (PR bound) is a finished bootstrap: re-running with no arguments or with the original arguments is a healing no-op (commit/push only), while **more arguments than bound issues is drift** — `issue_resume_drift`, exit 2, refused with zero side effects (no issue or PR probes or creates, `.specgit.yaml` left byte-identical). Fewer arguments than bound issues, and numeric arguments not among the bound issues, are drift on any record. A record whose PR already **merged** is completed history, not an active delivery: it is replaced, not resumed — replacement arguments are validated first, then the record is deleted and a fresh delivery bootstraps.

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

Diagnostics: `issue_args_required` / `issue_title_empty` / `issue_resume_drift` (exit 2; drift is refused before any probe or create, with zero side effects); `pr_ambiguous` when several open PRs share the head branch (exit 3, fix: `specgit pr <number>`); provider failures (`gh_missing`, `gh_unauthenticated`, `gh_transport`), `no_origin`, `record_write_failed`, `git_branch_failed`, `git_commit_failed`, `git_push_failed` (exit 3, resumable).

## `specgit finish`

The verdict command of the human story — the CI gate (`.github/workflows/specgit-accept.yml`) runs it with `--json` on every PR. Runs the full eleven-gate evaluation (record → policy → completeness → context → origin → provider → issues → sequence → PR → closing refs → checks) through the same fail-closed evaluator as `accept`; checks are verified at the **PR head commit**, via `gh`.

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

Reports local evidence only — record, policy, live git context, upstream drift, origin — with **zero network calls**. Safe to run anywhere, any time.

```bash
specgit status --json
```

Normative exit table:

| Condition | Exit |
| --- | --- |
| The status snapshot was computed (record present and valid) | `0` |
| Usage error | `2` |
| Not a git repository / git unavailable (`not_a_git_repo`, `git_unavailable`) | `3` |
| Record missing (`record_missing`; reported with state `unbound`) or invalid (`record_invalid`) | `3` |

Policy and context problems discovered along the way (`policy_missing`, `policy_invalid`, `branch_mismatch`, …) are reported as gate results in the output but do not change the exit code: `status` answers "what does the local evidence say", not "is the delivery acceptable".

## `specgit accept`

Script/CI alias of `specgit finish`: the identical eleven-gate evaluation and exit codes, differing only in the envelope's `command` field. Prefer `finish` in human flows and new automation; `accept` stays stable for existing scripts.

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
