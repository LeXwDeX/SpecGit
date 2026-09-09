# SpecGit 2.0 harness contract

Status: proposed implementation contract for the Rust rewrite. Read with the
[architecture and implementation sequence](specgit-2.md) and
[historical requirements ledger](specgit-2-history.md). None of these documents
claims that 2.0 is shipped. The existing 1.x contract still governs 1.x.

## The harness that remains

SpecGit is a delivery harness around the user's authenticated GitHub/GitLab
session. It turns a discussed spec into complete issue content, maintains the
issue-to-request association, provides consistent agent guidance, evaluates
current evidence and brings relevant outcomes back to the agent. Using native
platform mechanisms does not remove these product responsibilities.

| Operation | SpecGit responsibility | Native owner |
| --- | --- | --- |
| setup | Install global skills, versioned hook adapter and import manifest | Host settings/event execution |
| init | Inspect project, choose conventions/templates/language, generate owned guidance and explain native flow | Repository identity, settings, protection, template facilities |
| issue | Prepare/validate specs, duplicate discovery, create or adopt exact issues, checkpoint selection | Issue IDs, stored content, labels and state |
| pr | Create/discover/adopt one request, preserve many-issue references, check source/target and body | PR/MR object, review/draft state and associations |
| finish | Assess declared spec requirements plus current platform evidence | Checks, reviews, mergeability and actual lifecycle facts |
| watch/hook | Observe and deliver bounded, deduplicated results | CI execution and host delivery/wake-up |
| merge | Optional explicit delegation with fresh identity/precondition checks | Native protected merge/auto-merge/queue |
| close/delete | Report actual resulting issue and branch state | Native issue closure and native source-branch cleanup only |

No generated completion worker, repair-issue creator, custom closing endpoint,
branch-deletion fallback, reuse-receipt protocol or general task scheduler is
part of the Rust runtime. Native operations can be invoked by the harness under
existing authorization; replacing them with custom lifecycle transactions is
excluded. Hooks and watch receive no mutation capability.

## Configuration and authority

Use one shared project declaration at `.specgit.yaml`, with `version: 2` and a
strict versioned schema. The old pointer/policy split is migration input. Keep
large selected template content in declared repository files when helpful;
those files are content, not another runtime policy. Do not silently load a
second `spec_git/policy.yaml` as competing 2.0 authority.

The following is the proposed field vocabulary for implementation and migration:

```yaml
version: 2
remote: origin
# provider: github | gitlab   # required only when discovery is ambiguous
# target: main               # omitted means live native default
language: en
validation:
  titles: false
  labels: off                # off | kind | project
  bodies: false
# tags: [{name: "area::cli", color: "336699", description: "CLI work"}]
# templates:
#   issue: {source: builtin}
#   pr: {source: repository, path: .github/PULL_REQUEST_TEMPLATE.md}
verification:
  required_checks: []        # additional explicit project expectations
observation:
  poll_seconds: 15
  max_wait_seconds: 1800
  notify: [attention, completed]
```

Omitted optional objects use the documented defaults. Reject unknown keys,
duplicate YAML keys, unsafe values, unsupported versions, conflicting selectors
and invalid paths before writing. Validate maximum input sizes and meaningful
bounds. The examples are a design target; changing a field during implementation
requires updating this contract and the migration mapping in the same delivery.

The native implementation bounds the declaration and each selected body/template
at 1 MiB, tags/check names/required-section lists at 100 entries, poll intervals
at 1–3600 seconds, and total observation wait at one poll interval through 86400
seconds. Template selectors require exactly the content fields appropriate to
their source; repository paths are relative, without traversal or symlink
ancestors. The supported language values are `en` and `zh`.

`init --inspect` reads configuration, CLI/API identity, current request targets
and native settings without project or native writes. Ordinary `init` writes
the owned declaration and AGENTS block after these reads. `--mirror-claude`
selects the CLAUDE block; an existing owned mirror remains selected on refresh.
`--native-delete-source true|false` explicitly selects only the native source
cleanup setting and requires readback. `init --rollback <transaction>` restores
local owned assets without calling a forge; native settings are not compensated.

