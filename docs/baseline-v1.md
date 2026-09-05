# Product Baseline — v1

This is the versioned public contract of SpecGit v1. It fixes what "supported"
means, so README, docs, help text, schemas, generated assets, and reviews can
be checked against one page. When the contract changes, this document changes
first — versioned per major line (`baseline-v1.md`, `baseline-v2.md`, …) and
referenced by the [Public Launch v1.0 milestone](https://github.com/LeXwDeX/SpecGit/milestone/1).

```text
  specgit init / setup      at adoption and after CLI upgrades:
        |                   policy + harness + agent entry points
        v
  specgit issue "<type>: …" per delivery: issues + branch +
        |                   draft PR/MR (Closes #n) + record,
        |                   committed and pushed (idempotent resume)
        v
  work, commit, push -----> CI on the PR head
        |                   (the SpecGit Acceptance job runs
        |                    specgit finish --json)
        v
  PR/MR ready               a draft request always fails the verdict
        |
        v
  specgit finish            the verdict: eleven gates, fail-closed
        |-- exit 0 --> accepted -> merge -> confirmed issue closure: completed
        |-- exit 1 --> fix what the gates named (evidence complete)
        '-- exit 3 --> follow errors[].fix; use doctor for its probes
```

## Supported platforms and prerequisites

| Dimension | v1 baseline |
| --- | --- |
| Hosted forge | The v1 contract is **dual-platform: GitHub.com plus GitLab.com and declared self-managed GitLab CE/Free**. Origins parsed as `github.com` are served through `gh`; GitLab.com and a self-managed host declared in `spec_git/providers.yaml` are served through `glab`. The self-managed verified window is `>= 19.2.4 < 19.4.0`; outside versions warn and live APIs decide. GitLab projects retain their project-owned business acceptance job; opt-in completion generates the conditional root router and independent default-branch completion pipeline described in [gitlab-support.md](gitlab-support.md). Everything else fails `origin_unresolvable`. |
| Forge access | Exclusively the existing authenticated CLI session: `gh` for GitHub and `glab` for the routed GitLab origin. No direct REST client, no stored or logged tokens. |
| Git | Required; local facts come from the git binary (`src/gitfacts` seam). Linked worktrees and `core.hooksPath` setups are first-class. |
| Runtime | Node.js ≥ 20.19 (the `specgit` CLI is an npm package). |
| Operating systems | macOS, Linux, and Windows where Node ≥ 20.19, git, and the routed forge CLI run. |
| CI systems | GitHub checks at the PR head or the authoritative GitLab MR pipeline and its downstream pipelines. GitHub Actions is documented in [actions.md](actions.md); the GitLab integration and project-owned acceptance boundary are documented in [gitlab-support.md](gitlab-support.md). |

## Commands (ten)

| Command | Role |
| --- | --- |
| `specgit init` | Public. Create the policy, generate the harness, ask the automation choice (yes/no, default no); `--force` regenerates and preserves the saved choice unless explicitly changed. |
| `specgit setup` | Public. Install agent entry points (`--tool opencode \| generic \| all`). |
| `specgit issue` | Public. One-command delivery bootstrap; idempotent resume. |
| `specgit pr` | Public. Repair the PR binding; `--merge` executes configured, guarded merge and issue closure. |
| `specgit finish` | Public. Read-only verdict; the CI gate runs this. |
| `specgit status` | Public. Local evidence only, zero network. |
| `specgit doctor` | Public. Probe prerequisites. |
| `specgit bind` | Automation alias. Record edits from scripts. |
| `specgit unbind` | Automation alias. Delete the record. |
| `specgit accept` | Automation alias. The same evaluation as `finish`. |

Nothing else is public surface. Full reference: [cli.md](cli.md).

`init` requires a supported forge platform before any mutation. Only
`github.com` auto-selects GitHub; another endpoint may be declared or confirmed
only as GitLab, because GitHub Enterprise has no v1 route. Undecided or invalid
platform evidence exits `3` without writes. A provider-declaration persistence
failure also exits `3` and restores the exact pre-run provider state. Before
workflow generation or protection, init additionally requires the remote
default branch proved from `origin/HEAD`; those paths never guess `main`.

## Optional merge and closure automation

- Automation defaults to disabled. First interactive `init` asks yes/no
  with no as the default; scripts may supply the user's answer with
  `--automation yes|no`. First non-interactive initialization without an
  answer records no. Ordinary `init --force` preserves the saved choice;
  explicit automation options change it. Agents cannot answer yes for the user.
- Policy `automation.merge: true` requires `target_branch`; enabling through
  init takes `--merge-target` or a proved remote default branch.
  `close_issues: true` additionally requires merge automation. Existing
  checks, language, ordering, vocabulary and validation settings survive
  `init --force` unless explicitly replaced, including the saved automation
  choice and target. `--protect` does not enable
  delivery automation.
- `pr --merge` requires complete acceptance and all current-head CI/CD to
  pass, then submits the expected head SHA to the authenticated forge CLI.
  Only non-required skipped checks are ignored; at least one executed check
  must succeed. GitLab includes the authoritative MR pipeline and its
  downstream pipelines. Missing or truncated evidence fails closed.
- The command verifies the configured target, confirms remote merge, then
  closes bound issues when configured. Merge closes the PR/MR; it never
  abandons an unmerged request. Retries reconcile confirmed remote state.
  The JSON `automation` result distinguishes blocked, pending, unknown and
  completed outcomes. `finish` and `accept` remain read-only.
- The trusted remote completion workflow continues from CI events using the
  approved target policy. `pr --merge` provides a recovery path. Completion
  requires a confirmed merge and all bound issues closed; merged work with
  open issues remains `closure_pending`. A proposed policy cannot enable its
  own automatic merge or weaken its own acceptance requirements.
- Platforms atomically enforce the head SHA, but expose no equivalent
  target-branch compare-and-swap. SpecGit checks target and body before and
  after merge, stopping further actions on mismatch. Explicit issue closure
  does not override native forge commit-message closing behavior; see
  [cli.md](cli.md) for the complete boundary.

## Exit codes, JSON, and environment

- Exit codes `0` (success/accepted) · `1` (rejected with complete evidence) · `2` (usage) · `3` (fail-closed unknown). `1` vs `3` is contractual.
- `130` is the single **interruption exception**: Ctrl-C during an interactive prompt prints `Interrupted.` to stderr, emits no JSON envelope, and exits 130. This is documented, deterministic behavior — automation treats it as "interrupted, no verdict".
- With `--json`, stdout carries **exactly one** valid JSON document (the envelope in [cli.md](cli.md#json-envelope)); every human-readable line goes to stderr. The `130` path above is the only exception.
- Public CLI environment inputs: `SPECGIT_GH` / `SPECGIT_GH_TIMEOUT_MS` (path to and per-call timeout for the `gh` executable, default `15000` ms) and the `SPECGIT_GLAB` / `SPECGIT_GLAB_TIMEOUT_MS` mirror pair, plus hook-only `SPECGIT_GUARD_BUDGET_S` (seconds — the generated merge-guard hook's verdict budget; the CLI never reads it), plus standard `NO_COLOR`/`CI`. The internal remote runner receives workflow identity inputs from generated workflows; these are not additional public CLI settings. No tokens in SpecGit state and no telemetry.

## State and assets

Three tiers, nothing else (normative table: [reference.md](reference.md#state-and-assets)):

1. **Authoritative delivery files** — `spec_git/policy.yaml`, `.specgit.yaml`, and the optional `spec_git/providers.yaml`. Human-owned. Shielded from everyday commits by the managed `.gitignore` block `init` writes by default (#292); the bootstrap's binding commit force-carries them into git on the delivery branch (`--no-ignore` keeps the classic committed model).
2. **Derived committed harness** — `.github/workflows/specgit-accept.yml`, the managed block in `AGENTS.md`/`CLAUDE.md`, and the optional trusted completion workflow. GitLab automation adds its managed root router and separate completion configuration while preserving the business CI bytes; see [GitLab support](gitlab-support.md). Generated assets are regenerable (`init --force` repairs drift).
3. **Local integration assets** — guard hooks (`.opencode/hooks.json` entry, `.opencode/hooks/specgit-merge-guard.sh`, the managed region of `.git/hooks/pre-push`) and `setup` entry points. Merged non-destructively into your existing wiring.

The reconciler re-reads whole-file targets at commit time. Replacement requires
current ownership plus the exact planned merge basis; removal re-proves current
ownership. Intervening user bytes are preserved, and a failed transaction rolls
back earlier accepted mutations.

Verdicts and delivery states are derived per invocation and never persisted.

Local CLI installation, upgrade and init/setup refresh do not require an issue,
PR, product build or release when no tracked product or shared-rule change is
intended. Review tracked diffs before sharing them. Local entry-point drift is
reported as a maintenance warning; unusable remote acceptance assets still
block bootstrap. [CI scope](ci-scope.md) defines applicable verification;
ignore rules never grant CI exemptions.

In this repository, every path admitted to metadata-only verification has a
real fail-closed content check: delivery schemas, workflows, generated guidance
and setup entries, YAML/legacy Markdown issue templates, `.gitignore`,
`CODEOWNERS`, changesets, repository metadata, and documentation. A missing or
malformed input fails; it cannot skip product verification by path alone.

## Evaluation semantics

- Eleven ordered gates: record → policy → completeness → context → origin → provider → issues → sequence → pr → closing → checks ([gate table](reference.md#gates)).
- **Transient semantics:** `checks_pending` is `factual` and exits `1` — a complete verdict saying "CI has not finished". It is transient and retryable: wait, re-run `specgit finish`. It is never reclassified, never exit `3`.
- **Closed request semantics:** a record bound to a PR/MR closed without merge
  is failed delivery evidence. `specgit issue` exits `1` with
  `pr_closed_unmerged`, preserves the record, and requires an open draft from
  the recorded branch to be bound through `specgit pr` before a new WHY starts.
- Acceptance is fail-closed: ungatherable evidence ⇒ `unknown` (exit 3), never `accepted`. `specgit finish` exit `0` means accepted. A delivery is completed only when its merge and every bound issue closure are confirmed.
- **Fail-closed has two branches** (#120): fail closed on **errors** (evidence cannot be gathered ⇒ `unknown`) and fail closed on **silent incompleteness** — every list-shaped evidence input (open issues, check runs) is either paginated to exhaustion or signals truncation, and a truncation signal degrades the verdict to `unknown` (`evidence_truncated`, exit 3), never a complete-evidence exit `1`. A truncated list is not evidence.

## Compatibility

- The record schema (`version: 1`) and policy schema (`version: 1`) are strict; unknown policy keys are invalid, unknown record keys are preserved.
- Check names match byte-for-byte against `required_checks`.
- The `accept` alias is permanent for v1 — existing scripts keep working.
- **Generated text is language-configurable; the machine contract is not** ([#118](https://github.com/LeXwDeX/SpecGit/issues/118)). The policy's optional `language` key (`en` default, `zh` supported) selects the language of generated scaffolds, harness guidance, and success-path human prose. Never localized under any value: exit codes, `--json` envelope field names, diagnostic `code` values (and, in v1, diagnostic prose), the closing-reference keywords, the workflow YAML, and the guard scripts. Branch names stay ASCII — a title that yields no ASCII slug never invents `issue<N>`: bootstrap asks for a kebab-case delivery name, and scripted sessions pass `--delivery <slug>` ([#246](https://github.com/LeXwDeX/SpecGit/issues/246)).

## Optional project conventions

Policies without `validation` retain their existing behavior. A project can
configure title and label checks with `init --force --configure-rules`, or
explicit `--language`, `--title-check`, `--label-check` and repeatable
`--allowed-label` flags. Ordinary upgrades preserve the choices.

With `titles: true`, English requires no Unicode Han characters and Chinese
requires at least one, across all bound issue titles and the PR/MR title.
`labels: kind` requires exactly one catalog `kind::` member plus declared
extras; `labels: project` requires a nonempty subset of the declared `tags`.
Both allow at most one label per scoped axis. These are deterministic checks,
with creation preflight and live acceptance at G7/G9: proven violations reject,
missing evidence is unknown. Full [CLI rules](cli.md#project-title-and-label-rules)
define the configuration choices and diagnostics.

## Non-goals (v1)

- No GitHub Enterprise declaration or evidence route; self-managed GitLab CE/Free evidence is supported per [gitlab-support.md](gitlab-support.md).
- No direct REST clients, no token storage, no telemetry.
- No spec-artifact or task-list inputs — evidence is git + the forge (GitHub or GitLab) only.
- No cross-platform deliveries (one delivery, one platform, one PR).
- No weakening of `spec_git/policy.yaml` to pass a verdict, ever — weakening a policy that was right at birth is forbidden; correcting one that was wrong at birth (e.g. a detected check that never runs on PR heads) is required, via explicit `init --force --required-check <verified-name>` replacement or a reviewed edit; ordinary upgrades preserve existing checks.

## Deprecation policy

- **Stable within v1 (major):** command names and roles, the exit-code contract, the JSON envelope shape, the two schema files, diagnostic codes and their classification (`factual`/`evidence`).
- **Deprecation procedure:** any removal or semantic change to a stable surface is (1) documented here and in [CHANGELOG.md](../CHANGELOG.md) via a changeset, (2) announced at least one minor release ahead with the old behavior still present and a warning where output allows, (3) removed only in a major version.
- Generated assets track the CLI version that generated them. After upgrading,
  `init --force --no-protect` converges init-owned workflows, managed guidance,
  guards, and ignore state; `setup --tool all` converges installed commands and
  skills; `status --json` verifies the result. Plain interactive `init` offers
  this sequence when it proves installed assets stale.

## Release process

Releases are automatic, PR-gated, and OIDC-based ([release-prepare.yml](../.github/workflows/release-prepare.yml)):

1. A feature/fix PR carries its changeset (`.changeset/*.md`); merging to `main` opens (or force-updates) the **version PR** `changeset-release/main` with the consumed bump.
   The version PR remains open by default. Configured merge automation with
   target `main` waits for all current-head CI and merges with the expected
   SHA, preserving platform protection.
2. Merging the version PR lands `chore(release): v<version>` on `main`, which builds, verifies the packed version, and publishes to npm via **OIDC trusted publishing** (no token, no environment secret) with provenance. The publish gate is registry evidence — no pending changesets and `package.json`'s version absent from npm — not the head commit message, so the merge strategy cannot suppress a release; `workflow_dispatch` on `main` is the manual retry entry point; feature and tag refs cannot run the release job.
3. The tag `v<version>` and the GitHub Release follow independently of whether npm publication happened in this run. A retry recovers missing metadata from the published version's exact `gitHead`; an existing tag must match that commit. Only an explicit npm 404 proves absence; transport/auth/parse failures stop the run. A replay never double-publishes.
4. Direct pushes to `main` are refused by the pre-push guard, so **every published version traces to a merged PR**. Release candidates are verified without accidental final publish via dry-runs (`npm publish --dry-run`, tarball inspection) and the tag-based idempotence above.
