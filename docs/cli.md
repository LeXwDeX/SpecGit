# CLI Reference

The `specgit` CLI has ten commands. The human story is `issue` → `finish`; `setup` installs agent entry points; `bind`/`unbind`/`accept` are machine aliases for scripts. All evaluation is evidence-derived and fail-closed: commands either report verified facts or report why they cannot.

The delivery flow at a glance:

```text
  specgit init / setup      initialize once; rerun after upgrades
        |                   harness + agent entry points
        v
  specgit issue "..."       per delivery: issues + branch +
        |                   draft PR/MR (Closes #n) + record,
        |                   committed and pushed (idempotent resume)
        v
  work, commit, push -----> CI/CD on the request head
        |                   (the platform acceptance job runs
        |                    specgit finish --json)
        v
  mark PR/MR ready          a draft request always fails the verdict
        |
        v
  specgit finish            the verdict: eleven gates, fail-closed
        |-- exit 0 --> accepted → merge → confirmed issue closure: completed
        |-- exit 1 --> fix what the gates named (evidence complete)
        '-- exit 3 --> follow errors[].fix; use doctor for its probes
```

## Command summary

| Command | Purpose | Network | Exit codes |
| --- | --- | --- | --- |
| `specgit init` | Create the project policy and generate the harness; offer a human refresh when local inspection proves drift | routed forge protection probe when supported | 0 · 2 · 3 |
| `specgit setup` | Install agent entry points (commands for opencode, portable skills for other tools) | no | 0 · 2 · 3 |
| `specgit issue` | One-command delivery bootstrap (issues, branch, draft PR, record, commit, push) | yes | 0 · 2 · 3 |
| `specgit finish` | The verdict — full evaluation against git + the routed forge | yes | 0 · 1 · 2 · 3 |
| `specgit pr` | Repair the PR binding; `--merge` executes configured merge and issue closure | yes | 0 · 1 · 2 · 3 |
| `specgit bind` | Create/update the delivery record (`.specgit.yaml`) — script alias; carries the rewrite into git (#299) | git push (no forge) | 0 · 2 · 3 |
| `specgit unbind` | Delete the delivery record — the abandon/reset/uninstall tool; the normal post-merge continuation is the next `specgit issue`, which replaces completed history atomically | no | 0 · 2 |
| `specgit status` | Local evidence only (record, policy, git facts, drift, generated-asset drift) | no | 0 · 2 · 3 |
| `specgit accept` | Same evaluation as `finish` — script/CI alias | yes | 0 · 1 · 2 · 3 |
| `specgit doctor` | Probe prerequisites (git, repo, origin, routed forge CLI, policy) | forge auth (platform CLI: gh or glab) | 0 · 3 |

Plus `--version` and `--help` (exit 0; usage errors exit 2).

## Exit-code contract

| Code | Meaning |
| --- | --- |
| `0` | Success / **accepted** (all gates passed with evidence) |
| `1` | **Rejected** with complete evidence (all evidence gathered, ≥1 gate failed) |
| `2` | Usage error (bad flags, invalid arguments) |
| `3` | Fail-closed **unknown** — evidence could not be gathered: record/policy missing or invalid, provider missing or unauthenticated, transport failure, not a git repository. One documented exception: `specgit status` reports a *missing* record as the healthy pre-binding state — exit `0` with state `unbound` (#175); other policy or git evidence failures still exit `3`, even without a record. |
| `130` | **Interruption exception** — Ctrl-C (SIGINT) during an interactive prompt. The process prints `Interrupted.` to stderr and exits 130. |

The distinction between `1` and `3` is contractual: `1` means the evidence was gathered and says no; `3` means no verdict is possible. Automation should treat them differently.

`130` is the single interruption exception and sits outside the JSON envelope contract: on that path stdout stays empty — no envelope is emitted — which is the documented, deterministic behavior. Automation should treat `130` as "interrupted, no verdict", distinct from both `1` and `3`.

## Global flags

- `--json` — available on every command. stdout becomes a single valid JSON document (the envelope below); all human-readable text goes to stderr. The one exception is the [Ctrl-C `130` interruption](#exit-code-contract), which emits no envelope.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `SPECGIT_GH` | Path to the `gh` executable used for all GitHub evidence. Resolved per invocation; defaults to `gh` on `PATH`. Useful for testing against a scripted `gh`. |
| `SPECGIT_GH_TIMEOUT_MS` | Per-call timeout for `gh` invocations, in milliseconds. Defaults to `15000` (15 s). Raise it on slow networks; a hung call killed at the budget is `gh_timeout` (exit 3, with attributed causes). |
| `SPECGIT_GLAB` | Path to the `glab` executable used by the GitLab provider adapter (#114). Resolved per invocation; defaults to `glab` on `PATH`. Useful for testing against a scripted `glab`. |
| `SPECGIT_GLAB_TIMEOUT_MS` | Per-call timeout for `glab` invocations, in milliseconds. Defaults to `15000` (15 s). A timeout is `glab_transport` (exit 3). |
| `SPECGIT_GUARD_BUDGET_S` | **Hook-only** — read by the generated merge-guard hook (`.opencode/hooks/specgit-merge-guard.sh`), never by the CLI. Seconds; the verdict budget the guard grants `specgit finish` when it intercepts a `gh pr merge` / `glab mr merge` / direct push-to-main attempt. The default is `max(60, 8 × applicable provider timeout in seconds)` (120 s at the 15 s default), using `SPECGIT_GH_TIMEOUT_MS` for GitHub or `SPECGIT_GLAB_TIMEOUT_MS` for declared GitLab. An override never lowers the budget below that per-call provider timeout. Expiry is "no verdict" (unknown), never rejection. If the budget exceeds the hook runner timeout in `.opencode/hooks.json` with its safety margin, raise the runner timeout or lower this value. |

The first four are the only SpecGit-specific inputs the CLI reads; `SPECGIT_GUARD_BUDGET_S` is read only by the generated guard hook at verdict time. Standard `NO_COLOR`/`CI` detection also applies. No tokens are ever read from the environment — authentication is your existing `gh` (or, for the GitLab adapter, `glab`) session.

## Language configuration

Generated text is language-configurable ([#118](https://github.com/LeXwDeX/SpecGit/issues/118)); the machine contract is not. The optional `language` key in `spec_git/policy.yaml` selects the language of **generated** text — `en` (default; the key may be absent) or `zh`:

- the issue-body scaffold and the draft-PR body scaffold written by `specgit issue` (the closing references `Closes #n` stay English — they are provider grammar, not prose);
- the managed guidance block `specgit init` injects into `AGENTS.md` / `CLAUDE.md`;
- success-path human prose on stderr (`specgit issue` / `pr` / `bind` / `unbind` / `status` / `setup` / `init` summaries, the `finish` headline).
- diagnostics render exactly once each (#362): errors as `Error:` + `Fix:`, warnings as `Warning:` + `Next:` (a warning's fix is advisory guidance); success hand-offs render through the one `Next:` renderer (#360).

Set it at init time (`specgit init --language zh`) or edit the policy in a reviewed PR; `init --force` inherits the existing policy's language unless `--language` overrides it. An unsupported value fails closed (`policy_invalid`) — the strict policy schema lists the supported values in its diagnostic. The supported set is exactly `en`, `zh`; adding a language is a catalog addition in `src/i18n/language.ts`, not a policy-format change.

Branch names stay ASCII under every language. An ASCII title yields the first-three-words kebab slug; a title that yields no slug never falls back to `issue<N>` (#246) — `specgit issue` asks for a kebab-case delivery name, as described in the command section below.

**Never localized, under every configuration** (the machine contract):

- exit codes (`0`/`1`/`2`/`3`/`130`) and `--json` envelope field names;
- diagnostic `code` values and diagnostic prose (`message`/`fix`, warnings, gate and doctor probe lines): the evidence vocabulary stays greppable and locale-independent;
- the closing-reference keywords (`Closes #n`);
- generated machine artifacts: the acceptance workflow YAML, the guard hook scripts, and conventional-commit messages.

## Project title and label rules

`language` controls generated text. Optional `validation` settings additionally
check the project's live issue and PR/MR titles and issue labels (#407):

```yaml
language: en
validation:
  titles: true
  labels: kind
# tags declares the extra vocabulary allowed by kind mode, or the complete
# vocabulary allowed by project mode.
tags:
  - name: module::auth
```

| Setting | Behavior |
| --- | --- |
| `validation.titles: false` or absent | No title-language gate. The existing typed new-title syntax still applies. |
| `validation.titles: true` | Every bound issue and PR/MR title must be nonempty. For `language: en` it must contain no Unicode Han characters; for `language: zh` it must contain at least one. Technical names may remain in English. This is a character rule, not natural-language detection. |
| `validation.labels: off` or absent | Existing pool-first tagging behavior; labels do not affect acceptance. |
| `validation.labels: kind` | Every issue has exactly one built-in `kind::` label. All other labels must appear in policy `tags`; at most one member of each scoped axis is allowed. |
| `validation.labels: project` | Every issue has a nonempty label set drawn entirely from policy `tags`; at most one member of each scoped axis is allowed. The policy must declare at least one allowed label. |

The repository's mutable label pool cannot expand an enforced vocabulary.
`issue` checks new titles, adopted or reused issue facts, resume arguments, and
the resulting label sets before its first mutation. Invalid inputs exit `2`;
unavailable forge evidence exits `3`. Inferred label operations also fail
closed when label validation is enabled. `finish` checks real issue facts at G7
and the PR/MR title at G9: `title_language_mismatch` and `issue_labels_invalid`
reject with exit `1`; `title_evidence_missing` and `issue_labels_unavailable`
mean unknown evidence, exit `3`. Correct the remote facts and re-run.

The generated acceptance workflow re-evaluates PR title/body edits via the
`edited` event. Changes to an issue's title or labels require a fresh `finish`
(or the fresh evidence collected by `pr --merge`); they do not automatically
invalidate an earlier green PR check.

Configure or revise the choices with:

```bash
specgit init --force --configure-rules
specgit init --force --language en --title-check yes --label-check kind
specgit init --force --language zh --title-check yes --label-check project \
  --allowed-label kind::fix --allowed-label module::auth
```

The interactive session offers language, title validation on/off, and label mode.
For project mode, select from valid repository labels, the built-in catalog, and
existing policy declarations. Scripts supply the explicit flags; `--configure-rules`
requires a terminal and cannot be combined with `--json`. Ordinary `init --force`
preserves existing rules and vocabulary unless the corresponding options replace
them. Old policies without `validation` remain valid and unenforced.

## Selected content templates

Templates are inline policy data, so approved-policy evidence includes their
exact content rules. For example:

```yaml
validation:
  titles: true
  labels: kind
  bodies: true
templates:
  issue:
    title: "fix: {{summary}}"
    body: "## Why\n{{body}}"
    required_sections: [Why]
  pr:
    body: "## Evidence\n{{body}}"
    required_sections: [Evidence]
```

Supported variables are `title`, `summary` (without its typed prefix), `body`,
`delivery`, and `issues`. Unknown variables are usage errors; supplied content
is not recursively expanded. Repeat `--body-file <path>` once per title argument;
numeric reuse retains the remote issue body. `--pr-body-file <path>` supplies
the new PR/MR content. Resume preserves existing remote bodies.

Content checks require nonempty H2 sections and reject known TODO/TBD/scaffold
placeholders. Semantic adequacy belongs to review. Missing body evidence means
exit 3; known incomplete content means exit 1 at acceptance or exit 2 during
creation. Legacy policies retain advisory scaffolds. Refresh preserves templates
and body rules.

## Approved rules and completion

Acceptance resolves the actual target branch's current policy through Git and
the authenticated forge. Candidate policy cannot weaken its own required checks,
change its permitted target, or enable its own automatic merge. First adoption
may validate the candidate only when target-policy absence is proved; automatic
merge requires approved policy. Missing Git objects remain unknown evidence.

`finish` is read-only: exit 0 means accepted. Completion additionally requires
proven merged lineage and all bound issues confirmed closed. Merged delivery
with open issues reports `closure_pending`.

After merging a policy-changing PR, same-run closure uses the policy approved
before merge. Cross-process recovery currently proves that policy only from a
two-parent merge whose second parent matches the platform PR head. Squash,
rebase and fast-forward recovery without unique evidence returns
`policy_history_unavailable`; it cannot invent historical authorization.

Terminal failures on a ready PR/MR create repair issues for independent causes;
recurring unresolved causes reuse the repair issue. Drafts, pending checks and
superseded heads do not create repair issues. Original business issues remain
open until delivery is confirmed.

Repair labels use the saved `automation.repair_labels` selection. Without one,
the built-in `kind::fix` is used when permitted, or the sole project tag when
the vocabulary has only one choice. With multiple project choices, select the
repair labels explicitly through repeatable `--repair-label <name>` options or
interactive initialization. The selection must obey project label rules;
SpecGit never expands the project vocabulary to create a repair issue. Ordinary
refresh preserves this mapping.

## `specgit init`

Creates `spec_git/policy.yaml` and generates the delivery harness. With an
existing valid policy, explicit `--force` or a human accepting the guided
refresh can update those assets. Local initialization and refresh do not themselves start a
delivery, product build, or package release. Review any tracked changes before
choosing to share them; [CI scope](ci-scope.md) defines the required verification.
The command installs SpecGit assets without rewriting the adopting project's
business workflows, build configuration, or dependencies. It is not a local-only
mode: the generated SpecGit workflow and shared agent files can be tracked.

The write and preservation rules are:

**Automation choice.** First interactive initialization asks whether to enable
merge and issue closure: **yes/no, default no**. Ordinary `init --force` preserves
the saved choice, target and closure setting. Explicit `--automation yes|no`
changes it. Agents cannot answer yes for the user. First non-interactive init
without an answer leaves automation disabled and explains that choice on stderr.
JSON stdout remains one document.

With yes, `--merge-target <branch>` sets the permitted destination. Without
that flag, init requires evidence of the remote default branch; it never
guesses a target. The saved configuration is:

```yaml
automation:
  merge: true
  target_branch: main
  close_issues: true
```

With no, both booleans are false. Old policies without `automation` remain
valid and disabled. A forced initialization preserves the existing required
checks, language, tags, validation and ordering unless their corresponding options replace
them; automation changes only when explicitly requested.

- **Validation before mutation.** Every validation-phase check applicable to the planned run — flag validation, `--gitlab-host` validation, policy validation, provider/platform resolution, the strict remote-default-branch evidence required by workflow generation or protection, and a root-writability preflight — happens before any filesystem or remote change. A missing origin, an undecided or invalid platform, or an invalid provider declaration causes exit `3` and leaves the tree untouched. When workflow generation or protection applies, an unproved remote default branch also exits `3` before the local transaction. With a valid existing policy, plain interactive `init` may run the shared local asset inspector before deciding whether to return `policy_exists`; that inspection is read-only and makes no forge call. An incomplete or failed inspection cannot authorize the prompt or a write and falls back to `policy_exists`. A validation rejection or init-writer failure leaves the repository byte-identical; after that transaction succeeds, the separate setup phase can fail while the completed init refresh remains applied.
- **Error-atomic local writes (#62/#305/#458/#459/#460).** The harness write, the policy write, and the managed `.gitignore` region run inside ONE reversible transaction. All targets are computed first. Every repository-managed target and each existing ancestor must be a real path; a symbolic link, including a dangling link, is an `asset_conflict` and is never followed or replaced. The effective git hooks directory is the only ancestor exception because the git adapter verifies that physical boundary separately; the managed hook file itself still cannot be a symbolic link. Immediately before each whole-file write the reconciler re-reads the file, revalidates SpecGit ownership, and requires the bytes to match the merge basis used at planning. Immediately before removal it re-reads the file and proves ownership again. An intervening user edit is therefore preserved rather than overwritten or deleted. Once planning succeeds, every accepted regular-file mutation is snapshotted, and if any later step fails every prior local mutation is rolled back — including a `spec_git/providers.yaml` declaration persisted earlier in the same run (directories the run created are removed too, so the tree — not just the files — round-trips) — and init exits 3. A failed provider declaration write reports `providers_write_failed`, restores the exact pre-run declaration bytes or absence, and stops before policy or harness writes. A failed upgrade never leaves a mixed-version tree. A pre-run state that cannot be read fails before any mutation (`providers_snapshot_failed`), and a compensation that cannot complete is reported alongside the triggering failure (`providers_restore_failed`).
- **Hooks are merged, never overwritten.** An existing `.opencode/hooks.json` keeps user entries, matchers, and unknown keys; the SpecGit guard gets its own entry. Unparseable JSON or a malformed `PreToolUse` collection is preserved with `hooks_json_unmerged`. For a shell `pre-push` hook, the managed guard runs before the user's code, with push refs buffered and replayed so both receive the same input; the original script's exit behavior is preserved. Unsupported non-shell hooks cause init to refuse before local writes. The hook installs only into a physical path owned by this repository or its common Git directory. External shared directories and symlink escapes are skipped with `git_hooks_external`; other safe assets continue.
- **Re-init semantics — guided and explicit version convergence (#305/#457).** `specgit init --force --no-protect` is the deterministic asset-upgrade operation: it converges the repository to the running version's complete desired init-owned asset set without probing or changing remote protection. Plain, option-free `init` adds a human convenience when a **valid** policy already exists. In interactive, non-JSON mode it uses the shared read-only inspector and asks whether to upgrade only when a required init asset or an already installed setup surface is proven stale or missing. A deliberately absent setup surface alone does not trigger the question. Current assets do not prompt. A detected ownership conflict returns `asset_conflict` (exit 3) before any prompt or write and names the path to resolve. Yes performs the equivalent of `specgit init --force --no-protect` followed by `specgit setup --tool all`; when the inspector proves the intentionally tracked authoritative model, the init command includes `--no-ignore` and setup preserves that opt-out. This preserves every policy choice and skips an implicit remote-protection probe or change. Any configuration flag keeps the ordinary explicit path and cannot be silently promoted to `--force`. Enabling or changing automation still requires its explicit option, and changing protection requires a separate deliberate `--protect` invocation. No leaves every file untouched and returns the existing `policy_exists` guidance. Any answer other than yes/y or no/n fails with `upgrade_answer_invalid` (exit 2) before mutation. `--json` and non-TTY execution never prompt or mutate through this convenience; use the explicit sequence documented below. The init phase replaces its managed block region, repairs owned drift, reconciles the managed `.gitignore` entries, and removes obsolete assets only when ownership is proven. Unowned content at a managed path is preserved and fails closed. The `--json` envelope for explicit force carries `reconciled: { created, updated, removed, preserved }`; a converged force re-run reports empty lists and touches nothing.
- **Required-check selection on upgrade — preserve vs explicit replace (#310).** A no-argument `init --force` is a version upgrade of the generated assets, not a policy re-birth: a valid existing policy's `required_checks` and `language` are PRESERVED exactly (names and order), because auto-detection is a suggestion and must never silently replace a working policy — detection reading local CI files can produce a different or only partly provable set. The run warns `checks_preserved` and still rebuilds the versioned harness/config/ignore assets. The one intentional replacement path is explicit: `init --force --required-check <name>` (repeatable) fully replaces the list with exactly the names given. `--no-detect` refuses guessing, not preserving — with an existing policy it still upgrades by preservation; without one it keeps demanding explicit names (`required_check_required`).
- **Local-asset shielding (#292).** By default `init` maintains a managed, idempotent region in the root `.gitignore` that shields the local delivery assets (`/.specgit.yaml`, `/spec_git/`), so record rewrites and policy regens never leak into unrelated commits. The region is delimited by `# >>> specgit: local delivery assets … >>>` / `# <<< … <<<` markers and reconciled on every init (an older single-marker region, or a damaged region that lost its end marker, is upgraded in place by consuming only the marker and the entry lines SpecGit knows it wrote — a user rule glued directly beneath keeps its bytes and position); content outside the region is preserved byte-for-byte, and a file that already lists every current entry without any marker is left untouched (never duplicated). Reported in the envelope as `ignore: { path, entries, created }`. `.gitignore` only hides **untracked** files — the bootstrap's own binding commit force-carries the record (and, when present, the policy and providers files) into git on the delivery branch, which is where the CI verdict reads them; repositories that prefer the classic committed model pass `--no-ignore`.
- **Workflow template selection.** The SpecGit repository itself (root package name `specgit`) keeps the local-build template; every other (adopting) repository gets the portable external template: it installs the published CLI at the exact running version (`specgit@<version>`, no ranges), sets up only Node at the engine floor, parameterizes the adopting repo's **proved remote default branch**, and never assumes the adopting project's toolchain, lockfile, layout, or build. If `origin/HEAD` cannot provide that evidence, init exits `3` with `workflow_default_branch_unknown` before any policy, workflow, or protection write. It never falls back to `main`; an explicit automation merge target does not substitute for the trusted default-branch identity. The `--json` envelope reports the choice as `harness.template` (`self` | `external`).

Artifacts:

- `.github/workflows/specgit-accept.yml` — the job **SpecGit Acceptance**. This product repository classifies the diff before selecting product build or metadata evaluation. Metadata uses a compatible pinned published CLI without product compilation. The external template installs its pinned published CLI in an isolated prefix. Both wait for approved policy's checks at the current PR head and reviewability boundary, then run `finish --json`. The acceptance job cannot list itself in `required_checks`. See [CI scope](ci-scope.md) for runtime compatibility and verification details.
- With explicitly enabled automation, `.github/workflows/specgit-complete.yml` is a separate trusted remote executor. It validates request identity, current head, approved target rules and all current CI before merge, then confirms bound issue closure. It never executes PR source with write credentials. GitLab completion also requires a safe remote CI entry; generation alone does not establish automatic execution.
- a managed prompt block `<!-- specgit:block:start --> … <!-- specgit:block:end -->` injected into `AGENTS.md` (created if missing) and `CLAUDE.md` (only if present). A harness rewrite replaces only the block region.

```bash
specgit init                       # fresh init: auto-detect required checks from CI files
specgit init                       # existing policy: human-only guided refresh when proven drift exists
specgit init --force --no-protect  # asset upgrade: preserve checks and remote protection
specgit init --force --required-check build --required-check test   # repeatable; fully replaces the list
```

| Flag | Meaning |
| --- | --- |
| `--required-check <name>` | A CI check name every delivery must pass (the exact check-run name). Repeatable; on `init --force` the explicit list fully REPLACES the existing policy's checks — the intentional replacement path (#310). Omitted on a fresh init (no policy yet): names are auto-detected from CI files; a repository with no CI at all gets an empty list — the acceptance job itself, enforced through branch protection, is then the gate (a fallback name the harness cannot produce would deadlock the wait step). Omitted on an upgrade (`--force` with an existing policy): the existing checks are preserved untouched. |
| `--force` | Explicitly refresh an existing installation without the guided question. Converges generated assets while preserving required checks, language, tags, templates, validation, ordering, automation target/closure, and repair labels unless an explicit option replaces the corresponding setting. |
| `--no-detect` | On fresh init, skip CI-file detection and require at least one explicit `--required-check`. On forced refresh it does not erase the preserved list. |
| `--gitlab-host <hostname>` | Explicitly declare the origin's platform as GitLab (bare hostname, including `gitlab.com`, or `host:port` for a non-default port; must match origin and is rejected for github.com). Persists to `spec_git/providers.yaml`. |
| `--language <lang>` | Language of generated text: `en` \| `zh` (default `en`). Persists to the policy's `language` key (non-default only); renders the managed guidance block and the run's human summary. Rejected before any write on unsupported values (`language_invalid`, exit 2). See [Language configuration](#language-configuration). |
| `--configure-rules` | Interactive language, title-validation and label-mode choices; requires a terminal without `--json`. Existing policy requires `--force`. |
| `--title-check <answer>` | `yes` or `no`; saves `validation.titles`. |
| `--label-check <mode>` | `off`, `kind`, or `project`; saves `validation.labels`. |
| `--allowed-label <slug>` | Repeatable; replaces policy `tags` with exactly these allowed names, retaining metadata for existing declarations. Project mode requires a nonempty vocabulary. |
| `--repair-label <slug>` | Repeatable; replaces `automation.repair_labels`. Every selected label must obey the configured label rule and declared vocabulary. |
| `--automation <answer>` | `yes` or `no`; supplies the user's explicit automation choice. First non-interactive init defaults to no; forced refresh preserves the saved choice when omitted. |
| `--merge-target <branch>` | Approved merge target used when automation is enabled. Must be a branch name, not a revision expression or fully qualified ref. |
| `--no-ignore` | Skip the managed `.gitignore` block that shields the local delivery assets (`/.specgit.yaml`, `/spec_git/`); keep the classic committed model instead. |
| `--protect` | Enable the platform's protected-merge gate without asking: the acceptance check plus repository auto-merge on GitHub, or a protected branch plus required successful pipelines on GitLab. |
| `--no-protect` | Skip the protection probe and warning entirely. |

**Detection trust boundary.** Detection reads CI for the resolved platform only:
GitHub workflows for GitHub, `.gitlab-ci.yml` for a declared GitLab origin.
An explicit or persisted GitLab declaration takes effect before scanning.
GitHub candidates require an explicit `pull_request` trigger; target-only
(`pull_request_target`), push-only, scheduled, dispatch-only, and missing-`on`
workflows are excluded and reported in `detected.nonPrWorkflows` with
`checks_not_pr_visible`. They do not prove checks on the PR head.

A statically unprovable display name is never armed: GitHub matrix and reusable
workflow jobs, and GitLab parallel or input-expanded jobs, appear in
`detected.ambiguousJobs` with `checks_name_ambiguous`. GitLab hidden templates
(keys beginning with `.`) are excluded; a real `pages` job is eligible.
Repeated identical names collapse to one entry. A scan with no provable names
uses the zero-check fallback and warns. Use repeatable `--required-check` with
verified live check names, or a flat-named aggregator, when detection cannot
prove the names. Existing checks survive ordinary `init --force`; replacement
requires explicit names.

**Platform mode.** `init` resolves a platform before mutation: only an exact `github.com` origin defaults to GitHub. A matching explicit or persisted `--gitlab-host` declaration selects GitLab. On an interactive terminal, another parseable endpoint may be confirmed **only as GitLab** and persisted; the alternative stops as unsupported. GitHub Enterprise is never offered because v1 has no GHE declaration, adapter route, or evidence path. A missing/unusable origin or undecided non-interactive endpoint returns `platform_undecided` (exit `3`); malformed existing provider bytes return `platform_providers_invalid` (exit `3`). Both preserve every byte and produce no policy or harness write. The declaration persists in `spec_git/providers.yaml`: `gitlab.host`, optional non-default `gitlab.port`, and declared-but-inert `gitlab.insecure_ssl` (the shipped adapter does not implement a TLS bypass). A persistence failure returns `providers_write_failed` (exit `3`), restores the pre-run provider state, and stops before later init writes. Matching origins resolve through the GitLab grammar — `group[/subgroup…]/project` at depth 2–5, `%2F`-encoded separators included — and route every forge call through `glab`; GitHub calls use `gh`. Declared GitLab.com is capability-probed, while self-managed instances use the verified version policy. GitLab init never generates the project's **business acceptance job**: the repository must run `specgit finish --json` from its reviewed MR pipeline. With automation off, init generates no GitHub workflow and warns `gitlab_harness_pending`. When automation is explicitly enabled, init instead adds completion plumbing: a managed conditional `.gitlab-ci.yml` router, the byte-preserved business configuration at `.gitlab/specgit-business.yml`, and the trusted `.gitlab/specgit-complete.yml` continuation. Those assets do not replace the business acceptance job. Explicit ports follow the #78 rule: a scheme-default port (`:443` https, `:22` ssh) is equivalent to omission; any other port must appear in the declaration. The JSON envelope carries `{ mode, gitlabHost? }` under `platform`.

When the planned run includes platform workflow generation or branch protection, `init` proves the remote default branch before any local write and carries that exact branch through generation and the later protection phase. After the local policy/harness transaction succeeds, a protection-enabled path asks the routed provider for that branch's protection. GitHub proof requires the generated `SpecGit Acceptance` status check on the branch and repository auto-merge enabled. GitLab proof requires the branch to be protected and the project setting `only_allow_merge_if_pipeline_succeeds` to be enabled; SpecGit does not turn that setting into a GitHub-style required-check list and does not create or rename the project-owned acceptance job. An interactive confirmation or `--protect` adds the applicable state without weakening existing settings. The JSON `protection` object reports `automerge` on GitHub and `pipelineRequired` on GitLab, so automation cannot mislabel one platform's evidence as the other's. The confirmation defaults to no during fresh adoption and yes only after the applicable harness is present on the proved default branch. A fresh adoption emits structured `nextActions`: carry the force-staged policy and optional provider declaration through a PR/MR, merge it, then run `init --force --protect`, plus optional setup/doctor. Without a TTY init warns rather than changing protection unless `--protect` was explicit. Protection is a guardrail, not an acceptance gate; unavailable permissions leave the remote unchanged and are reported.

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
| `--tool <tool>` | `opencode` \| `generic` \| `all`. Omit to auto-detect (opencode when existing OpenCode configuration or user entry points identify it, otherwise generic). The guard files generated by `init` alone do not select opencode. |

`opencode` installs command entry points under `.opencode/command/`; `generic` installs the portable skills under `.agents/skills/<name>/SKILL.md` — the tracked [`skills/`](../skills/README.md) directory is the generated distribution mirror of exactly those bytes, for copying into tools that live outside a project. Exits `2` for an unknown tool (`setup_tool_invalid`), `3` outside a git repository or on write failure.

Re-running `setup` after a CLI upgrade is the supported refresh for the agent surfaces (#307). It converges the selected surface to the running version's entry-point set inside one reversible transaction: current entry points are created or refreshed (local drift repaired), and an entry point a later version retired is removed only when its bytes prove SpecGit ownership — the `specgit-managed-entry-point` marker every generated file now carries, or the released skills' `metadata.author: specgit` line. A `specgit-*` file without that evidence is user content: preserved byte-for-byte, reported as `unowned_asset_preserved`, never deleted. Discovery never leaves the selected surface's root (`.opencode/command` for opencode, `.agents/skills` for generic; a skill directory with user files keeps them — directories are pruned only when empty), and the unselected surface is not touched. Setup uses the same read-only `.gitignore` model decision as status and init: it refreshes the managed region for the local-asset model, preserves a proven committed-authoritative opt-out, and exits 3 with `ignore_tracked_unknown` or `ignore_unreadable` before writing when that choice cannot be proved. It also uses the same fail-closed managed-path boundary: a repository-managed target or existing ancestor that is a symbolic link is an `asset_conflict`, and setup does not follow it. At commit time it re-reads whole-file targets and refuses a write when current bytes or ownership differ from the plan; removals likewise re-prove ownership from current bytes. A failure after planning restores the exact pre-run tree — bytes, modes, and directories the run created — and a second successful run is a filesystem no-op. After an upgrade, `specgit setup --tool all` is the one explicit repair command for both surfaces. A human who accepts plain `init`'s guided upgrade explicitly chooses this `all` behavior, so both surfaces are installed even when one was previously absent; absence alone never triggers the question.

Entry points are local integration assets (like the guard hooks): written for the local agent, never treated as acceptance inputs; committing them is the adopting repository's choice. Under `--json`, the envelope carries `assets: { tool, installed, reconciled }` — the tool that was installed for, the path of every entry point on the selected surfaces, and `{ created, updated, removed, preserved }` describing what the convergence did.

## `specgit issue`

The one-command bootstrap: create/reuse N issues (one issue = one independently verifiable WHY), create the branch `<type>/<first-issue#>-<slug>`, open a draft PR whose body is a deterministic scaffold — the `Closes #n` line for every bound issue, then Why / What changed / Evidence / Checklist sections — write `.specgit.yaml`, commit, and push. The binding commit force-stages (`git add -f`) the authoritative delivery files (#292): the record always, plus the policy and providers files when they exist — past the default local-asset ignore, so the CI verdict on the PR head can read them. Re-running resumes: completed steps (record with issues → branch → commit/push binding → PR → commit/push PR binding) are detected and skipped, so a failure between steps heals on the next invocation.

All issue selections are planned before the first issue creation. An ambiguous later title therefore rejects the command without creating earlier issues. Execution still rechecks live occupancy and persists each bound issue individually, so a partial write can resume safely.

Before any forge contact, a fast local probe (#339) compares the repository's generated assets against the bytes the running CLI would generate today. Proven drift blocks bootstrap only when an acceptance-critical remote workflow in the managed `specgit-accept` or trusted `specgit-complete` family is stale, conflicting, or partially present; it returns `harness_stale` (exit 2) with the init repair. Drift in the managed AGENTS block, guard hooks, or setup entry points produces the advisory `local_assets_stale` warning and does not weaken delivery verification or block bootstrap. A repository with every remote harness asset absent is a fresh adoption and proceeds. `specgit status --json` reports the complete per-surface repair plan. The gate is read-only, local-only, and uses no forge network call.

The selected `policy.templates.pr` takes precedence over the built-in scaffold.
Template text is explicit shared policy; unrelated repository template files are
not silently loaded. `--pr-body-file` supplies content for the selected template.
Every bound issue receives a closing reference. Without content validation the
default section hints remain advisory. With `validation.bodies` or selected
`required_sections`, missing or placeholder content is rejected. Creation writes
the body once; resume and PR repair preserve remote edits.

Resume matches the arguments onto the record positionally, split by record completeness. A **partial** record (issues recorded, no PR/MR yet) continues issue creation from the first unconsumed argument — numeric arguments for consumed positions must match the bound issues, and title arguments must match their current live titles. The same identity rule applies to complete records; a different title is `issue_resume_drift` (exit 2), and an unavailable title is unknown evidence (exit 3). After a remote title rename, resume with no arguments or issue numbers. The recorded branch remains authoritative during partial resume: adding a differently typed next issue never renames or recreates the delivery branch. A **complete** record (request bound, request live) is a finished bootstrap: re-running with no arguments or with the original arguments is a healing no-op (commit/push only), while **more arguments than bound issues is drift** — `issue_resume_drift`, exit 2, refused with zero side effects (no issue or request probes or creates, `.specgit.yaml` left byte-identical). Fewer arguments than bound issues, and numeric arguments not among the bound issues, are drift on any record. A request that is **closed without merge** is failed delivery evidence, never resumable or replaceable history: `issue` exits `1` with `pr_closed_unmerged`, preserves the record and every local/remote fact, and instructs the user to create or find an open draft PR/MR from the recorded branch with every closing reference, then run `specgit pr <number>`. Only after that binding is repaired may a new WHY start in a separate issue. A record whose PR/MR already **merged** is completed history, not an active delivery, and its lifecycle ends there: **no-args resume is refused** — `issue_delivery_merged`, exit 2, zero git side effects (a branch the forge deleted on merge is never re-created or re-pushed) — while **replacement arguments re-bootstrap**: they are validated first, then the first successful new binding write atomically replaces the completed record. Failures before that write preserve completed history; later failures retain the new partial record for resume. The request-state probe itself fails closed: if the request fact cannot be gathered, the command exits 3 with the provider error and keeps the record — it never guesses a lifecycle (#75).

Success hands off (#361): the `--json` envelope carries `urls` (every bound issue and the draft PR, platform-dialect web links) and `nextActions` — `issue_bodies` (fill each Why / Scope / Approach / Acceptance), `pr_brief` (fill the scaffold sections; closing references and enabled content rules must pass), `pr_ready` (`gh pr ready <n>` / `glab mr update <n> --ready` — a draft always fails the verdict). Human output renders the short `Next:` form.

```bash
specgit issue "feat: add login" "security: harden the session model"   # two new issues, one delivery
specgit issue 4 "refactor: extend the harness"                     # reuse #4, create one
specgit issue "feat: 添加登录" --delivery add-login           # non-ASCII title, explicit delivery name
specgit issue                                                 # resume an incomplete bootstrap (no args + no record → exit 2; no args + merged record → exit 2, issue_delivery_merged)
```

| Flag | Meaning |
| --- | --- |
| `--body-file <path>` | Complete body for a new issue title. Repeat once per title argument, in positional order; numeric reuse does not consume a file. Required when selected body rules cannot be satisfied by the scaffold alone. |
| `--pr-body-file <path>` | Complete content for the new PR/MR body. SpecGit preserves and prepends every required `Closes #n` reference. Resume keeps the existing remote body. |
| `--delivery <slug>` | Explicit kebab-case ASCII delivery name; required when the arguments yield no ASCII slug. |
| `--tags <slugs>` | Comma-separated full label selection applied to every bound issue. Pool labels win; only catalog or policy-declared missing labels may be seeded. |
| `--json` | Emit the one-document machine envelope on stdout; human text goes to stderr. |

Each positional argument is a quoted title (a new issue is created from a required/optional template) or a pure number (an existing issue is reused). Every new title must start with `<type>: ` where `<type>` is validated against a fixed whitelist (`feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `chore`, `style`, `build`, `ci`, `revert`, `security`, `deprecate`, `dogfood`); the title body may be in any language unless `validation.titles` enables the project rule (#407). A missing or unknown type is a usage error (exit 2) listing the valid types; all titles are validated before any issue is created. Automatic slugging requires the entire title to be printable ASCII and uses its first three alphanumeric words. A title containing any non-ASCII code point, a wordless title, or number-only arguments therefore yields no slug, and bootstrap never invents a name (#246): an interactive terminal session is prompted for a kebab-case ASCII delivery name, and any other session gets a usage error (exit 2, `issue_delivery_name_required`) naming the explicit flag. `--delivery <slug>` supplies the name explicitly and wins over a derived slug; on resume the recorded name is reused without asking. The PR base is the configured automation target when enabled; otherwise it is the remote default branch (`origin/HEAD`, `main` fallback).

Before creating from a title, the bootstrap probes the open issues with one title-carrying search (paginated to exhaustion, #77): an open issue whose title exactly matches a pending title argument is that argument's issue — a previous run created it but failed to record it — and is adopted instead of duplicating the WHY. Issue titles are not unique, so an exact match binds only when it is unambiguous: a single candidate, or a sole candidate carrying the deterministic scaffold body this tool writes (`## Why (required)` … `specgit finish must exit 0`), which an unrelated human issue with the same title does not carry. An unresolvable same-title collision is the usage diagnostic `issue_title_ambiguous` (exit 2) listing every candidate — never a silent adoption of an issue that could be unrelated. The probe is skipped entirely for purely numeric arguments and fails closed (exit 3) when the evidence cannot be gathered.

Before new creation, SpecGit also searches relevant open and closed history and
reports candidates for WHY review. Matching closed titles are linked in the new
body; closed issues are never silently reopened. Similarity alone does not veto
creation. Active closing references in another open PR/MR prevent duplicate
claims; bootstrap checks before binding and acceptance checks live facts again,
including drafts. Unknown history or occupancy evidence fails closed.

### Delivery tags (#330)

After every bound issue is durable in the record, bootstrap applies delivery tags:

- **Inferred mode** (no flag): each created issue carries its OWN title's `kind::<type>` (#338), recorded per issue in `.specgit.yaml` (`issueKinds`) and applied best-effort. A reused numeric issue — or any issue without a parsable title — carries no kind and never inherits another issue's; a pre-#338 record's consumed issues are likewise left untouched on continuation.
- **Explicit mode**: `--tags <a,b>` names the full set; it is resolved **before any issue is created**, so an invalid or unknown slug exits 2 with zero side effects.

Selection is pool-first against a portable grammar (`^[a-z0-9]+(-[a-z0-9]+)*(::[a-z0-9]+(-[a-z0-9]+)*)?$`, ≤64 chars — safe on both GitHub and GitLab, where `::` degrades from scoped-label semantics on Premium to plain text on CE):

1. Form-valid labels already on the repository win verbatim and are never duplicated under another name.
2. Missing slugs seed only from **declared vocabulary** — the built-in `kind::` catalog (one member per allowed type, same source list as the branch types) or `spec_git/policy.yaml`'s optional `tags:` list (`name` + optional six-hex `color`/`description`). Undeclared, pool-absent vocabulary exits 2 (`issue_tags_unknown`) naming what exists.
3. Off-spec pool labels are reported on stderr (`tag_pool_dirty` shape: a human warning listing samples) and never renamed or deleted — label migration is a repository owner's decision.

Seeding and applying are idempotent port methods (`ensureRepoLabels`, `addIssueLabels`): re-runs converge. With label validation off, inferred tag failures (unreadable pool, seeding permission denied, or apply failure) degrade to stderr warnings; explicit mode propagates failures as exit 3. With label validation enabled, inferred operations also fail closed. An invalid existing policy is refused before bootstrap. Applied labels live on the forge and are checked at G7 when enabled; `.specgit.yaml` records inferred issue kinds for resume, not the live label set.

```bash
specgit issue "fix: token refresh race"                          # tags kind::fix (inferred)
specgit issue "feat: oauth device flow" --tags kind::feat,module::auth   # explicit set
```

```json
{
  "tool": "specgit",
  "version": "0.0.0",
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

The `0.0.0` value above is illustrative; the runtime-supplied version in real
output reports the running package version.

Diagnostics: `issue_args_required` / `issue_title_empty` / `issue_resume_drift` / `issue_resume_title_unavailable` (a supplied title cannot be compared with the bound issue; exit 3) / `pr_closed_unmerged` (the bound request closed without merge; exit 1, record preserved, repair an open draft binding with `specgit pr <number>` before starting a new WHY) / `issue_delivery_merged` (no-args resume of a merged delivery; fix: replacement arguments — the next `specgit issue` atomically replaces the completed record) / `issues_not_closed` (a merged delivery's bound issues are still open on the forge — the closing reference never fired; exit 2 before the record is replaced, fix: close them on the tracker, then start the next delivery) / `issue_title_ambiguous` (several open issues share the pending title with no sole scaffold-body match; lists every candidate; fix: adopt one explicitly by number — `specgit issue <number>` — or rename the unrelated issue; exit 2 with zero side effects) / `issue_delivery_name_required` (the title yields no ASCII slug and no name was given or prompted; fix: `--delivery <slug>` or an ASCII title; exit 2 with zero side effects) / `issue_delivery_name_invalid` (the `--delivery` value is not kebab-case ASCII; exit 2) / `issue_tags_invalid` (`--tags` value violates the grammar; exit 2 before any create) / `issue_tags_unknown` (`--tags` value absent from pool, catalog, and policy declarations; exit 2 naming the available universe, before any create) / `harness_stale` (remote acceptance assets stale, conflicting, or partially present for the running CLI version; exit 2 before bootstrap; repair with the exact status-reported `specgit init --force --no-protect` command, including conditional `--no-ignore`; local guidance and setup entry-point drift instead produce the advisory `local_assets_stale` warning and can be refreshed through the exact reported init/setup commands without blocking bootstrap) (exit 2; drift, merged-refusal, ambiguity, naming gaps, and tag refusals happen before any create, with zero side effects); `pr_ambiguous` when several open PRs share the head branch (exit 3, fix: `specgit pr <number>`); provider failures (`gh_missing`, `gh_unauthenticated`, `gh_transport` — on a declared GitLab origin their `glab_missing` / `glab_unauthenticated` / `glab_transport` counterparts surface instead — plus `evidence_truncated` — including the mergedness probe on a PR-bound record and the explicit-mode tag calls, which fail closed and keep the record), `no_origin`, `record_write_failed`, `git_branch_failed`, `git_commit_failed`, `git_push_failed` (exit 3, resumable).

## `specgit finish`

The verdict command of the human story. The generated GitHub gate runs it with `--json` on every PR; a declared GitLab project runs it from its reviewed MR pipeline. It executes the full eleven-gate evaluation (record → policy → completeness → context → origin → provider → issues → sequence → PR/MR → closing refs → checks) through the same fail-closed evaluator as `accept`; checks are verified at the exact request head through `gh` or `glab`.

```bash
specgit finish            # human-readable verdict
specgit finish --json     # machine-readable verdict (what CI parses)
```

Exit semantics: `0` accepted · `1` rejected with complete evidence · `3` cannot determine (missing record/policy, matching forge CLI absent or unauthenticated, transport failure). See [Reference](reference.md) for the gate table and codes, and [Troubleshooting](troubleshooting.md) for fixes.

**Completed history (#351).** Running `finish` on a trunk that already merged
the delivery is not a mismatch: the context gate proves that local HEAD contains
the platform's merged result. The verdict reports `state: "completed"` only
after every gate runs successfully and every bound issue is closed.
An open bound issue instead gives `closure_pending`. A failed evidence read leaves later gates
`skipped` and `complete: false`. Invalid replacement arguments or a failed first
write preserve the completed record; `unbind` is the abandon/reset/uninstall tool.

Success hand-offs render as `Next:` lines and structured `nextActions`. With
automation enabled, both accepted live work and completed history point to
`specgit pr --merge`, so interrupted issue closure is confirmed before starting
another delivery. With automation disabled, accepted live work names the forge's
merge command, while completed history carries `record_of_merged_delivery` and
points to `specgit issue "<type>: <title>"`, which atomically replaces the record.

**Agent continuation.** The agent executes `nextActions` within the user's existing authorization: fill scaffold prose, prepare the PR, fix failures, follow required CI, and verify the merge and any authorized release. `finish` itself is read-only; it never marks ready or merges. Recheck the verdict after head/body/check changes. Missing credentials, new scope decisions, and exhausted review limits are explicit blockers; routine commands remain agent work. GitLab description edits use `glab issue update` / `glab mr update` with `--description-file`; GitHub uses `gh issue edit` / `gh pr edit` with `--body-file`.

## `specgit pr`

Repairs the PR/MR binding of the current delivery. Without arguments it auto-discovers the open request whose head is the record's branch: exactly one candidate binds; zero fails with a fix; several refuse and list. With an explicit number, or a supported full GitHub PR URL, it binds directly without contacting the forge.

```bash
specgit pr                 # auto-discover by head branch
specgit pr 42              # bind explicitly
specgit pr --merge         # execute configured merge and bound issue closure
```

`--merge` is a distinct execution mode and cannot be combined with a PR/MR number
or URL. It uses the current binding and requires `automation.merge: true`.
The PR/MR must target `automation.target_branch`; a complete acceptance verdict
must exit 0; every executed check for the current head must succeed, including
checks outside `required_checks`. Skipped non-required jobs are ignored;
neutral, failed, cancelled, pending, missing or unreadable evidence never
authorizes a merge. There must be at least one executed CI/CD check. GitLab
also requires the authoritative head pipeline to report success.
Its ordinary and trigger jobs, and their linked downstream pipelines, are
checked to exhaustion. Downstream job failures still block when their pipeline
allows failure. The graph is bounded to 32 distinct pipelines; incomplete or
untraceable downstream evidence, unsupported endpoints, and exceeded bounds
produce unknown evidence rather than authorizing a merge.

The automatic delivery and version-PR runners wait within their existing deadline
while any current-head CI check is pending, even if another check temporarily
reports a non-success conclusion. They finalize CI repair causes only after CI
settles; independently proven non-CI failures can still produce repair issues
immediately. A settled neutral or failed check still blocks merging, and a
timeout never authorizes it. This scheduling rule does not change the factual
verdict returned by `finish`, `accept`, or one `pr --merge` attempt.

The merge request carries an atomic expected-head condition to the platform.
Binding, policy, head, target, and PR/MR body are checked again before merging;
the remote PR/MR is checked again afterwards. The forge does not provide an
atomic condition on the target branch, so a retarget between the final read
and the merge request cannot be prevented by the head condition. A detected
change after merging stops further issue closure and reports non-completion.
After confirming the remote state is merged, `close_issues: true` explicitly closes only the bound issues;
already closed issues are skipped. Partial closure can be resumed with the
same command after fetching and checking out the target branch containing the
merged delivery. Closing an unmerged PR/MR is never used as a substitute.

Automation refuses closing references in the PR/MR body that name an unbound
issue, including an issue in another repository with the same number. The
forge's native commit-message closing behavior is independent of
`close_issues`: that setting controls SpecGit's explicit issue-close calls and
does not disable or undo implicit platform closure from merged commit messages.

The JSON envelope's `automation` reports `status` (`pending`, `blocked`,
`unknown`, or `completed`), `merged`, `closedIssues`, and the observed PR,
head and target when available. Only confirmed completion exits 0. Pending or
blocked evidence exits 1, invalid usage or disabled automation exits 2, and
unavailable evidence exits 3. `finish` and `accept` remain read-only; with
automation enabled their merge continuation points to `specgit pr --merge`.

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
| `--issue <n>` | Positive safe-integer issue number in the routed forge, or a full GitHub issue URL. Numeric IDs work for GitHub and declared GitLab. A URL must identify the current GitHub origin; another repository is rejected before reduction to a number. Repeatable; values merge, deduplicate, and keep first-seen order. Opaque tracker IDs are rejected (`issue_ref_not_github`). |
| `--pr <ref>` | Positive PR/MR number in the routed forge, or a full GitHub PR URL. Numeric IDs work for GitHub and declared GitLab; full URL input is a GitHub-only convenience. Replaces any previous value. At most one request per delivery. |

Exits `3` outside a git repository (`not_a_git_repo`). Never calls the forge — but since #299 `bind` carries the record rewrite into git on the current branch (`git add -f` + commit, then `git push -u`), exactly like `pr` above: local commit failure exits 3, push failure warns (`record_carry_push_failed`), and the carry runs because `bind` auto-resolves its context from live git (the current branch is the delivery branch by construction).

## `specgit unbind`

Deletes `.specgit.yaml` for the current checkout — the **abandon/reset/uninstall** tool: abandoning a delivery, resetting a checkout, or removing SpecGit. It is not the post-merge step; after a merge the record is completed history and the next `specgit issue` replaces it atomically.

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
| The record is missing (`record_missing`), while policy and git evidence are valid — the normal **pre-binding** state before `specgit issue`; reported with state `unbound` and a warning pointing at the next step (#175) | `0` |
| Usage error | `2` |
| Not a git repository / git unavailable (`not_a_git_repo`, `git_unavailable`) | `3` |
| Record invalid (`record_invalid`), or policy missing/invalid (`policy_missing`, `policy_invalid`) | `3` |

The pre-binding split (#175): a missing record is a fully determinable,
healthy state when the policy and git probes succeed — "no delivery bound yet" — so `status` answers it with exit
`0`, envelope `status: "ok"`, `state: "unbound"`, a failing `record` gate
(`record_missing`), and a warning carrying the fix (run `specgit issue`).
Genuine evidence failures — `record_invalid`, `policy_missing`,
`policy_invalid`, `git_unavailable`, `not_a_git_repo` — still fail closed
with exit `3` and envelope `status: "unknown"`, so the pre-binding case and
a true unknown stay distinguishable on both the exit code and the state.

Completed history (#351): when the record is tracked on the live branch
while naming another as its context — the local signature of a delivery
that merged into this trunk — `status` reports
`state: "historical-candidate"` (never `bound`) with the warning
`record_historical_candidate` (fix: confirm with `specgit finish`, which
reads the PR/MR, or start the next delivery; `specgit issue`
replaces the record atomically). Offline status never claims `completed`
outright — that proof belongs to `finish`.

State layers (#363): alongside the compat `state` rollup, `status --json`
answers its three questions separately — `recordState` (`missing` |
`partial` | `complete`: is the binding record filled in), `localContext`
(`matching` | `mismatch` | `unknown`: does this checkout match the
recorded context; `unknown` when git cannot answer, e.g. detached HEAD),
and `lifecycle` (`active` | `historical-candidate`). A missing record
reports `recordState: "missing"` and omits the other two — there is
nothing to match or age. The verdict layer stays `finish`-only.

Policy and context problems discovered along the way behave differently: a **missing or invalid policy fails closed** (`policy_missing`/`policy_invalid` → exit 3, listed in `errors`), while evidence *mismatches* (`branch_mismatch`, origin drift, incompleteness, …) are reported as gate results in the output but do not change the exit code: `status` answers "what does the local evidence say", not "is the delivery acceptable".

### Generated-asset drift report (#308)

`status` is also the deterministic local upgrade check: `assets.generated` reports, for every SpecGit-managed asset the writers would converge, whether it is `current`, `stale` (owned but drifted — an old template, a damaged managed region), `missing` (a required init asset that is not there), or `conflict` (bytes at a managed path that do not prove SpecGit ownership — only a human may decide). The inspection reuses the writers' own desired states (`init`'s harness + `.gitignore` reconciliation, `setup`'s entry-point sets) through one shared read-only inspector, so the checklist cannot drift from what `init --force` / `setup` actually repair. It never writes, chmods, deletes, prompts, calls `gh`/`glab`, or edits provider declarations — and drift is factual evidence: it never changes the exit code.

The report is grouped by repair surface, each with the exact fix command (`specgit init --force --no-protect`, conditionally followed by `--no-ignore` for a proven committed-authoritative model; `specgit setup --tool opencode`; `specgit setup --tool generic`; a repository with no policy yet is told `specgit init` instead). An optional setup surface nothing was ever installed on is `absent` — clean, with no missing-file list; once anything SpecGit-named exists on a surface, that surface is diagnosed independently. Per-asset codes are stable and never localized: `asset_stale`, `asset_missing`, `asset_conflict`.

The verdict is fail-closed about its own coverage. `complete` is `true` only when every part of the desired state got a claim (or a proven skip); `clean` requires `complete` **and** no inspected surface stale/missing/conflict — "no detected drift" is never "proven clean". `uninspected` lists machine codes for the desired parts status makes **no claim** about, each an unknown that makes the report incomplete — a refusal to guess where the writer itself would guess: `workflow_platform_undecided` (the platform is neither github.com, a declared GitLab, nor an evident GitLab host, so the desired workflow is unknowable), `workflow_platform_providers_invalid` (`spec_git/providers.yaml` exists but its bytes are invalid, so the platform — and the workflow it desires — is unknown, never guessed from the origin), `workflow_default_branch_unresolved` (the external template pins the remote default branch, which could not be resolved), `hooks_json_unmerged` (an unmergeable `.opencode/hooks.json` — `init` warns and leaves it untouched too), `ignore_tracked_unknown` (the tracked probe failed), `ignore_unreadable` (the `.gitignore` could not be read at all — a directory or a permission failure is unknown evidence, never the committed-authoritative opt-out). `skipped` lists intentional, proven non-applicability — currently `ignore_committed_authoritative` (the repository tracks the authoritative tier and has no managed `.gitignore` region: the #292 opt-out, not drift). A skip is proof, not an unknown: it never makes an otherwise current report incomplete, while a failed probe always does. Human output distinguishes the three states — current, drifted, incomplete — and an incomplete report never says current/clean. An inspection that cannot even run (an unreadable path) surfaces the warning `asset_inspection_failed` instead of a report. Fail-closed snapshots (invalid record/policy, git unavailable) carry no drift claim at all.

```json
"assets": {
  "generated": {
    "clean": false,
    "complete": true,
    "surfaces": [
      {
        "surface": "init",
        "state": "missing",
        "fix": "specgit init --force --no-protect",
        "assets": [
          { "path": ".github/workflows/specgit-accept.yml", "state": "stale", "code": "asset_stale" },
          { "path": ".opencode/hooks/specgit-merge-guard.sh", "state": "missing", "code": "asset_missing" }
        ]
      },
      { "surface": "opencode", "state": "absent", "assets": [] },
      {
        "surface": "generic",
        "state": "conflict",
        "fix": "specgit setup --tool generic",
        "assets": [
          { "path": ".agents/skills/specgit-old/SKILL.md", "state": "conflict", "code": "asset_conflict" }
        ]
      }
    ],
    "uninspected": [],
    "skipped": []
  }
}
```

### The version-upgrade sequence

Installing `specgit@latest` updates the package only. Each repository refresh is
a separate operation.

For a human terminal, run plain **`specgit init`** after the package install. A
valid existing policy lets it inspect managed assets locally. When proven drift
exists, answer yes to run the equivalent of `init --force --no-protect` plus
`setup --tool all`, or no to keep the tree untouched and receive
`policy_exists` guidance. Current assets do not prompt. An incomplete inspection
cannot authorize the prompt or a write. In a proven committed-authoritative
repository, the displayed init command also contains `--no-ignore` and setup
preserves that choice.

For scripts, agents, `--json`, and every non-TTY run, use this explicit sequence:

1. **`npm install -g specgit@latest`** — update the CLI package.
2. **`specgit init --force --no-protect`** — converge the init-owned tier while preserving omitted policy and automation choices. `--no-protect` forbids an implicit protection probe or change. Append `--no-ignore` when the repository intentionally tracks the authoritative tier without the managed ignore region.
3. **`specgit setup --tool all`** — converge both agent surfaces deterministically.
4. **`specgit status --json`** — require `assets.generated.clean: true`. Clean implies complete; first resolve any `uninspected` code. A `conflict` is unowned content at a managed path, so the tools preserve it and fail closed until a human resolves it.
5. **Review tracked diffs and choose what to share.** Commit only intended shared changes through the applicable delivery. Local maintenance alone ends after verification; it does not automatically stage files, open a PR/MR, build, run product CI, or publish. Local hooks, caches and device state remain outside committed source. Shared policy and workflow changes receive the validation defined in [CI scope](ci-scope.md); `.gitignore` is not a CI exemption mechanism.

The guided operation invokes two writers in order. Each writer is internally
transactional, but there is no transaction spanning both commands. If setup
fails after init succeeds, the init refresh remains applied and the failure is
reported. Repair the named path, run `specgit setup --tool all`, then verify with
`specgit status --json`. Re-run the full explicit sequence only when restarting
the automation from its first step.

The sequence converges identically on every supported OS (#314): mode drift is compared and repaired to the extent the filesystem enforces — full POSIX permission bits on Linux/macOS, the read-only attribute on Windows, whose files cannot carry `0o755`/`0o644` bits at all — so a second `init --force`/`setup` run is a filesystem no-op and `status` can prove `clean` on Windows too. A managed asset that drifted write-protected is repaired, not crashed on: the refresh clears exactly the write protection (the owner-write bit) before rewriting or retiring the asset and the final mode lands the intended protection again.

## `specgit accept`

Script/CI alias of `specgit finish`: the identical eleven-gate evaluation and exit codes, differing only in the envelope's `command` field. Prefer `finish` in human flows and new automation; `accept` stays stable for existing scripts.

```bash
specgit accept --json
```

## `specgit doctor`

Probes prerequisites and reports every failed probe with a remediation: git present → inside a repository → `origin` parses to `owner/repo` → provider CLI present → provider CLI authenticated → policy present. It does not inspect the delivery record, PR/MR, checks, or managed-file drift; those failures carry their own `errors[].fix`. The provider probes follow the delivery platform since #117: `gh` on a GitHub origin, `glab` on a GitLab-declared one (the envelope keys stay `gh_present` / `gh_authenticated`; the reported codes are the platform CLI's — `glab_missing`, `glab_unauthenticated`, …).

One hygiene warning rides the envelope without touching the exit code (`issue_stray`): open issues whose body carries the deterministic issue scaffold signature — i.e. specgit-born deliveries — that no current record binds. Their closing reference can never fire; the fix is to sweep them into the next delivery (`specgit bind --issue <n>`) or close them explicitly. Human-authored issues are never flagged, and a probe failure degrades silently.

```bash
specgit doctor --json
```

Exit `0` when all probes pass, otherwise `3`.

## JSON envelope

Every `--json` invocation writes exactly one JSON document to stdout:

```json
{
  "tool": "specgit",
  "version": "0.0.0",
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
        "fix": "Add closing keywords (e.g. \"Closes #N\") for each listed issue to the request body."
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
      "message": "The pull or merge request body does not close every bound issue.",
      "target": "pr:42",
      "fix": "Add closing keywords (e.g. \"Closes #N\") for each listed issue to the request body."
    }
  ]
}
```

The `0.0.0` value is illustrative; real output uses a runtime-supplied version
that reports the running package version.

Fields:

- `status` — `ok` | `rejected` | `unknown` | `error`
- `exit` — the numeric exit code the process exits with (`0` | `1` | `2` | `3`), equal to `status`' mapping; lets a piped caller read the exit code from the document itself
- `state` — the derived delivery state. `finish`/`accept`: `unbound` | `draft` | `bound` | `accepted` | `closure_pending` | `completed` | `rejected` | `unknown` (`completed` = proven merged lineage and all bound issues closed; `closure_pending` = merged with open bound issues). `status`: `unbound` | `draft` | `bound` | `historical-candidate` | `unknown` (`historical-candidate` = a record tracked on a branch other than its recorded context — the offline signature of merged history; confirm with `finish`). The bootstrap commands (`issue`/`pr`/`bind`) report `draft` | `bound`.
- `recordState` / `localContext` / `lifecycle` — the question-layered status fields (#363), each answerable on its own: `recordState` `missing` | `partial` | `complete`; `localContext` `matching` | `mismatch` | `unknown`; `lifecycle` `active` | `historical-candidate`. Status-only; the verdict layer belongs to `finish`.
- `urls` — (issue success, #361) forge web URLs for the bound issues and the draft PR.
- `nextActions[]` — the structured success hand-off (#352/#360/#361): `code`, `command`, `reason`. Fresh `init` carries the adoption steps (`adoption_branch` | `adoption_commit` | `adoption_pr` | `adoption_protect` | `adoption_setup`); `issue` success carries `issue_bodies` | `pr_brief` | `pr_ready`; an accepted `finish` carries `delivery_merge` for a live PR/MR, `delivery_finalize` when the request is merged but issue closure still needs confirmation, or `next_delivery` for completed history. Codes and commands are stable and never localized; reasons follow the policy `language`.
- `verdict.gates[]` — one entry per evaluated gate with `id`, `status`, failure `code`, structured `detail`, and a `fix`
- `verdict.evidence` — the facts the verdict was derived from (repo, branch, context, PR, PR head SHA)
- `errors[]` — diagnostics with `severity`, `code`, `message`, `target`, `fix`

In `--json` mode nothing else touches stdout; parse the whole document, not fragments.