A selected `--api-host` is saved under the current worktree's Git directory at
`specgit-v2/local-routing.json`, never in the shared declaration. Routing is
bound to the original remote identity and has a 4 KiB input bound. Explicit CLI
routing wins over matching local routing, then the remote-derived API host.
A mismatching stored identity is rejected until an explicit selection reconciles
it. Tokens are never part of this file.

`remote` identifies a Git remote; it is not a hardcoded organization/host.
Canonical forge identity comes from that remote and an authenticated API response.
If multiple remotes are plausible, require selection without touching them.
A selected local API endpoint override can handle SSH/API host or port differences.
Private endpoint overrides and tokens do not enter shared templates or fixtures;
SpecGit never reads/stores tokens. Stable machine JSON keys/codes are English.

Shared convention precedence is explicit command choice for the current operation,
then project declaration, then builtin default. Explicit body input is content
and does not disable required validation. Global configuration governs install,
host registration and personal presentation; it cannot silently replace shared
project spec rules. Local endpoint/subscription settings cannot grant write rights,
relax shared verification or redefine native default/merge/issue facts.

For an established project, acceptance reads shared rules from the declared target
revision, reporting candidate changes separately. First adoption can evaluate the
candidate as `initial_adoption`; it does not establish a trusted native required
check by itself. Changes to rules cannot approve their own merge or modify
protection. Init refresh preserves existing language, rules, template selections
and unrelated native settings. It is not a reset-to-default command.

## Language, titles and labels

Retain `en` and `zh` as initial supported presentation languages, default `en`.
Language covers builtin issue/PR scaffolds, generated harness prose, diagnostics
and hook context. Preserve user-authored template text and existing remote bodies;
changing the language does not translate them automatically. Technical identifiers,
URLs, JSON keys, diagnostic codes and canonical closing keywords remain stable.

Validation is independently opt-in. With title checks enabled, preserve the
existing documented en/zh structural rule during migration; do not claim it is a
semantic language detector. Every selected issue and the PR/MR are checked.
Missing title/body/label evidence is unknown; known invalid content is rejected.
The agent still evaluates whether the content adequately explains the work.

Keep the Conventional Commit type vocabulary used by the existing catalog.
In `kind` label mode require exactly one `kind::<type>` and only declared extras;
in `project` mode require a nonempty selection from the declared `tags` vocabulary.
Select at most one member per scoped axis. Default `off` does not silently seed
or enforce a catalog. Explicit label requests remain validated and preserved.

Use existing conforming platform labels verbatim before creating a missing
explicitly selected label. Seed only names from the selected catalog or declared
project vocabulary, preserving portable names/color/description constraints.
Unknown names report allowed choices. Do not rename/delete dirty pool labels,
infer arbitrary extras or erase unrelated labels when reconciling an issue.
Label creation/update is a native write under the explicit issue/configuration
operation, followed by readback. A partially completed label write cannot be
reported as a fully conforming issue. Hooks only explain the mismatch.

## Templates and complete content

There are three different assets: issue templates, PR/MR templates, and harness
guidance templates. Keep them distinct and version them with the runtime.

- Builtin issue content supplies Why, Scope, Approach and Acceptance; builtin
  request content supplies Why, What changed, Evidence and Checklist. Use the
  selected language. These are preparation scaffolds, not proof of filled specs.
- A selected repository Markdown template or explicitly configured inline body
  replaces the corresponding builtin scaffold. A selector has one source:
  `builtin`, `repository` with `path`, or `inline` with `body`; optional `title`
  and `required_sections` apply to that kind. Selection is reported in JSON.
- A caller-supplied body file is final prepared content. Validate it against
  selected required sections and add/preserve every binding reference. Do not
  silently wrap a fully prepared body in a second template.
