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
| `specgit bind` | Create/update the delivery record (`.specgit.yaml`) — script alias; carries the rewrite into git (#299) | git push (no forge) | 0 · 2 · 3 |
| `specgit unbind` | Delete the delivery record — script alias | no | 0 · 2 |
| `specgit status` | Local evidence only (record, policy, git facts, drift) | no | 0 · 2 · 3 |
| `specgit accept` | Same evaluation as `finish` — script/CI alias | yes | 0 · 1 · 2 · 3 |
| `specgit doctor` | Probe prerequisites (git, repo, origin, gh, policy) | forge auth (platform CLI: gh or glab) | 0 · 3 |

Plus `--version` and `--help` (exit 0; usage errors exit 2).

## Exit-code contract

| Code | Meaning |
| --- | --- |
| `0` | Success / **accepted** (all gates passed with evidence) |
| `1` | **Rejected** with complete evidence (all evidence gathered, ≥1 gate failed) |
| `2` | Usage error (bad flags, invalid arguments) |
| `3` | Fail-closed **unknown** — evidence could not be gathered: record/policy missing or invalid, provider missing or unauthenticated, transport failure, not a git repository. One documented exception: `specgit status` reports a *missing* record as the healthy pre-binding state — exit `0` with state `unbound` (#175); only an *invalid* record fails closed there. |
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
| `SPECGIT_GLAB` | Path to the `glab` executable used by the GitLab provider adapter (#114). Resolved per invocation; defaults to `glab` on `PATH`. Useful for testing against a scripted `glab`. |
| `SPECGIT_GLAB_TIMEOUT_MS` | Per-call timeout for `glab` invocations, in milliseconds. Defaults to `15000` (15 s). A timeout is `glab_transport` (exit 3). |

These are the only SpecGit-specific environment inputs. Standard `NO_COLOR`/`CI` detection also applies. No tokens are ever read from the environment — authentication is your existing `gh` (or, for the GitLab adapter, `glab`) session.

## Language configuration

Generated text is language-configurable ([#118](https://github.com/LeXwDeX/SpecGit/issues/118)); the machine contract is not. The optional `language` key in `spec_git/policy.yaml` selects the language of **generated** text — `en` (default; the key may be absent) or `zh`:

- the issue-body scaffold and the draft-PR body scaffold written by `specgit issue` (the closing references `Closes #n` stay English — they are provider grammar, not prose);
- the managed guidance block `specgit init` injects into `AGENTS.md` / `CLAUDE.md`;
- success-path human prose on stderr (`specgit issue` / `pr` / `bind` / `unbind` / `status` / `setup` / `init` summaries, the `finish` headline).

Set it at init time (`specgit init --language zh`) or edit the policy in a reviewed PR; `init --force` inherits the existing policy's language unless `--language` overrides it. An unsupported value fails closed (`policy_invalid`) — the strict policy schema lists the supported values in its diagnostic. The supported set is exactly `en`, `zh`; adding a language is a catalog addition in `src/i18n/language.ts`, not a policy-format change.

Branch names stay ASCII under every language. An ASCII title yields the first-three-words kebab slug; a title that yields no slug never falls back to `issue<N>` (#246) — `specgit issue` asks for a kebab-case delivery name, as described in the command section below.

**Never localized, under every configuration** (the machine contract):

- exit codes (`0`/`1`/`2`/`3`/`130`) and `--json` envelope field names;
- diagnostic `code` values — and, in 1.0.0, diagnostic prose (`message`/`fix`, warnings, gate and doctor probe lines): the evidence vocabulary stays greppable and locale-independent;
- the closing-reference keywords (`Closes #n`);
- generated machine artifacts: the acceptance workflow YAML, the guard hook scripts, and conventional-commit messages.

## `specgit init`

Creates `spec_git/policy.yaml` (write-once; refuses to overwrite) and generates the delivery harness. Initialization is non-destructive:

- **Validation before mutation.** Every check that can reject the run — flag validation, `--gitlab-host` validation, `policy_exists`, and a root-writability preflight — happens before any filesystem or remote change. A rejected init leaves the repository byte-identical (no probes, no writes).
- **Error-atomic local writes (#62/#305).** The harness write, the policy write, and the managed `.gitignore` region run inside ONE reversible transaction: all targets are computed first, every mutation is snapshotted (bytes and mode), and if any step fails mid-sequence every prior local mutation is rolled back — including a `spec_git/providers.yaml` declaration persisted earlier in the same run (directories the run created are removed too, so the tree — not just the files — round-trips) — and init exits 3. A failed upgrade never leaves a mixed-version tree, and never a silent one either: a pre-run state that cannot be read fails before any mutation (`providers_snapshot_failed`), and a compensation that cannot complete is reported alongside the triggering failure (`providers_restore_failed`).
- **Hooks are merged, never overwritten.** An existing `.opencode/hooks.json` keeps every user entry and unknown key; the specgit guard entry is added once (an unparseable file is left untouched with a `hooks_json_unmerged` warning). A user-owned git `pre-push` hook is preserved verbatim with the specgit guard appended inside managed markers; the hook installs into the directory `git rev-parse --git-path hooks` resolves, so linked worktrees and `core.hooksPath` (husky/lefthook) behave correctly.
- **Re-init semantics — version-upgrade convergence (#305).** Running `init` again with an existing policy exits 2 (`policy_exists`) having written nothing and probed nothing; `specgit init --force` is the supported upgrade operation: it converges the repository to the running version's complete desired init-owned asset set. The policy is rebuilt, the managed block region is replaced, drift in generated artifacts is repaired, an existing managed `.gitignore` region is reconciled to the current entry set (entries a newer version requires appear inside the region; unrelated rules outside it are preserved), and obsolete SpecGit-owned assets are REMOVED — for example, a refresh that declares GitLab removes the old SpecGit-generated GitHub acceptance workflow. Removal happens only when SpecGit ownership is proven by the asset's content (the acceptance-workflow markers); a file at a managed path that does not prove ownership is preserved byte-identically and reported. The `--json` envelope carries the decisions as `reconciled: { created, updated, removed, preserved }`; a converged re-run reports empty lists and touches nothing.
- **Local-asset shielding (#292).** By default `init` maintains a managed, idempotent region in the root `.gitignore` that shields the local delivery assets (`/.specgit.yaml`, `/spec_git/`), so record rewrites and policy regens never leak into unrelated commits. The region is delimited by `# >>> specgit: local delivery assets … >>>` / `# <<< … <<<` markers and reconciled on every init (an older single-marker region, or a damaged region that lost its end marker, is upgraded in place by consuming only the marker and the entry lines SpecGit knows it wrote — a user rule glued directly beneath keeps its bytes and position); content outside the region is preserved byte-for-byte, and a file that already lists every current entry without any marker is left untouched (never duplicated). Reported in the envelope as `ignore: { path, entries, created }`. `.gitignore` only hides **untracked** files — the bootstrap's own binding commit force-carries the record (and, when present, the policy and providers files) into git on the delivery branch, which is where the CI verdict reads them; repositories that prefer the classic committed model pass `--no-ignore`.
- **Workflow template selection.** The SpecGit repository itself (root package name `specgit`) keeps the local-build template; every other (adopting) repository gets the portable external template: it installs the published CLI at the exact running version (`specgit@<version>`, no ranges), sets up only Node at the engine floor, parameterizes the adopting repo's remote default branch, and never assumes the adopting project's toolchain, lockfile, layout, or build. An unresolvable remote default branch falls back to `main` with a `default_branch_unresolved` warning. The `--json` envelope reports the choice as `harness.template` (`self` | `external`).

Artifacts:

- `.github/workflows/specgit-accept.yml` — the job **SpecGit Acceptance**. In the self template it runs the local build and `node bin/specgit.js finish --json`; in the external template it installs the pinned published CLI and runs `npx --no-install specgit finish --json`. Both wait for sibling checks to reach a terminal state first (the self template polls the check-runs REST API with the workflow's `GITHUB_TOKEN`; the external template shells out to the authenticated `gh` CLI). The workflow is never listed in `policy.required_checks` (self-deadlock avoidance).
- a managed prompt block `<!-- specgit:block:start --> … <!-- specgit:block:end -->` injected into `AGENTS.md` (created if missing) and `CLAUDE.md` (only if present). A harness rewrite replaces only the block region.

```bash
specgit init                       # auto-detect required checks from CI files
specgit init --required-check build --required-check test    # repeatable
```

| Flag | Meaning |
| --- | --- |
| `--required-check <name>` | A CI check name every delivery must pass (the exact check-run name). Repeatable. Omitted: names are auto-detected from CI files; a repository with no CI at all gets an empty list — the acceptance job itself, enforced through branch protection, is then the gate (a fallback name the harness cannot produce would deadlock the wait step). |
| `--gitlab-host <hostname>` | Declare the origin's platform as GitLab on a self-hosted instance (bare hostname, or `host:port` when the instance uses a non-default port; must match the origin endpoint; rejected for github.com origins). Persists to `spec_git/providers.yaml`. |
| `--language <lang>` | Language of generated text: `en` \| `zh` (default `en`). Persists to the policy's `language` key (non-default only); renders the managed guidance block and the run's human summary. Rejected before any write on unsupported values (`language_invalid`, exit 2). See [Language configuration](#language-configuration). |
| `--no-ignore` | Skip the managed `.gitignore` block that shields the local delivery assets (`/.specgit.yaml`, `/spec_git/`); keep the classic committed model instead. |
| `--protect` | Enable branch protection + auto-merge without asking. |
| `--no-protect` | Skip the protection probe and warning entirely. |

**Detection trust boundary.** Auto-detected checks are suggestions until proven on a PR head. Only workflows whose triggers include `pull_request` (or `pull_request_target`, which also reports its check runs on the PR head) contribute required-check candidates; a workflow with an omitted `on` keeps GitHub's default triggers (push and pull_request) and qualifies. Push-triggered workflows (branch-filtered or not), scheduled jobs, and dispatch-only workflows never report check runs on a PR head, so their jobs are never armed as required checks — a policy that named them could only produce a permanent `checks_missing` ([#121](https://github.com/LeXwDeX/SpecGit/issues/121)). When such workflows exist, `init` warns (`checks_not_pr_visible`) listing them in `detected.nonPrWorkflows`; name a job explicitly with `--required-check` only if it genuinely reports on PR heads.

**Platform mode.** `init` resolves a platform: a `github.com` origin defaults to GitHub; any other origin asks on an interactive terminal (GitHub or GitLab) or takes an explicit `--gitlab-host`. The declaration persists in `spec_git/providers.yaml` (`gitlab.host` bare hostname, optional `gitlab.port` for a non-default port, `gitlab.insecure_ssl` reserved for the glab roadmap) and is committed, so the team shares one declaration. Origin classification (`parseRepoRef`, the evaluator, `doctor`, `status`) honors the declared endpoint: matching origins resolve through the GitLab origin grammar — `group[/subgroup…]/project` at depth 2–5, `%2F`-encoded separators included (#112) — and, since #117, route: the production composition's provider dispatches on the platform marker, so a declared GitLab origin's evidence (issues, MRs, pipelines) flows through `glab` while GitHub origins keep flowing through `gh`; `init` on gitlab mode writes no GitHub Actions workflow (`gitlab_harness_pending` warns; the repo carries its own `.gitlab-ci.yml`, whose top-level job keys are detected as required checks). Explicit ports follow the #78 rule: a port equal to the scheme default (`:443` https, `:22` ssh) classifies like the portless form; any other port classifies only when the declaration names it (`host:port`). An undeclared non-github origin leaves mode `undecided` with a `platform_undecided` warning; the `--json` envelope carries a `platform` section (`{ mode, gitlabHost? }`). Evidence providers are the official CLIs only — `gh` for GitHub, `glab` for GitLab (see [gitlab-support.md](gitlab-support.md)).

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

`opencode` installs command entry points under `.opencode/command/`; `generic` installs the portable skills (see [`skills/`](../skills/README.md)) that work with any agent that reads files. Exits `2` for an unknown tool (`setup_tool_invalid`), `3` outside a git repository or on write failure. Under `--json`, the envelope carries `assets: { tool, installed }` — the tool that was installed for and the path of every written entry point.

## `specgit issue`

The one-command bootstrap: create/reuse N issues (one issue = one independently verifiable WHY), create the branch `<type>/<first-issue#>-<slug>`, open a draft PR whose body is a deterministic scaffold — the `Closes #n` line for every bound issue, then Why / What changed / Evidence / Checklist sections — write `.specgit.yaml`, commit, and push. The binding commit force-stages (`git add -f`) the authoritative delivery files (#292): the record always, plus the policy and providers files when they exist — past the default local-asset ignore, so the CI verdict on the PR head can read them. Re-running resumes: completed steps (record with issues → branch → PR → commit → push) are detected and skipped, so a failure between steps heals on the next invocation.

The scaffold is a pure function of the bound issues: the same binding always renders the identical body, and the renderer reads none of the adopting repository's files — the repository keeps full ownership of its own pull-request templates (an explicit body means GitHub never applies them). The closing references come first, so a later edit cannot hide them; the section placeholders are advisory and add no gate. The body is written exactly once, at draft creation: resume and `specgit pr` repair bind or adopt the existing PR and never edit its body, so user edits survive every re-run.

Resume matches the arguments onto the record positionally, split by record completeness. A **partial** record (issues recorded, no PR yet) continues issue creation from the first unconsumed argument — numeric arguments for consumed positions must match the bound issues. A **complete** record (PR bound, PR live) is a finished bootstrap: re-running with no arguments or with the original arguments is a healing no-op (commit/push only), while **more arguments than bound issues is drift** — `issue_resume_drift`, exit 2, refused with zero side effects (no issue or PR probes or creates, `.specgit.yaml` left byte-identical). Fewer arguments than bound issues, and numeric arguments not among the bound issues, are drift on any record. A record whose PR already **merged** is completed history, not an active delivery, and its lifecycle ends there: **no-args resume is refused** — `issue_delivery_merged`, exit 2, zero git side effects (the branch GitHub deleted on merge is never re-created or re-pushed) — while **replacement arguments re-bootstrap**: they are validated first, then the record is deleted and a fresh delivery bootstraps. The mergedness probe itself fails closed: if the PR fact cannot be gathered, the command exits 3 with the provider error and keeps the record — it never guesses "not merged" (#75).

```bash
specgit issue "feat: add login" "Harden the session model"   # two new issues, one delivery
specgit issue 4 "Extend the harness"                          # reuse #4, create one
specgit issue "feat: 添加登录" --delivery add-login           # non-ASCII title, explicit delivery name
specgit issue                                                 # resume an incomplete bootstrap (no args + no record → exit 2; no args + merged record → exit 2, issue_delivery_merged)
```

Each positional argument is a quoted title (a new issue is created from a required/optional template) or a pure number (an existing issue is reused). Every new title must start with `<type>: ` where `<type>` is validated against a fixed whitelist (`feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `chore`, `style`, `build`, `ci`, `revert`, `security`, `deprecate`, `dogfood`); the title body itself may be in any language (#118). A missing or unknown type is a usage error (exit 2) listing the valid types; all titles are validated before any issue is created. The slug is kebab-case from the first three ASCII words of the title; when the title yields no slug (a non-ASCII or wordless title, or number-only arguments), bootstrap never invents a name (#246): an interactive terminal session is prompted for a kebab-case ASCII delivery name, and any other session gets a usage error (exit 2, `issue_delivery_name_required`) naming the explicit flag. `--delivery <slug>` supplies the name explicitly and wins over a derived slug; on resume the recorded name is reused without asking. The PR base is the remote's default branch (`origin/HEAD`, `main` fallback).

Before creating from a title, the bootstrap probes the open issues with one title-carrying search (paginated to exhaustion, #77): an open issue whose title exactly matches a pending title argument is that argument's issue — a previous run created it but failed to record it — and is adopted instead of duplicating the WHY. Issue titles are not unique, so an exact match binds only when it is unambiguous: a single candidate, or a sole candidate carrying the deterministic scaffold body this tool writes (`## Why (required)` … `specgit finish must exit 0`), which an unrelated human issue with the same title does not carry. An unresolvable same-title collision is the usage diagnostic `issue_title_ambiguous` (exit 2) listing every candidate — never a silent adoption of an issue that could be unrelated. The probe is skipped entirely for purely numeric arguments and fails closed (exit 3) when the evidence cannot be gathered.

```json
{
  "tool": "specgit",
  "version": "1.1.0",
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

Diagnostics: `issue_args_required` / `issue_title_empty` / `issue_resume_drift` / `issue_delivery_merged` (no-args resume of a merged delivery; fix: replacement arguments or `specgit unbind --yes`) / `issue_title_ambiguous` (several open issues share the pending title with no sole scaffold-body match; lists every candidate; fix: adopt one explicitly by number — `specgit issue <number>` — or rename the unrelated issue; exit 2 with zero side effects) / `issue_delivery_name_required` (the title yields no ASCII slug and no name was given or prompted; fix: `--delivery <slug>` or an ASCII title; exit 2 with zero side effects) / `issue_delivery_name_invalid` (the `--delivery` value is not kebab-case ASCII; exit 2) (exit 2; drift, merged-refusal, ambiguity, and naming gaps happen before any create, with zero side effects); `pr_ambiguous` when several open PRs share the head branch (exit 3, fix: `specgit pr <number>`); provider failures (`gh_missing`, `gh_unauthenticated`, `gh_transport`, `evidence_truncated` — including the mergedness probe on a PR-bound record, which fails closed and keeps the record), `no_origin`, `record_write_failed`, `git_branch_failed`, `git_commit_failed`, `git_push_failed` (exit 3, resumable).

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

**Carrying commit (#299).** The repair is not local-only anymore: after writing the record, `pr` force-carries it into git on the delivery branch (the same `git add -f` + pathspec commit the bootstrap uses, then `git push -u`) — a local-only repair would leave the CI verdict on the PR head reading a stale record. A local commit failure exits 3; a push failure downgrades to the warning `record_carry_push_failed` (offline and sandboxed environments stay usable — push when reconnected, the warning names the stale-verdict consequence); running on a branch other than the record's delivery branch skips the carry with `record_carry_skipped` and says so.

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

Exits `3` outside a git repository (`not_a_git_repo`). Never calls the forge — but since #299 `bind` carries the record rewrite into git on the current branch (`git add -f` + commit, then `git push -u`), exactly like `pr` above: local commit failure exits 3, push failure warns (`record_carry_push_failed`), and the carry runs because `bind` auto-resolves its context from live git (the current branch is the delivery branch by construction).

## `specgit unbind`

Deletes `.specgit.yaml` for the current checkout.

```bash
specgit unbind --yes
```

Requires `--yes`; there is no interactive prompt. The policy is untouched.

**Merged-delivery lifecycle (#298):** when the record is *tracked* (it is, after a delivery merged — the binding commit force-carried it), deleting the working-tree copy leaves an uncommitted deletion behind. `unbind` detects this and warns (`record_deletion_tracked`) with the fix: commit the deletion through a PR (e.g. `chore: unbind delivery`) to return the tree to clean — or simply bootstrap the next delivery, whose binding commit force-carries the rewritten record and absorbs the residue. An untracked record (the #292 default on a fresh adoption) deletes silently. The probe is advisory: `tracked_probe_failed` never blocks the unbind.

## `specgit status`

Reports local evidence only — record, policy, live git context, upstream drift, origin — with **zero network calls**. Safe to run anywhere, any time.

```bash
specgit status --json
```

Normative exit table:

| Condition | Exit |
| --- | --- |
| The status snapshot was computed (record present and valid) | `0` |
| The record is missing (`record_missing`) — the normal **pre-binding** state before `specgit issue`; reported with state `unbound` and a warning pointing at the next step (#175) | `0` |
| Usage error | `2` |
| Not a git repository / git unavailable (`not_a_git_repo`, `git_unavailable`) | `3` |
| Record invalid (`record_invalid`) | `3` |

The pre-binding split (#175): a missing record is a fully determinable,
healthy state — "no delivery bound yet" — so `status` answers it with exit
`0`, envelope `status: "ok"`, `state: "unbound"`, a failing `record` gate
(`record_missing`), and a warning carrying the fix (run `specgit issue`).
Genuine evidence failures — `record_invalid`, `policy_missing`,
`policy_invalid`, `git_unavailable`, `not_a_git_repo` — still fail closed
with exit `3` and envelope `status: "unknown"`, so the pre-binding case and
a true unknown stay distinguishable on both the exit code and the state.

Policy and context problems discovered along the way behave differently: a **missing or invalid policy fails closed** (`policy_missing`/`policy_invalid` → exit 3, listed in `errors`), while evidence *mismatches* (`branch_mismatch`, origin drift, incompleteness, …) are reported as gate results in the output but do not change the exit code: `status` answers "what does the local evidence say", not "is the delivery acceptable".

## `specgit accept`

Script/CI alias of `specgit finish`: the identical eleven-gate evaluation and exit codes, differing only in the envelope's `command` field. Prefer `finish` in human flows and new automation; `accept` stays stable for existing scripts.

```bash
specgit accept --json
```

## `specgit doctor`

Probes prerequisites and reports the first failing probe with a remediation: git present → inside a repository → `origin` parses to `owner/repo` → provider CLI present → provider CLI authenticated → policy present. The provider probes follow the delivery platform since #117: `gh` on a GitHub origin, `glab` on a GitLab-declared one (the envelope keys stay `gh_present` / `gh_authenticated`; the reported codes are the platform CLI's — `glab_missing`, `glab_unauthenticated`, …).

```bash
specgit doctor --json
```

Exit `0` when all probes pass, otherwise `3`.

## JSON envelope

Every `--json` invocation writes exactly one JSON document to stdout:

```json
{
  "tool": "specgit",
  "version": "1.1.0",
  "command": "accept",
  "status": "rejected",
  "exit": 1,
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
- `exit` — the numeric exit code the process exits with (`0` | `1` | `2` | `3`), equal to `status`' mapping; lets a piped caller read the exit code from the document itself
- `state` — derived delivery state: `unbound` | `draft` | `bound` | `accepted` | `rejected` | `unknown`
- `verdict.gates[]` — one entry per evaluated gate with `id`, `status`, failure `code`, structured `detail`, and a `fix`
- `verdict.evidence` — the facts the verdict was derived from (repo, branch, context, PR, PR head SHA)
- `errors[]` — diagnostics with `severity`, `code`, `message`, `target`, `fix`

In `--json` mode nothing else touches stdout; parse the whole document, not fragments.