- `required_sections`, when present, enables structural body checking even if
  `validation.bodies` is false. Reject empty content and unfilled prose
  placeholders. Otherwise `bodies: true` uses the selected/builtin section set.
  Markdown code fences are content, not executable instructions.

At init, discover available native issue/request templates and report their
source, type and effective platform defaults. Prefer an explicitly selected
existing native template over generating duplicates. Multiple candidates,
inherited templates or unsupported template formats must be visible; do not
silently pick the first file or overwrite a project's native template defaults.
Preserve native template metadata such as intended labels where explicitly
selected and compatible with the project's rules; conflicts are diagnostics.

GitHub issue forms are structured UI forms, not ordinary Markdown templates.
Use verified native CLI support where available; otherwise accept explicitly
prepared Markdown and explain that native form interaction/validation was not
executed. Do not implement a generic form engine or claim all native form rules
were satisfied from API creation alone. GitLab description templates may carry
server-interpreted quick actions: preflight their effects before submission, and
refuse unauthorized closing/assignment/settings operations. A template never
grants mutation authority.

Support only named text substitutions `{{title}}`, `{{summary}}`, `{{body}}`,
`{{delivery}}`, `{{issues}}` for SpecGit-owned templates. Substitute once; inserted
content is never recursively evaluated, shell-expanded or executed. Reject unknown
variables. Native provider variables have their provider's semantics; do not
pretend SpecGit syntax and native variables are interchangeable.

Validate planned titles/bodies/labels and every issue association before the first
remote write. Resume reads existing remote content and preserves edits instead
of rerendering templates over them. Updating references requires a fresh body
read and concurrency check; a conflicting edit stops with a precise remedy.
Unfilled enforced content must be supplied before creation, not posted and then
claimed complete. Never copy raw private debug logs into a template.

The native template facts above are grounded in [GitHub templates](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/about-issue-and-pull-request-templates),
[gh pr create](https://cli.github.com/manual/gh_pr_create),
[GitLab description templates](https://docs.gitlab.com/user/project/description_templates/)
and [glab mr create](https://docs.gitlab.com/cli/mr/create/). Actual installed
CLI and instance support is verified by the shared probes, not inferred from
these pages alone.

## Harness generation and ownership

`setup` installs per-user versioned skills, the `specgit hook` executable adapter,
a Claude-shaped hook manifest, and an ownership receipt. Use native per-user data
and config roots on each OS with an isolated-root option for tests. Explicit host
registration is distinct from exporting files. No per-project package install,
repository initialization or forge mutation occurs merely from global setup.

`init` derives a compact project harness from the shared declaration: selected
language/rules, issue-before-edit workflow, many-issue PR association, native
lifecycle caveats and commands for assessment/observation. The default repository
output is a marked owned section in AGENTS.md; an explicitly selected CLAUDE.md
mirror uses the same content source. Global skills stay global. Project guidance
is discoverable by agents even without hooks and points to native platforms for
writes. It does not grant permissions or install hidden Git merge guards.

Generated text states the installed contract version and declaration source.
Project-local guidance receipts retain the last generated block hashes and runtime
version in the same asset transaction as the marked files. Refresh compares those
preimages so manual declaration edits and runtime upgrades preserve ownership;
rollback restores the receipt and guidance together.
Preserve every byte outside owned markers, unknown host configuration fields and
foreign entries. Marker damage or an edited owned block requires a diff and
explicit adoption/replacement decision; do not overwrite it as if pristine.
Use expected-content hashes, atomic replacement, write-time ownership checks,
symlink/path defenses, bounded locks and recoverable backups. Concurrent writers
must not lose user changes. Report paths, created/updated/unchanged/conflicting
assets and registration state. Uninstall removes only proven owned entries.

No mandatory generated CI workflow is installed. An adopting project may
explicitly integrate read-only `finish` as its own native required check; its
workflow, permissions and scheduling remain project-owned. Init can prepare the
reviewable integration when requested, but neither its presence nor an ignore
rule proves acceptance. Never mutate native branch protection just to make
SpecGit pass. Native template file creation is likewise an explicit prepared
project change, not an invisible side effect of refresh.

## Command contract and allowed effects

Command names below define the 2.0 target. Before implementation, add their exact
flags/examples to generated help and JSON schemas together; removed 1.x flags
return migration diagnostics instead of new meanings.

| Command | Reads | Allowed effects |
| --- | --- | --- |
| setup | Executable/account/host capabilities and installed ownership | Global owned assets; selected host registration |
| init | Git/project/default/settings, declarations and template catalog | Shared declaration and owned project guidance; explicitly requested native setting with readback |
| doctor | Layered command/API/project/host evidence | None |
| issue | Full candidate issues, conventions and current selection | Explicit issue/label creation/adoption and ignored local checkpoint; selected new branch only when needed |
| pr | Selected issues, exact source/target/request and native references | Explicit create/bind/reference update/ready/native merge request; no closure/delete fallback |
| status | Local declaration/checkpoint/outbox | None; no hidden network call |
| finish | Fresh shared rules, complete issue/request/check/review evidence | None |
| watch | Live delivery snapshots and local subscriptions | Local lease/outbox only; bounded background child |
| hook | Event payload and local project/subscriber context | Local context/inbox plus read-only watch handoff |

Keep useful binding adoption/unbinding as explicit `pr` actions; compatibility
aliases `bind`, `unbind` and `accept` may exist only with identical documented
semantics. Legacy `finish --scope` is not a new programme engine: programme
membership is an explicit tracker checklist, evaluated with linked native facts.
A read-only aggregate command is optional follow-up, never a release dependency
or reason to carry the 1.x committed scope/completion machinery into 2.0.

No command implicitly stages unrelated files, commits dummy bindings, rewrites
history, force-pushes, changes remotes or checks out over a dirty worktree.
Global setup and read-only commands need no delivery binding. A product/shared
change still starts by binding its specs before implementation. Existing explicit
user authorization remains valid; routine reversible actions need no new prompt.

`--json` stdout is exactly one versioned JSON document; progress is stderr.
Reports contain schema version, operation, status, available evidence, diagnostics
and suggested next actions. Preserve the broad exit meanings: 0 successful
operation/accepted assessment, 1 known assessment rejection, 2 invalid input,
3 missing/unusable required evidence. Watch launch exit 0 means registered, not
completed. Local status can succeed while clearly showing stale/unknown remote
state. `finish` reports accepted separately from lifecycle completion. Hook
adapters translate these codes into event-specific protocol semantics.

## Issue-to-request binding lifecycle

1. Resolve canonical repository and current worktree. Search for similar open
   issues and read plausible candidates. Same title alone is not proof of the
   same WHY. Adopt exact requested IDs or create complete, independently
   verifiable specs through the native CLI.
2. Record ignored selection before code changes. A new branch can be selected
   without a remote request; protect existing branch/worktree/dirty state. There
   is no tracked delivery-record commit solely to store numbers.
3. Push the real change under existing authorization. `pr` creates a draft
   against the explicit/native-default target with every bound issue reference,
   or adopts one exact matching request. No diff yields `pending_request`.
4. Store the request ID only as a local locator. Read back native identity,
   source project/branch, head, target, body and all associated issue IDs.
5. Preserve references on body edits and refresh remote evidence after head,
   body, ready state or target changes. Removed references or ambiguous requests
   are actionable discrepancies; never silently switch deliveries.
6. A merged request remains linked to each issue even if closing was delayed,
   disabled or ineffective on that target. Native state readback determines
   the reported result. A new independent delivery can start without hiding
   outstanding subscriptions or reopening old issues.

Binding authority after request creation is explicit platform-visible spec
references plus verified native associations, not a local record, branch name,
label or mutable hidden marker alone. Use canonical same-repository references
such as one `Closes #n` per bound issue for supported native closure; distinguish
other mentions from the deliberate binding set. Preserve every deliberate issue
across custom bodies and native template rendering. Missing native closing
association on a non-default target is expected and does not erase explicit
spec association. Unresolved cross-repository references require explicit support
and identity verification; initial automatic bootstrap is same-repository only.

Remote writes are not atomic across several issues and a request. Use a bounded
local operation checkpoint and readback after each native write. If a process
loses its response, reconcile remote candidates against stored intent and exact
identity before retrying. If evidence is ambiguous, stop without a duplicate.
Do not delete created issues/branches as automatic rollback. A fresh clone can
adopt known issue/request IDs even when the original local checkpoint is gone.

The native issue entry point accepts `specgit issue <id-or-title>...`, optional
`--body-file <path>` once per new title, `--tags <a,b>`, `--branch <new-name>` and
`--inspect`. The normalized option schema is
`runtime/schemas/issue-options.schema.json`; it describes CLI options and does not
introduce a JSON-input transport. Inspect prepares specs and expands native
duplicate candidates without creating a checkpoint or branch. New branches are
explicit, must differ from source/target, and require a clean worktree. Adoption
uses exact issue IDs and preserves current native titles, bodies and labels.

The ignored worktree checkpoint is `specgit-v2/selection.json` inside the Git
directory, bounded at 1 MiB and 100 issues. A held operation lock and atomic
single-file replacement preserve pending write intent without a rollback that
could erase evidence of an attempted remote write. An uncertain creation stops;
inspect its native candidates and adopt the exact returned issue ID to reconcile.
The checkpoint is a locator and recovery aid, never remote binding authority.
Native Markdown front matter preserves a selected title and label list; unsupported
metadata and nonempty assignees require explicit reconciliation. Native template
body variables remain untouched; SpecGit substitutions apply to its builtin and
inline templates and the explicitly declared title selector.

The native request entry point is `specgit pr`, with `--request <id>` for exact
adoption, `--title`, `--body-file` and `--tags` for creation, `--inspect` for
preparation, `--update-body --body-file <path>` or `--update-references` for an
explicit body change, and `--ready` for the native draft transition. Its normalized
option schema is `runtime/schemas/pr-options.schema.json`. There is no automatic
push or binding-only commit: native source HEAD must equal local HEAD and a
native comparison must show an actual changed file before draft creation.

Existing native content wins on resume. Every old and newly supplied deliberate
reference is resolved to a same-project issue before writes. Standalone close,
fix and resolve keywords (including their closed/fixes/resolved variants) are
recognized without case sensitivity; cross-project, inline and other unsupported
closing-like forms require explicit reconciliation before body replacement.
Pending label additions are validated together with current native labels before
any remote write, so a conflicting native edit stops recovery without alteration.
The worktree records
request creation intent and the returned ID before fallible readback. A completed
initial label step drops its pending intent, so later label edits are evaluated
as current native facts. Body mutation uses a fresh prewrite read and postwrite
readback; these checks detect intervening observed edits but do not claim an atomic
server-side compare-and-swap. An edit in the final read/write window remains a
native API concurrency limitation.

Fork requests require verified source and target project identities; read-only
observation may support them before write bootstrap does. Unsupported fork-write
flows fail explicitly. Native branch cleanup may be unavailable for a fork or
protected source. Never substitute local checkout deletion for remote cleanup.

## Evidence, checks and native completion

Separate spec validity, check applicability, current check/review result,
mergeability, merged state, each issue state and source-branch cleanup. Checks
passing does not mean the request is ready or merged. Merged does not mean all
issues closed. Unknown is never success. `completed` requires confirmed merge
and all bound issues closed; cleanup is an independently displayed result.

For each required check, preserve repository/head/workflow-or-pipeline/attempt/job
identity, full relevant pagination, timestamps and terminal result. Re-observe
identity around multi-request reads; changed head/target/attempt invalidates the
snapshot. Missing, cancelled, stale or ambiguous evidence cannot grant acceptance.
Read native required-check/approval configuration where available, plus declared
additional expectations. Unknown protection access remains a disclosed limit;
SpecGit cannot certify native merge authorization from partial settings reads.

No-CI is a legitimate explicit project case only when applicable declarations and
observable native requirements establish that no check is required. An empty list
from a failed query is not no-CI. An absent required check is not skipped by path
inference. Project-owned scheduling produces honest applicable/inapplicable
results; hooks do not run builds on every tool event. Refresh readiness/spec
assessment after body or ready changes without requiring unchanged product tests
to restart merely for a new ready timestamp.

Use native merge/auto-merge/queues only when explicitly requested and supported;
recheck source/head/target and native blockers before submitting, and read back
queued versus merged state. Unsupported auto-merge is not a reason to direct
merge. Platform protection remains authoritative even if `finish` is accepted.
Do not grant self-approval, bypass a queue or enable merge on behalf of the user.

The native Rust entry point is `merge --request <id> --mode now|auto
--strategy merge|squash|rebase`; all three options are required. It performs a
fresh accepted assessment before the first submission, saves a durable intent
under the selected worktree's Git directory, and passes the assessed source SHA
to the native CLI's server precondition. A changed request or failed assessment
prevents submission. The platform remains responsible for protection changes
after the final read; the API does not provide a transaction over every setting.
Recovery reads native state and never automatically resubmits an uncertain write.
After inspecting an unresolved submission, the user can reconcile it directly
through the native forge; there is no implicit direct-merge fallback.

GitHub delegates to `gh pr merge`, preserving its native queue behavior without
`--admin`. A readable native `auto_merge` request is reported as `queued`; queue
membership that cannot be proven through the current read adapter is `unknown`.
GitLab delegates to `glab mr merge` with explicit auto-merge and SHA options.
Because glab omits a false squash API parameter, strategy `merge` requires the
native project to enforce `squash_option: never`; `squash` requires a known policy
that permits it. Auto mode requires matching current-head `head_pipeline` and
the separate legacy `pipeline` field consumed by glab, which otherwise omits
the auto-merge API parameter. Both capabilities are read
again before submission; unsupported choices fail before saving a write intent.
GitLab rebase and enabled/unknown merge-train routing are currently unsupported:
rebase changes the assessed head, and train routing requires separate capability
qualification. Neither case falls back to a direct merge. CLI stdout is never
used as evidence of merge, queue membership, closure or cleanup.
The normalized option schema is `runtime/schemas/merge-options.schema.json`.

When targeting a non-default branch, surface native closure limitations at init,
request creation and observation. If merge succeeds with open issues, emit
`merged_issues_open` rather than retrying closure forever. Report which issue
states are observed and why native behavior may not close them. No custom close
or delete endpoint is available to any observer/hook/merge-recovery path.

The native Rust `finish [--request <id>]` command reads the declaration at the
current immutable target commit and compares the pushed candidate declaration
separately. Complete native root trees prove first adoption; a failed file read
never proves absence. Its normalized option schema is
`runtime/schemas/finish-options.schema.json`. An open delivery also requires a
clean selected worktree whose HEAD matches the observed native request.

GitHub check reads retain workflow identity, event, current attempt, current job
IDs and owning check suites, with full bounded lists and matching job/check
results. GitLab starts at the request's `head_pipeline`, follows bounded native
child pipelines, and keeps project/pipeline/job identity and allowed failures.
Current checks and protection inputs are read again before acceptance. Explicit
required names still require success even when a job otherwise allows failure.

Unavailable protection or approval APIs, incomplete pagination, fork source
identity and unsupported merged-result pipeline identities remain unknown. The
current GitHub observer requires a readable classic protection response whenever
the branch reports protected, including branches protected only by rulesets;
ambiguous 404s are not converted into an unprotected branch. Cleanup is reported
independently and requires a complete branch list to establish deletion. The
observer exposes no close-issue, delete-branch or merge fallback.

## Observation, storage and host protocol

Use a bounded process per subscription initially; cross-subscription polling
sharing is an optimization, not an initial daemon requirement. Identity includes
canonical repository/request, subscriber session/worktree, observed head/target
and declaration digest. Subscription goal is explicit: checks or full request
lifecycle. Persist versioned, bounded local intent and pending events with atomic
writes and recoverable leases. Store no token, raw log dump or remote truth ledger.

Default polling is 15 seconds with backoff/jitter for retryable errors and a
30-minute bound, configurable within validated limits. Event/outbox retention
is bounded (proposed default seven days); terminal acknowledged items can expire,
and unacknowledged expiry produces a visible retention diagnostic on next resume.
Never erase a pending result while claiming it was delivered. PID alone is not
lease identity; verify process generation/owner and recover stale locks safely.

Events carry stable ID, repository/request, head/target, goal, state, reason,
observation time and actionable next step. Deliver at least once; acknowledge
only the strongest transport event the host proves and deduplicate by event ID.
Message delivery is not proof of user reading. New head/target supersedes stale
success; a resumed observer refreshes live facts before sending terminal output.
Cancellation kills/reaps owned children or records explicit resumable intent.
Timeout/auth/network failure reports pending/unknown and never creates repair work.

Default events are SessionStart/resume, relevant PreToolUse/PostToolUse and Stop.
Bound JSON input size, nesting, stdout and deadlines. Use event payloads only to
identify context and triggers; do not parse a shell string as proof of push/merge.
Unknown optional host fields are preserved; unsupported event/schema versions
produce a safe diagnostic. Broken context collection should not falsely block
unrelated ordinary tools. Ignore the adapter's own operations to avoid recursion.

Capabilities distinguish exported manifest, imported event, context injection,
visible message, next-turn delivery and idle wake-up. Validate each claimed host
path with the installed binary. Standard asynchronous output may arrive next turn;
wake only through a supported, tested host mechanism. Without immediate delivery,
persist inbox entries and surface the limitation. Stop is a single honest handoff,
not an endless block loop. Local status and explicit watch remain useful without
any host integration.

## Migration, acceptance and later task handoff

Migration inventories v1 declarations, policy/provider/scope files, generated
workflows, Git hooks, per-project host assets and their ownership. Preview exact
changed/retired/unprovable assets; take restorable backups before applying. Preserve
native CI/protection, foreign files, dirty worktrees and private fixtures. Stop
old writers before enabling v2 observation; roll back assets/configuration on
failure. No automatic source-branch/issue deletion is part of migration cleanup.

Keep 1.x executable and old draft work available during implementation. Coexistence
uses isolated projects/paths; one initialized project has one active major-version
integration. Reject unconverted 1.x declarations with an actionable migration
report. No legacy flag silently changes its effect. Update all help, schemas,
shipped skills, generated guidance, README/reference/install/migration documents
and package/release metadata before declaring a 2.0 release candidate.

Every acceptance row in the history ledger has an implementation owner. The
integrated matrix must include en/zh, builtin/custom/native templates, all label
modes, many-issue association, no-diff/resume/concurrent edits, default/non-default
and disabled native settings, selected-provider probes, complete check attempts,
real installed hook delivery, cancellation/timeout/restart, ownership-safe
migration, public registry installation and actual Windows process behavior.

The separate development task receives this complete document set and tracker
plan. It first checks current worktree/branch/issue facts, makes a staged executable
plan and implements the Rust target through bound deliveries. It preserves the
old #496 draft and does not infer publication permission. On completion it returns
exact commits/PRs, issue states, current-head CI, real installed-binary evidence,
provider/host acceptance results and remaining limitations. The original task
then independently inspects those outputs; a child task's success summary alone
is not 2.0 acceptance.
