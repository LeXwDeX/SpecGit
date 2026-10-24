# SpecGit 2 native command reference

This reference describes the SpecGit 2 native CLI. Installing it does not
migrate a project or authorize native mutations. GitHub Releases contain the native
executables. The v1 implementation and its engineering gates are retired.

## Responsibility and configuration

SpecGit manages specification Issues, aggregates multiple Issues into one native
PR/MR, and observes native changes. The Agent supervises development and fixes.
GitHub/GitLab decides CI, reviews, protection, actual merge and ordinary closure.
The core, watch and hooks have no merge, Issue-close, branch-delete or settings
administration capability. An authorized Agent uses gh/glab outside SpecGit for
native auto-merge registration or optional supplementary Issue closure.

`.specgit.yaml` is the local project declaration. Local selection, uncertain-write
intents and subscriptions live under the Git directory; they are not remote
completion evidence. A minimal declaration is:

```yaml
version: 2
remote: origin
language: en
agent:
  native_auto_merge: false
  close_issues_after_merge: false
```

Both Agent preferences default to false. Setting them records a preference, not
new authorization. `provider: github|gitlab` is optional where the host is
unambiguous. `target` defaults to the successfully read native default branch.
`language` accepts `en` or `zh`.

Optional `validation` contains `titles`, `bodies` and `labels: off|kind|project`.
Booleans default to false; labels default to `off`. Project labels require a
`tags` catalog of name, six-digit color and optional description. Comma-separated
`--tags` on `issue` and a new `pr` follows this mode; when omitted, selected
repository template labels apply first. `kind` otherwise derives one `kind::<type>`
from the Conventional Commit title, and explicit tags need exactly one kind plus
declared `tags`; `project` requires declared `tags`; `off` adds no mode rule, but
tags must still be catalog, declared or existing labels with one per scoped axis,
and Agents pass them only when the user or project asks. Generated Skill and
SessionStart context state these rules. The `templates`
object selects `issue` and `pr` templates: `source: builtin`, `repository` with a
safe relative `path`, or `inline` with nonempty `body`. Optional `title` and
`required_sections` describe selected content. Final body files override template
body selection. Unselected repository templates are only discovery candidates.

Optional `init_policy.required_checks` lists stable IDs from the current init
report that this project promotes to `required` (for example,
`[target.protection]`). Unknown and duplicate IDs are invalid. The declaration
cannot lower a built-in requirement. This policy changes the diagnosis only;
it does not change forge settings, grant write permission, or authorize actions.

Observation defaults are a 15-second poll, a 1,800-second maximum and
attention/completed notices. `watch` uses explicit `--poll-seconds` and
`--timeout-seconds` values first, then `observation.poll_seconds` and
`observation.max_wait_seconds`, then those defaults. Poll intervals range from
1 to 3,600 seconds; maximum waits range from the poll interval to 86,400
seconds. `inbox` performs one refresh with a 90-second maximum, further limited
by `max_wait_seconds`. Configuration fields are `observation.poll_seconds`,
`max_wait_seconds` and `notify`. Hook notices classify `completed` events as
`completed`; every other event is `attention`. This filter only controls hook
notices: direct `watch` and refreshing `inbox` output retains all event states.
Runtime validation enforces relational timing bounds, unique lists, Git branch
syntax, UTF-8 limits and safe paths. Unknown or
duplicate YAML keys fail. Retired rule-engine configuration must be removed in an
explicitly reviewed migration; platform protection rules remain on the forge.

## Discovery, input and output

`specgit --help`, `specgit --version` and `specgit --schema` work offline, without
Git, forge executables or credentials. `specgit <command> --schema` narrows the
contract. `-h` and `-V` are short help/version forms. The schema comes from the
same command definitions as argv and includes types, choices, bounds, defaults,
visible long aliases for argv, conflicts, required options (`requires`, with any named
group listed under the command's `groups`) and side-effect classification. Engineering qualification generates
`schemas/` from this contract and compares them with the installed executable.
Public ZIPs contain only the executable; use its embedded offline `--schema`.

Global options are `--cwd <path>`, `--json`, `--human`, `--schema` and
`--input-file <path>`. Ordinary non-TTY stdout defaults to a single JSON report;
`--human` forces text. `--json` and `--human` conflict. `hook` uses host-specific
framing and `guard` uses Git-hook exit semantics regardless of ordinary output selection.

Explicit JSON input is one object with `command`, `options` and optional `args`.
The schema's `aliases` array lists visible long aliases accepted in argv; JSON
`options` keys remain the canonical long option names:

```json
{
  "command": "issue",
  "options": {"dry-run": true, "json": true},
  "args": ["21", "22"]
}
```

Save this as a local file and run `specgit --input-file /absolute/request.json`.
`--input-file -` explicitly reads stdin. Ordinary argv never consumes implicit
stdin. `command` can also be an array of command names; option keys are long
names without `--`, booleans are JSON booleans, and positional values belong in
`args`. Input is capped at 1 MiB with a five-second read deadline. Duplicate or
unknown keys, incompatible types and conflicting selectors are errors. Business
argv cannot accompany JSON input; only the explicit global `--cwd`, `--json` or
`--human` selectors can accompany it. Duplicate selectors are rejected.

Ordinary reports contain `schema_version`, `version`, `operation`, `ok`, `status`,
`exit`, `evidence`, `diagnostics` and `next_actions`. `ok` describes operation
success; it is not merge authorization. Diagnostics provide stable `code`,
operation, message and remedy. Raw provider stderr is classified locally rather
than copied into the report. Business code consumes typed library values, not
its own serialized reports.

Human output also displays the remedies in `next_actions`. These are guidance,
not automatically executed operations or new authorization. A typed
`requires_user_authorization: true` marks a write that must be within the task;
existing installation/enablement delegation can satisfy it without another prompt.

| Exit | Meaning |
| --- | --- |
| 0 | The operation or observation succeeded. Inspect native state separately. |
| 1 | The operation failed; use the diagnostic and current evidence. |
| 2 | Invalid input/configuration, or an explicit operating choice is required. |
| 3 | External result or required facts remain unknown/unavailable. |
| 130 | Cancelled; inspect any pending intent before explicitly resuming. |

Collections are bounded. Pagination exhaustion, missing fields and ambiguous
responses do not prove absence. Use object IDs and reported source/identity;
inspect partial or unavailable results before a further action. A preview is not
a reservation or authorization, so real application rechecks current state.

## Commands

Run `specgit <command> --help` for complete argument combinations. All ordinary
commands use the global input/output contract above.

| Command | Purpose and options |
| --- | --- |
| `setup` | Inspect the offline capability catalog or install/update project agent assets. SpecGit 2.4 is permanently project-only: `--scope project` is the default and the only scope value; global/host-integration setup is removed. `--catalog` returns the versioned installation capability catalog without project reads or writes. On a new installation, omitting the repeatable compatibility selector `--agent generic|claude|codex|opencode` selects the shared Skill/entry without new hooks; naming a new host selects its guidance and Skill only. Hooks require explicit `--hook-purpose guard|context`; an existing installation retains recorded choices when purposes are omitted. `--remove-hook-purpose guard|context` removes a purpose from the hosts named by `--agent`, or all recorded hosts if `--agent` is omitted; it cannot select a host not already recorded. `--opencode-claude-hooks` is an explicit custom-host opt-in that requires `--agent opencode`. The retired global selectors `--root`, `--provider`, `--api-host`, the legacy `--register-claude|--register-codex|--register-opencode` forms and the per-host `--claude-settings`, `--codex-root`, `--opencode-root` paths are rejected input. `--dry-run` previews install/update, purpose removal or `--uninstall` without writes or a lock. Uninstall omits `--agent` and removes exactly this worktree's recorded project assets. `--rollback <transaction>` restores owned local assets from the project journal and conflicts with dry-run/uninstall. Written registration is not verified host import or event delivery; Codex trust review remains a user action. |
| `init` | Inspect native capabilities and write the local declaration/guidance. Select `--remote`, `--provider`, `--api-host`, `--target`, `--language`, `--config-file`, `--mirror-claude`. `--check` (alias of `--inspect`) is read-only; `--dry-run` also previews asset paths. `--native-auto-merge true\|false` records an explicit preference; `--manual-observe` selects the manual fallback. `--rollback <transaction>` restores a local transaction. A new project without a setup receipt also installs the native Git guard in its main worktree when Git uses hooks inside the common Git directory, so every commit binds an Issue; `--dry-run` lists its hook paths. Tracked hook directories such as Husky, external `core.hooksPath` locations and linked worktrees need explicit `setup --hook-purpose guard`. A recorded installation keeps its purposes, including an explicit `setup --remove-hook-purpose guard`. |
| `issue` | Adopt positive Issue IDs or create complete specification titles. Repeat `--body-file` in new-title order; optional `--tags` and `--branch`. `--inspect` or `--dry-run` reports preparation and duplicate candidates without local/native writes. After comparing different WHYs, repeat `--reviewed-candidates <review_digest>` for the exact reviewed candidate sets. `--create-labels` explicitly permits missing selected catalog labels to be created. A checkpoint recorded as delivered admits no new Issues on its branch; `--branch <name>` replaces it when it has no pending write. |
| `pr` | Create/resume/discover a PR/MR or adopt `--request <id>` after real pushed changes. Optional `--title`, `--body-file`, `--tags`; explicit `--ready` preserves deliberate associations. `--update-body` and `--update-references` support read-only previews; differing native bodies require platform editing because atomic conditional updates are unavailable. `--inspect` reads preparation; `--dry-run` previews a mutation. `--create-labels` permits missing catalog labels. `--status` reads native lifecycle facts and conflicts with mutation options; `--status --request <id>` permits an exact same-repository read from another checkout. When a verified read shows the current branch checkpoint's recorded request merged, `--status` records it as delivered in Git-private state and reports the `record_delivered_checkpoint` local effect. |
| `watch` | Bounded native observation. Requires `--request`, `--session`, `--goal checks\|lifecycle`; optional `--once`, `--timeout-seconds` (1–86,400; default from project configuration), `--poll-seconds` (1–3,600; default from project configuration). CLI values override configuration. State is always Git-private; the retired `--state-root` selector is rejected. |
| `hook` | Advisory host context with `--event SessionStart\|PreToolUse`. SessionStart briefly states rules and points to the project Skill; PreToolUse adds pending context and recovery guidance without tool denial. Retired PostToolUse/Stop callbacks return quietly before input is read. `--observe` does not launch automatic observation; use bounded watch/inbox. State is Git-private; `--state-root` is rejected. See [hook input and decisions](#hook-input-and-decisions). |
| `guard` | Local Git-hook entrypoint. `--install --dry-run` and `--uninstall --dry-run` preview the same plans without creating hooks, state, directories or locks; use `--json` for machine output. Dry-run requires an install/uninstall operation and conflicts with `--stage`. `--install` merges owned blocks into the effective native/custom hook path and uses Husky's user scripts when `core.hooksPath=.husky/_`; `--uninstall` removes only recorded blocks, and keeps them (reported under `retained`) while an active setup or sibling hook consumer needs the hook directory; `--install` names the owning worktree when shared hooks are owned elsewhere. Existing non-shell hooks are preserved with a diagnostic. `--stage pre-commit` rejects staged changes without a current checkpoint. `--stage pre-push` reads and replays Git's ref-update stdin, validating every branch ref, and requires every new non-merge commit to carry an `Issue: #N` trailer naming a selected Issue; deletions and tag-only updates are outside this checkpoint rule. |
| `inbox` | Read/refresh pending events with `--request`, `--session`, `--goal`. `--no-refresh` lists unverified IDs only. `--ack <event-id>` records explicit transport receipt and conflicts with no-refresh. State is always Git-private; `--state-root` is rejected. |
| `status` | Offline Git identity and local selection. Optional `--remote`, `--provider`; no forge child is invoked. |
| `doctor` | Check local project health and, unless offline, read tool/account/project capability and derive basic Issue/request role permissions from the project response. `--provider` is optional when it can be derived from the selected remote/declaration; `--remote` and `--api-host` are optional overrides. `--offline` skips authentication, APIs, and provider CLI execution. `--fix` repairs only selected, recorded project integrations; `--dry-run` requires `--fix` and previews local changes. `--account-only` requires `--provider` and conflicts with offline/fix/dry-run. Help success does not prove API access, mutation permission, or host behavior. |
| `migrate` | Preview owned v1 retirement using `--config-file <v2.yaml>` and optional `--api-host`. `--apply --expect <digest>` applies the exact reviewed preview. `--retire-only` retains the old declaration for staged cutover. `--rollback <transaction>` restores proven local assets. |
| `remove` | Preview or reversibly remove this project's proven owned local integration. The default and `--dry-run` prepare a read-only preview whose evidence carries a `preview_sha256`; `--apply --expect <digest>` applies exactly that inspected preview as one recoverable transaction; `--rollback <transaction>` restores it offline without configuration or forge access. See [whole-project removal](#whole-project-removal). |
| `update` | Update the running shared executable from a signed GitHub Release. `--check` only reads release metadata; `--dry-run` downloads and verifies without replacement; the default applies. `--version <x.y.z>` selects an exact release; an older one is a downgrade. Requires an authenticated `gh` and Cosign. See [self-update](#self-update). |
| `skill` | Explicit user Skill only: `--user` is mandatory. `--dry-run` previews without writes; `--remove` removes only managed, unedited content; `--refresh-only` skips absent or foreign files and conflicts with `--remove`. See [user Skill](#user-skill). |

The installed executable's `--help` and `--schema` remain its active contract. Editing or building this source does not replace the shared CLI on `PATH`; a separately authorized release and explicit installation/update are required to change that executable.

`doctor` also reports `evidence.local`, a read-only summary of local context, the declaration target and checkpoint state. Its `status` is `initialized`, `uninitialized`, `checkpoint_branch_mismatch` or `not_checked`; checkpoint status is `absent`, `current`, `branch_mismatch` or `not_checked`. A current checkpoint summary contains only `recorded_branch`, `recorded_target`, `issues` and `request`. These are local records, not platform verification or write eligibility. Dirty files and an absent checkpoint are facts, not failures. A missing declaration without recorded private state is reported as `needs_initialization`; a missing declaration with initialized/private integration state fails closed and requires restoring the original declaration. With a branch mismatch and successful API probes, the top-level status is `checkpoint_branch_mismatch` and exit is 0; API probe failures still produce `unknown` and exit 3. Invalid declarations or checkpoints retain their diagnostics and failure exits.

Doctor also reports `evidence.runtime_update` with `status` (`not_checked`,
`up_to_date`, `update_available`, `current_newer` or `unknown`),
`current_version`, `latest_version` (null when unknown) and `diagnostic`
(structured failure detail or null). Online checks, including `--account-only`,
make a bounded read-only metadata request to the stable GitHub Releases endpoint
for `LeXwDeX/SpecGit`; an update is suggested only when a newer stable release
and all required upgrade assets are present, adding `next_actions` kind
`consider_runtime_update`. Offline mode reports `not_checked` and makes
no network request. A failed check is `unknown`, never proof that the installed
version is current. Doctor does not download, cache or install a release, and
`--fix` never upgrades. A friendly update reminder does not change health, exit
status or existing protections, and grants no authorization; use
`specgit update --check` for an explicit follow-up. Release metadata does not
verify the installed executable's signature.

Without `--account-only`, doctor uses explicit provider/remote first, then the local repository identity and declaration as available; stored API routing is used as a fallback, and explicit `--api-host` takes precedence. Account-only mode skips local configuration and checkpoint reads and reports local state as `not_checked`. Local context inspection adds no API calls, fetches or writes.

Project-mode doctor also reports `evidence.health`, `evidence.repair` and `evidence.agent_guidance`. Health checks cover the declaration, selected setup assets, generated guidance, recorded Git-local exclusions, Git guard and static executable paths. Any unknown health check blocks all repair writes; the report keeps independently prepared plans as preview evidence until inspection is complete. Skipped repairs remain in repair results but are not recorded as attempted effects. An unselected integration is `not_selected`; doctor does not guess a host or hook purpose. Recognizable SpecGit host registrations without an ownership receipt are conflicts. An initialized project whose effective hooks lack the native Git guard reports guard `not_installed` with `attention`, because commits can bypass Issue binding; doctor does not install it, and the remedy is `setup --hook-purpose guard`. A project hook executable must be outside every checkout of the same repository, including linked worktrees. `health.status` is `healthy`, `attention`, or `unknown`; `host_behavior` is always `not_verified`. File presence or a registered hook does not prove that an Agent loaded a Skill or that a host event ran.

`--offline` performs local checks without authentication, network/API requests, or launching the provider CLI. The existing probe fields remain present as `not_checked`. `--fix --dry-run` reports typed project-asset plans and writes no files, locks, receipts, or transaction state. `--fix` applies only repair plans backed by a valid declaration and recorded ownership, then rechecks the project. Unknown ownership, damaged receipts/markers, permission or path conflicts remain in place with diagnostics. A missing declaration with initialized private state fails closed and must be restored from its original source. Manually edited content inside a valid owned guidance block follows the refresh contract; arbitrary manual content in a missing whole file cannot be reconstructed, so the repair is refused. A missing owned exclusion block can be restored from proven native integration records, including shared worktree Skill rules; a missing whole exclude file, damaged markers or permission drift remain conflicts. Library-only setup that never selected native exclusions does not acquire them through doctor.

Agent guidance points to evidence and offers bounded next steps; it is advice, not authorization. It allows at most three rounds and stops on unresolved ownership/permission or repeated findings without progress. Suggested commands remain subject to current evidence and existing user authorization. No repair writes the forge or changes platform settings. Exit precedence is cancellation (130), invalid input (2), failed repair/lost-declaration evidence (1), unknown required facts (3), then success (0). Successful doctor status is `ready`, `offline_checked`, `attention_required` or `checkpoint_branch_mismatch`; failures report `unknown` or `repair_failed`. Exit 0 reports that the operation completed, not that every host behavior was verified.

`inbox`, `status`, `doctor`, `migrate` and `update` remain auxiliary entrypoints in this
native CLI. Core project operations are setup, init, issue, pr, watch
and hook. No separate server is required for ordinary Agent use.

## Initialization choices and native limits

`init` reads the actual project/default branch and current request target. Custom
hosts can require an explicit provider. `--api-host` is private worktree routing,
not a shared credential field; SSH and API ports are distinct.

`init --inspect` adds an additive `evidence.checks` list. Each stable check ID
reports its requirement (`required`, `recommended`, `optional`), observed fact
status, presentation (`pass`, `hint`, `warning`, `blocking`), applicable stages,
evidence source/time, `requirement_source`, reason, next step and a nullable
typed diagnostic (`code`, `operation`, `message`, `remedy`). JSON and `--human`
render the same check facts. The `forge.read_access` diagnostic preserves safe
account-read classifications such as authentication, permission, rate-limit,
network and ambiguous-not-found failures; raw command output is never included.
Each check also carries `scope.repository`, `scope.branch` and `scope.commit`.
The repository is the normalized native identity (`provider`, `host`, `path`),
and branch/commit identify the local checkout that was inspected. A detached
HEAD has a null branch; unavailable identity fields are explicit nulls. The
per-check scope does not repeat local filesystem paths or raw remote URLs. Check
impact remains represented by requirement, status, presentation and applicable
operations, with `evidence.operation_assessments` listing reported blockers,
unverified requirements and warnings. Scope does not imply authorization or
readiness for an operation.

`init --inspect`, `issue --inspect` and Issue creation duplicate preflight share
a 120-second monotonic invocation budget. Each executed `init` probe reports
`elapsed_ms`; `evidence.inspection` reports total elapsed time, executed native
read requests, per-process activities, and whether the inspection completed or
exhausted its budget. Candidate reports add their elapsed time and pagination
counts (`pages_fetched`, `items_seen`, `page_limit`, `complete`). `not_run` and
`not_applicable` are explicit states. An incomplete or timed-out Issue search
cannot supply candidates to a create operation, and no Issue, label or local
selection write begins before preflight completes. The short budget override is
available only in test-fixture builds.

This first-stage list maps facts already collected by init; it does not perform
Issue duplicate searches or permission writes. `issue.duplicate_read` remains
`not_checked`. Basic Issue/request role permissions come from the existing
project GET response. GitHub Issue writes need `has_issues` and at least one true
`permissions.pull`, `triage`, `push`, `maintain` or `admin`; applying labels needs
triage or higher. Request writes need `permissions.push`, `permissions.maintain`
or `permissions.admin`. GitLab uses the
maximum of `permissions.project_access.access_level` and
`permissions.group_access.access_level`. Issue writes need `issues_enabled` and
level >= 10; MR writes need `merge_requests_enabled` and level >= 30. An explicit
null GitLab membership paired with a known membership is absent (level 0).
When both memberships are null, effective role evidence is `unknown`; the
response does not establish the user's access through other mechanisms.

The project probe and account probe (when project data was read), plus doctor's
`evidence.write_permissions`, contain `issue` and `request` records with
`status`, `source`, `reason` and `remedy`. Status is `supported`, `unsupported`
or `unknown`. Account-only doctor keeps `not_checked`. No extra API call, write
probe, token-scope check or cross-invocation cache is used. Missing or malformed
fields remain unknown unless a known sufficient role proves the threshold or a
known disabled feature/insufficient role proves lack of support. Source names
the role-permission fields. Role support is not authorization; fine-grained
token scopes and branch protection can still reject writes.
Doctor's `ready` status describes successful required read probes, not write
readiness or success of every optional diagnostic.

### Issue Milestone context

`issue <exact-id> --inspect` and `--dry-run` include `evidence.milestones`,
keyed by each read Issue number (GitHub) or IID (GitLab). This also covers
Issues read from an existing checkpoint. Each entry has `status: linked`,
`none`, or `unknown`. Native `milestone: null` means `none`; missing or malformed
data means `unknown` with a `reason`. Neither state blocks Issue selection.

A linked entry contains `milestone` with `provider`, native `id`, `title`,
`state`, and `url`. GitHub also supplies its distinct `number`; its native URL
must match the selected host, repository (case-insensitive), and number.
GitLab supplies its distinct `iid` and `scope`: either
`{kind: project, project_id}` or `{kind: group, group_id}`. A project Milestone
must match the Issue's project. Group Milestones remain group-scoped, not
project-scoped. GitLab `url` may be null: embedded responses need not supply
`web_url`, and a group ID alone cannot verify a group URL path. Only exact,
verified native HTTP(S) resource URLs are exposed, without credentials,
queries, fragments, or control characters.

This context comes from the existing Issue response. It adds no requests,
Milestone enumeration, writes, selection fields, or candidate digest inputs.
It is not persisted in checkpoints. Missing context does not imply lack of
permission; a Milestone's closed state does not prove delivery completion.
Milestones are optional. Maintain them explicitly with the native platform
tools. These fields do not change PR/MR, watch, merge, or release rules.

### GitLab environment context

For GitLab, `doctor` (including `--account-only`) and `init --check` / `--inspect`
add optional `evidence.environment` after core native reads. This is separate
from required `probes`, init check IDs, availability and exit decisions. Normal
init, including dry-run, makes no extra metadata request. GitHub reports null
and makes no extra read. If core initialization stops before these reads finish,
the environment field can be absent; absence is not a successful metadata read.

The environment report contains `host`, `metadata_status` (`known` or `unknown`),
`diagnostic`, and four independent facts: `deployment`, `server_version`,
`edition` and `subscription`. A fact has `status: known`, `value`, `source`, or
`status: unknown`, `reason`, `source`. One bounded authenticated `GET metadata`
uses the existing native read transport and inspection budget. It exports only
the validated version string (1–128 ASCII version characters, starting with a
digit) and the explicit `enterprise` boolean as `ee` or `ce`. It does not export
raw metadata, revision, KAS details or credentials. It never reads admin/license
endpoints. [GitLab metadata](https://docs.gitlab.com/api/metadata/) does not
provide a subscription tier, so `subscription` is always unknown with a reason.
An `-ee` version suffix does not establish edition or a paid tier.

Only the exact host `gitlab.com` establishes `deployment: official_hosted`.
Other hosts remain unknown; they do not prove self-managed or Dedicated.
Missing or invalid fields retain unknown facts and a typed malformed-response
diagnostic; valid sibling fields remain evidence. Unreadable metadata (including
403/404 and transport failures) remains unknown with the native typed diagnostic,
never `not_checked`. Failed or incomplete metadata keeps the init inspection
summary incomplete, but does not change required-probe readiness or exit status.
Unknown environment information is not evidence of insufficient capability.
Conversely, a known version or edition grants no feature support, permission or
authorization; actual capability and role checks remain independent.

`issue.write_permission` and `request.write_permission` map supported roles to
`verified` / `pass`, insufficient roles or disabled features to
`not_configured` / `blocking`, and unknown facts to `unknown` / `hint`.
The blocking presentation affects only the dependent operation or availability
layer, not the init exit status or unrelated local development. Unknown role
facts also do not stop local initialization. A readable account endpoint alone
proves neither write access nor merge eligibility. Target-protection uncertainty
is a warning unless project policy makes that check mandatory.
When initialization reaches the native probe stage but cannot read the selected
CLI, project, default branch or current request, the failure report keeps this
same typed check list and the facts collected before the failure. Local context
alone does not verify native project identity. A failed request read remains
unknown, including when request eligibility is required; only a successful
request resolution with no applicable request yields `not_applicable`. The
affected check preserves the native failure diagnostic. During inspection, a
context-resolution failure also emits checks with explicit null scope fields.

`evidence.availability` reports three ordered, independent layers:
`specification_development`, `protected_delivery` and `delivery_completion`.
Each layer lists the init check IDs it considered, any directly observed facts,
blocking and unverified conditions, warnings, and a next step. `ready` means the
reported facts contain no blocker, unknown requirement or warning; `blocked`
means a required init check is blocking; `unverified` means a needed fact is
unknown, not checked or warned. These conclusions are scoped to facts already
collected by this read-only command. They do not change the command exit status
or grant permission.

Local specification development is assessed independently from remote request
writes, CI and target protection. Protected delivery remains unverified while
request write access or current required-verification evidence is unknown; a
target-protection warning also keeps that layer unverified unless the project
promotes it to a required check, in which case it blocks that layer. Init does
not probe CI. The `ci.required_verification` entry means actual platform
requirements remain to be checked; missing optional CI is not a prohibition.
Delivery completion remains unverified because init does not read
back a merged native request or every associated Issue's closure. Installed
acceptance applies only when the project requires it, not as a universal condition. An observed open request is listed as a
fact but does not establish completion. The three layers are never collapsed
into one overall-green conclusion.

`evidence.operation_assessments` summarizes those checks per operation. Each
entry lists relevant checks, required blockers, required facts still
unverified, and nonblocking recommended warnings. `blocked`, `unverified` and
`no_reported_blocker` apply only to the
listed init checks; a clear entry is not a claim of write permission, complete
CI readiness, or completed delivery. A recommended or optional warning cannot
block unrelated local diagnosis. Supported role permissions establish only the
basic role threshold. Actual authorized writes and uncertain results still
require current native evidence and readback.

Capability records use `supported`, `unsupported` or `unknown` with source and
reason. Unsupported/unknown native flow returns `confirmation_required` before
project writes unless an explicit manual fallback was selected. The report remains
available with `--check` or dry-run. Configure the platform using an authorized
native administrator action, recheck, or choose `--manual-observe`. That manual
choice persists for subsequent refreshes. No default branch is guessed, and init
never changes native settings, protection or CI.

GitHub `allow_auto_merge` reports a repository setting, not a request guarantee.
GitHub target protection first reads the active rules that apply to the target
through `GET /repos/{owner}/{repo}/rules/branches/{branch}` with bounded pagination.
A complete, valid nonempty result proves readable effective Rulesets. An empty
result falls back to traditional branch protection; it does not prove the branch
is unprotected. Failed, malformed or incomplete Rulesets reads remain unknown.
Readable protection is not an exhaustive ruleset/queue/approval assessment and
does not promise request eligibility. These probes use only GET requests.
GitLab project metadata currently does not prove native auto-merge support; its
status remains unknown without a guessed version threshold. A non-default target,
disabled closing or unknown instance rules can leave Issues open after merge.
The actual native request and Issue states must be read back.

## Ordinary work and uncertain writes

Search for duplicate Issues and read their WHY before creating new ones. Select
complete specifications, then preserve their closing references in one request:

For the same WHY, adopt the native Issue ID. If similar candidates cover different
work, `issue --inspect` supplies a `review_digest` for each proposed specification.
After comparing their contents, repeat the creation command with
`--reviewed-candidates <review_digest>` for each reviewed set. The digest binds
the proposed content, project, source/target and current native candidate contents;
changed evidence requires another review. It does not override uncertain prior
writes, which still require exact native adoption.

Each title's `evidence.candidates[]` entry keeps open candidates in `issues` and
adds a separate `history` list. History is the first native closed-Issue search
page in the selected repository, with at most 20 rows in platform search order.
Each row has `id` (GitHub number or GitLab IID), `title`, `state: "closed"` and
`updated_at`. `url` is included when available; GitHub `state_reason` is included
when present. No history row enters `review_digest`, gates creation or serves as
an adoptable open candidate. GitHub open candidates retain authoritative per-Issue
reads; GitLab open candidates use the authoritative list rows and validate their
project ID.

`history_diagnostics` is an array of `{code, operation, message, remedy}`. A failed
or malformed history read leaves `history` empty and records its diagnostic,
without failing the open-candidate result. History reads count in
`requests_executed` and `elapsed_ms`; `pagination` describes only the complete open
search, not the bounded history sample. The invocation budget and cancellation
still apply. History is reference evidence, not a complete or authoritative
record of all closed Issues.

Implicit source-branch request lookup prefers open requests and rejects several
open matches as ambiguous. Terminal requests are considered only when no open
request exists and their head equals local `HEAD`. A reused branch with new
commits can therefore prepare a new request. Explicit `--request` and recorded
request identities remain available for delivery readback. GitLab candidates
must belong to the configured project on both source and target; fork MRs do not
participate. GitHub candidates with a deleted source repository are skipped.

GitHub duplicate queries remove a recognized Conventional type prefix, neutralize
qualifier syntax in the remaining title, and search it as a quoted `in:title`
phrase. Open and historical search rows must identify the configured repository.
GitHub label pool lookup and write readback compare ASCII case without changing
native label spelling in reports. New labels use the selected canonical spelling.
GitLab label comparisons remain case-sensitive.

Closing references use each provider's default keyword set. GitLab additionally
recognizes `Implement`, `Implements`, `Implemented` and `Implementing`.
GitHub treats those words as ordinary prose. Custom GitLab closing patterns remain
unconfirmed. Fenced code and HTML comments cannot contribute references; comment
markers inside fenced code or a closed inline code span do not hide later prose.
Unsupported closing-like prose still requires explicit reconciliation.

GitLab description readback permits its CRLF-to-LF conversion and removal of
trailing ASCII spaces, tabs and line endings after a write. Leading indentation,
Unicode whitespace and other content changes are not treated as equivalent.
Comparisons between two native snapshots remain exact.

```sh
specgit init --provider github --manual-observe --dry-run --json
specgit init --provider github --manual-observe --json
specgit issue 21 22 --dry-run --json
specgit issue 21 22 --json
```

After committing and pushing actual implementation through Git:

```sh
specgit pr --title 'feat: implement selected specs' --body-file /absolute/request.md --dry-run --json
specgit pr --title 'feat: implement selected specs' --body-file /absolute/request.md --json
specgit pr --ready --dry-run --json
specgit pr --ready --json
specgit pr --status --json
specgit watch --request 42 --session task-42 --goal lifecycle --json
```

SpecGit does not create binding-only commits or silently push source changes.
Native auto-merge registration belongs to an already authorized Agent gh/glab
action outside these commands. The preference does not authorize a new session.

Issue/request writes retain intent before submission. On an uncertain response,
resume the same selection/request to reconcile native state; inspect ambiguous
matches rather than submitting again. Request body updates preserve user content
and deliberately associated Issues. Cross-project or conflicting identities are
rejected rather than guessed. A read-only probe never establishes write permission.
The user's authenticated gh/glab session provides forge access; SpecGit does not
store credentials. Forbidden or ambiguous 404 responses do not establish absence.

### Branch switches and checkpoint ownership

A delivery checkpoint belongs to one branch in one worktree. Switching branches
with Git does not move or reset it. `status` can report
`checkpoint_branch_mismatch` with the current context, a null active `selection`,
and a `checkpoint` summary containing its path, recorded/current branches,
recorded target/project ID and pending-write flag. Offline status keeps
`remote_state: not_checked`; native operations separately verify project identity. A detached checkout reports a null current branch. This
successful read is not permission to write: `write_eligible` is false.

On another branch, `issue --inspect` and `issue --dry-run` prepare only the current
invocation's specifications and read duplicate candidates. They return
`prepared_blocked`, `writes: false`, `write_eligible: false` and the checkpoint
summary. They do not inherit the other branch's Issues or pending intents, create
a lock or update the checkpoint. Exit 0 means the read/preview succeeded; this
blocked preview cannot be applied in that worktree's current branch.

Resume the original delivery on its recorded branch, or use a separate worktree
for independent work. Mutations still reject mismatched ownership, and their
locked concurrency rechecks remain in force. Malformed checkpoints and repository
identity mismatches remain errors. Do not delete a checkpoint, rewrite its branch
or discard unresolved write intent to get past these checks.

### Commit binding and delivered checkpoints

Every commit binds an Issue. The installed pre-commit guard requires a current,
complete checkpoint. The pre-push guard also requires each new non-merge commit to
carry an `Issue: #N` trailer for a selected Issue, for example
`git commit --trailer "Issue: #12"`. New commits are those not reachable from any
remote-tracking ref or the local target branch. Merge commits, deletions and
tag-only updates are exempt; more than 1,000 new commits fail closed. `git commit --trailer`
needs Git 2.32 or newer; on older Git, end the message with an `Issue: #N` line. The trailer
keeps the binding in history after the local checkpoint is gone. It does not close
the Issue; squash merges keep the request's closing references as the binding.
Do not bypass the guard with `--no-verify`.

When `pr --status` or `watch` verifies that the request recorded in the current
branch checkpoint is merged (`merged`, `completed` or `merged_issues_open`), it
records `delivered_request` in the checkpoint. A checkpoint without a recorded
request (for example, a request created outside `specgit pr`) is never retired.
The record is local, grants nothing and makes no forge write; `watch` records it
best effort, so confirm with `pr --status`. The guard then rejects new commits and
pushes on that branch. `issue` on the delivered branch fails. Switch to the updated
target branch and run `issue <spec> --branch <name>`: a branch cut from the old
branch may carry squash-merged commits that pre-push treats as new. A delivered
checkpoint without pending writes gives way to that new selection. Incomplete reads,
other requests, other branches and pending writes leave the checkpoint unchanged. The Rust
`Selection` type gains the optional `delivered_request` field.

## Observation and host delivery

`pr --status` reports lifecycle facts such as `open`, `closed_unmerged`, `merged`,
`completed`, `merged_issues_open` or `unknown`. Check outcomes describe observed
checks only; the runtime does not reconstruct native merge eligibility. A merged
request with open linked Issues produces attention. Agent supplementary closure
is optional, defaults off, and requires existing authorization plus native
readback of merge, intended associations and resulting Issue closure.

For GitHub, the complete current-head check-run pages are validated before
selecting the highest native run ID for each `(app ID, check name, check suite)`
context. Older attempts in one suite do not determine `pr --status`, `watch` or
`inbox` outcomes. Same-named jobs from different Apps or suites remain separate,
because the forge treats those as independent or ambiguous checks. Incomplete
pages, repeated IDs and mismatched heads remain unavailable evidence. The native
check-run ID lets an operator inspect a superseded attempt on GitHub.

With an explicit `--request`, `pr --status` reads the exact request from the
configured repository even on another branch, detached HEAD, or after its source
branch is deleted. The report keeps native request status separate from
`evidence.local_applicability`, which reports source-branch, local-head and target
mismatches; `evidence.request.target` is the native target and `evidence.target`
is the local configured target. A native `completed` status does not certify the current checkout.
Without an explicit ID, status remains local-checkpoint/branch scoped. `watch`
also stays bound to the current worktree; use `pr --status --request <id>` for
cross-branch reads. Fork and cross-project reads are unsupported.

A GitHub workflow without visible check runs contributes its own status: queued
or running remains pending, and a completed workflow succeeds only with native
`conclusion: "success"`. GitLab `canceling` and `waiting_for_callback` remain
pending. Unknown native check states remain unavailable and retryable within the
watch budget; they never prove passing checks.

Issue associations retain per-Issue sources: `native_closing`, `body_reference`
and `local_selection`. The native source comes from the platform's closing-Issue
query; unavailable queries remain diagnostic evidence, never an empty successful
result. Unsupported body-reference syntax adds a diagnostic while retaining the
request and any separately read native association/Issue facts; mutation commands
still reject that syntax. Local selections apply only to their exact request ID. Explicitly observing
a different request does not inherit the previous request's selected Issues.
Association changes participate in watch event revisions, including source changes
that leave the set of Issue IDs unchanged.

Watch subscriptions and stable event IDs are session/worktree scoped. Pending
notices are refreshed before delivery and superseded by changed evidence.
`--goal checks` observes checks without claiming lifecycle completion. `--once`
performs one read and retains pending intent. Explicit inbox acknowledgment is a
transport receipt, not human reading, approval or permission to mutate.
Within one polling process, an unchanged complete collection may reuse the
previous poll's verified fingerprint. Changed evidence and terminal states still
require full readback before publication. This fingerprint includes private native
facts, not only the durable event projection, and is never restored from disk.
`pr --status`, `watch --once` and one-shot inbox refresh always perform full
readback. The polling transport reuses one declaration snapshot per cycle for
its digest, local context and event projection; native consistency checks retain
their independent workspace revalidation.
Each watch event includes the legacy `next_action` text and a typed `next_step`;
the report-level `next_actions` repeats those same typed steps for direct
consumers. The action records the goal, check outcome, draft state, auto-merge
registration, open Issue IDs and diagnostic codes used to form its message.
Drafts with passing checks suggest ready-for-review under the existing task
authorization; they do not approve or merge. Running or absent optional CI does
not itself prevent review preparation or ready. The Agent checks actual platform
requirements before delivery; an explicit checks goal with no results remains
unobserved, not passed. Ready requests distinguish registered,
unregistered and unknown auto-merge state, and never infer review, merge or
delivery completion from passing checks. Merged requests with open Issues name
those IDs; a merged request without verified closing facts remains unknown.
Once native evidence shows the selected request merged or closed, later local
commits or edits keep that lifecycle result and the revision retains the local
head. A completed request replaces its next-step message with bounded recovery
guidance: the merged request accepts no new work, and additional work starts
from a new branch or worktree with a new Issue selection. Merged requests with
open Issues keep the unresolved inspection text and issue IDs; the same
local-divergence guidance is recorded in the event reason, so the action message
stays within its 1024-byte storage limit. Unknown closure keeps its verification
step and records in the reason that current request and issue facts must be
verified first; that guidance covers only additional local work. Closed-unmerged
requests keep the explicit reopen or follow-up choice and state that a push
cannot reopen them. These notes never claim a checkpoint was saved. Open
requests keep the existing local-ahead and dirty pending behavior. Watch, inbox
and Hook actions are advisory and never ready, merge or close anything
automatically.

Project setup-managed host hooks use only SessionStart and PreToolUse. Context
purpose registers both. Guard purpose installs native Git pre-commit/pre-push
checks independently of host callback support. Observe remains a recognized
purpose but is reported declined: no automatic observer or idle wake is installed.
Use Agent-run bounded watch/inbox for that work. Refresh removes owned legacy
PostToolUse/Stop entries while preserving foreign hooks and ownership proof.

Codex and custom OpenCode use complete shell command strings with no separate
`args` array. POSIX paths are single-quoted; Codex on Windows uses cmd quoting
and rejects `%`, `!`, quotes and controls in executable paths. Claude uses its
executable-plus-`args` form. Custom OpenCode requires `--opencode-claude-hooks`
and writes project `.opencode/hooks.json` with `inputFormat: claude-code`.
The legacy `--opencode-async-rewake` flag never restores retired events.
`${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` are rejected in custom
OpenCode executable paths because the host expands them before shell quoting.
Official OpenCode and generic hosts receive guidance/Skill without host callbacks;
the native Git guard is available independently.

Registration is `written_not_verified`; import and model-visible context need
real host evidence. Earlier host qualification is retained in
[host evidence boundaries](../docs/supported-tools.md#observed-custom-host-behavior).
Those historical results do not qualify new registrations. No daemon, webhook
service, automatic retry or Stop wake is installed.

### Hook input and decisions

SessionStart and PreToolUse accept one bounded JSON object with matching
`hook_event_name`, a valid `session_id`, and absolute `cwd`; `schema_version`,
when present, must be 1. Input is capped at 1 MiB with a two-second read deadline;
context handling has a 2.5-second deadline. Invalid input or unreadable local
state emits a diagnostic, never a block or permission decision. Ordinary file,
shell, Issue-planning and read-only tools run without an edit checkpoint gate.
Commit/push checkpoint failures arise from the installed native Git guard and
are handled by the Agent from the tool result.

SessionStart emits short rules, the project Skill reference, current branch and
selected Issue IDs. PreToolUse does not repeat these rules. Both can offer pending
notice IDs or recovery for uncertain native writes; those receipts are explicitly
unverified and require inbox/native refresh before use. Context is scoped to the
actual current branch. A checkpoint for another branch is preserved and is not
used for automatic notices. These paths never fetch forge state or acknowledge
notices. Repeated identical text is suppressed per session/event in bounded,
Git-private offer records; an offer is not evidence of reading or delivery.

Output uses `hookSpecificOutput.hookEventName` and `additionalContext` only when
context is available. Hook diagnostics do not request another conversation turn.
PostToolUse, Stop and other retired callbacks return quietly before reading
stdin, resolving Git, locking assets, contacting a forge or changing state,
including when invoked with the legacy `--observe` flag. An allowed event with
`--observe` emits an unsupported-observation diagnostic and recommends bounded
watch/inbox. The public `observe_handle` compatibility entry follows that rule.

### Manual OpenCode imports

`/import-claude-hooks` in the custom fork is an interactive LLM prompt: it
reads the project's Claude settings and asks about each entry individually; it
is not an automatic read. When native `setup` already owns those hook entries,
do not import them again as unmanaged duplicates; preserve or reconcile
manually edited hooks and foreign content instead.

## Assets, migration and installation

Setup uses exact asset hashes and recorded host groups. Before refresh (including
a no-op) or uninstall, it proves transaction ownership and recorded permissions
for every managed Skill, guidance file and hook settings file. A permission
mismatch is an ownership conflict; the operation leaves the asset and receipt
unchanged and does not restore permissions or adopt the current state. This
tightens behavior for existing integrations whose recorded and current
permissions differ; resolve that state through a separate explicit maintenance
decision before retrying setup. Foreign content and hook ordering survive
refresh/uninstall. Dry-run performs no mkdir, asset lock or write. Real apply
rechecks content/permissions after locking, uses atomic replacement and saves
restorable private preimages. Edited ownership or interrupted transactions
require explicit recovery. Rollback refuses later conflicting edits; uninstall
retains backups and unrelated directories.
The same paired receipt/permission proof governs whole-project `remove`: its
read-only preview reports conflicts without writes, and apply requires the exact
reviewed `preview_sha256`. Any edited managed content rejects the whole removal;
preserve it for reconciliation. Removal rollback still refuses later edits and
restores only when its transaction evidence matches.
Rollback keeps guard assets while the current setup or another worktree still
uses them. Its journal preserves the complete original history and records the
exact retained entries in `retained_paths` with state `rolled_back_retaining`.
Only those entries can still prove ownership; a later rollback checks consumers,
content and permissions again and processes only the remaining retained entries.
An empty retained set completes ordinary rollback. Once the journal is
`rolled_back`, repeating that transaction reports zero changes and never replays
its entries against later files. Invalid or ambiguous journal
state remains a conflict, never permission to restore unrelated paths.
CLI 2.14 writes journal version 3 with `created_directories`, recorded
permissions and directory identity. On Unix, identity uses device/inode and
birth time; on Windows it uses the safe file ID and birth time. Cleanup requires
the identity, permissions and emptiness to match. Only CLI 2.14 or newer can
recover version 3 transactions. If identity is absent from an older version 3
journal or cannot be read, rollback keeps the directory; a crash before the
identity is saved can also leave a safe empty directory behind.
Version 2 journals remain recoverable, but contain no created-directory proof.
Do not infer which directories an older transaction created or remove them during
rollback; retain them when ownership cannot be proven.
Project setup is local and does not probe account readiness or forge write
permissions. Use explicit `doctor` and native delivery inspection for those
facts; successful setup is not verified host registration or delivery.

### Self-update

`update` reads `LeXwDeX/SpecGit` releases on github.com through the
authenticated `gh` CLI only. Without `--version` it selects the latest stable
Release; drafts are never used. The same version is a no-op (`up_to_date`), and
a running version newer than the latest Release reports `current_newer`.
Unsupported platforms fail; Releases exist for macOS arm64, Linux x64 glibc and
Windows x64.

`--dry-run` and apply download the platform ZIP, `SHA256SUMS` and
`SHA256SUMS.sigstore.json` into a fresh temporary directory with bounded sizes.
Cosign `verify-blob` must accept the manifest for the release workflow identity
and GitHub OIDC issuer shown in the [installation guide](../docs/installation.md).
The ZIP must match its single manifest row. It must contain exactly one regular
`specgit` (`specgit.exe`) entry, and that executable must report the target
version with `--human --version`. Missing Cosign, any mismatch, a missing asset
or an oversized file stops with no replacement; there is no skip option.

Apply replaces only the executable that is running, never a project copy. An
unwritable directory fails before download. The previous executable is kept
beside it as `specgit.backup-<previous-version>` (before `.exe` on Windows).
Unix renames the new file over the executable atomically; Windows renames the
running file aside first and restores it if the move fails. The installed file
is read back by hash and version. Evidence reports the backup path. To roll
back, move the backup over the executable path. Project configuration is not
changed; refresh projects as described in the installation guide.

After successful replacement and readback, both `updated` and `downgraded`
reports add `next_actions` with `kind: "refresh_project_skills"`,
`command: "specgit setup"` and a `remedy`. Human output displays the same remedy.
It says existing project Skills **may need** refreshing, not that a specific
Skill was checked or is stale. Run setup in each relevant project, previewing
with `specgit setup --dry-run`. Setup refreshes recorded assets and complete,
unique managed blocks when ownership and boundaries are proven, including edited
body text. It preserves bytes outside blocks; unknown ownership, damaged/duplicate
markers and missing recorded assets remain conflicts. This does not authorize
uninstall or rollback to erase later edits. Update does not invoke
setup, scan projects or refresh any project asset. Checks, previews, no-op and
failed updates do not report this successful-replacement guidance.

After successful installation, update checks only whether the user Skill has a
valid managed marker. If it does, the **new executable at its installed path**
runs `skill --user --refresh-only --json` through bounded, shell-free process
transport (20-second timeout, bounded input/output). Absent or foreign files are
skipped without spawning a refresh. The new CLI rechecks ownership and uses its
own embedded Skill bytes. `evidence.user_skill` reports `refreshed`, `skipped` or
`failed` and the parsed child report; `effects` records the attempted refresh and
its reported writes/backups. `next_actions` includes `user_skill_refresh`.
Refresh failure keeps the verified new executable, reports a diagnostic and gives
`specgit skill --user` as the remedy. Update still succeeds as a binary install;
that does not claim the Skill refresh succeeded. Check, dry-run, no-op and failed
installs never refresh the user Skill. A downgrade to a CLI without `skill` can
therefore install successfully while reporting a refresh failure.

### User Skill

Project integration remains project-only. The only user-level asset is the
explicitly installed Skill file; no global hooks, state or receipts.
`init`, `setup`, hooks and other project commands never install it.

```sh
specgit skill --user --dry-run --json
specgit skill --user --json
specgit skill --user --refresh-only --json
specgit skill --user --remove --dry-run --json
specgit skill --user --remove --json
```

The fixed target is `$HOME/.agents/skills/specgit-native/SKILL.md` on Unix and
`%USERPROFILE%\.agents\skills\specgit-native\SKILL.md` on Windows. A missing,
relative or unavailable home is invalid input with no writes. Symbolic links
anywhere below the resolved home are refused, including a dangling file link.
No Git repository or declaration is required.

Installation uses the same embedded Skill as project setup. Its final line is
`<!-- specgit:managed sha256=<64 lowercase hex digits> -->`; the digest covers
every byte before that line, including the preceding newline. A valid marker
line establishes ownership. A foreign file (no valid marker) is a conflict and
is never adopted. A managed file is refreshed to the current embedded content.
If its body hash differs, or content was appended after the marker, refresh first
preserves the exact old bytes and permissions in a sibling
`SKILL.md.specgit-backup-<unix-seconds>` file, with a unique numeric suffix when
needed. The backup path is in `evidence.backup` and `effects`. Backups are never
silently replaced or removed.

Writes are staged and synced in the same directory, then atomically published.
New-file publication never clobbers a concurrently created file. Existing-file
replacement preserves permissions and rechecks current content after locking
the Skill file itself; it creates no global lock file or receipt. Dry-run reports
`prepared` with the planned `action` and `edited` flag, but creates nothing.
Refresh-only reports `skipped` for absent or foreign content. Remove preserves
foreign or edited files as conflicts; it deletes only managed, unedited content
and its empty leaf Skill directory, never unrelated files or parent directories.
Successful actions report `installed`, `refreshed`, `removed` or `skipped` under
operation `skill`. Every invocation emits one ordinary report with `effects`.

### Agent integration scopes

The single `specgit-native` Skill covers new specification tasks and taking over
existing PR/MR CI and review repair. It defines tool choice, testing, feedback,
waiting and completion against the user's scope. Native tools can carry out the
workflow without the optional binary; installed declarations, guards and
checkpoints still apply. Project entry prompts point to this Skill rather than
duplicate its workflow. A review or local repair is not a platform-delivery
claim; a platform-delivery goal requires current evidence and native readback
of merge and closure of the associated Issues that should close.

`setup --catalog --json` returns `status: "catalog"` and
`evidence.installation_catalog`. Discovery is offline, needs no project or
external CLI, and performs no project reads, host probes or writes. `--human`
renders the same typed catalog. Catalog mode conflicts with `--agent`, `--hook-purpose`,
`--opencode-claude-hooks`, `--opencode-async-rewake`, `--uninstall`, `--rollback`
and `--dry-run`.

The versioned catalog describes eight capabilities: `project_skill`,
`instruction_entry`, `session_context`, `tool_context`, `git_guard`, `observation`,
`local_exclusions` and `private_state`. Each item records its purpose, requirement
level, scope/location, prerequisites, commands, protocol, ownership, verification,
fallback and lifecycle. `shared_baseline` groups the project Skill and stable
instruction entry; its members are installed and maintained together, not exposed
as independent file switches. `.agents/` is the recommended shared project area;
its presence does not prove that a host loads it. Verify written assets, host
loading and actual effects separately, and re-read the Skill after compaction when
needed. Agent-managed custom host configuration remains outside SpecGit receipts,
refresh/removal and doctor checks. Existing recorded named-host integrations retain
their ownership lifecycle. Setup alone does not create the declaration or prove
initialization; run `init` for each clone/worktree.

`setup` records repeatable `--agent generic|claude|codex|opencode` under
`--scope project` (the default and only scope value). Unsupported or duplicated
choices fail before any write. Without a named selector, a new installation uses
the shared project Skill/entry and adds no hooks; a recorded installation refreshes
its existing choices. These selectors remain compatibility paths rather than a
requirement to name a host. The
retired global integration scope and its selectors — `--root`, `--provider`,
`--api-host`, `--register-claude`, `--register-codex`, `--register-opencode`,
`--claude-settings`, `--codex-root` and `--opencode-root` — are rejected input,
not deprecated aliases.

Project scope resolves the Git checkout root and the private absolute Git
directory. Its receipt stays at `<git_dir>/specgit-v2/agent-assets/ownership.json`;
ordinary init/setup/guard transactions use the same per-worktree `<git_dir>/specgit-v2/assets/` store.
Both `init --rollback <transaction>` and `setup --rollback <transaction>` can
restore an exact transaction from this store, regardless of which of those
commands created it. Recovery restores the whole recorded transaction, subject
to ownership, later-edit and active-consumer checks; it is not a command-specific
uninstall. Review the transaction's paths before recovery.
When a setup-guard owner retires while other worktrees still need its hooks, that
retirement transaction and the retained guard receipt move to the fixed
`<common_git_dir>/specgit-v2/shared-setup-guard/<hook-identity>/` namespace, selected
by the verified canonical hook directory's SHA-256. Its `assets/` journal keeps the
guard proof reachable after the original worktree is pruned. Later transactions
that change this shared guard receipt use the same store; ordinary host maintenance
keeps its worktree store. CLI recovery
can locate an exact transaction ID in the current worktree or this shared store.
Applying it still requires the original worktree and its allowed paths; ambiguous
IDs and paths outside those roots remain conflicts. Recovery never recreates
pruned Git metadata or grants access to another worktree's files.
If `core.hooksPath` changes while such custody is retained, setup, `guard`
install/inspection and exact-ID recovery report a conflict instead of treating the
old custody as absent. Restore the recorded hook directory, then uninstall or
recover. An unfinished shared-custody transaction blocks guard ownership transfer
until it is recovered. Setup, init and exact-ID recovery recheck the Git worktree
list before each write, so a worktree added concurrently aborts the change.
Other receipts and transaction histories remain worktree-specific. Legacy
`agent-assets` journals remain available as bounded ownership/recovery evidence. It writes the canonical
`.agents/skills/specgit-native/SKILL.md`; Claude adds a managed
`.claude/skills/specgit-native/SKILL.md`, root `CLAUDE.md` guidance and
`.claude/settings.json` hooks; Codex adds root `AGENTS.md` guidance (or an
existing nonempty `AGENTS.override.md`) plus `.codex/hooks.json`; generic and
official OpenCode add only the `.agents` skill and root `AGENTS.md` guidance,
with no hooks. With `--opencode-claude-hooks` (requires `--agent opencode`),
setup additionally generates project `.opencode/hooks.json` for a custom fork
as described under [hook input and decisions](#hook-input-and-decisions). When
selected hosts share `AGENTS.md`, one receipt owns the merged block.
Setup-managed project instruction blocks use the
`<!-- specgit:project:v2:start -->` / `<!-- specgit:project:v2:end -->`
markers; a 2.3-era receipt whose block still carries the old
`specgit:global:v2` labels is refreshed in place to the project labels, and an
unowned marker is an ownership conflict, not a target. Refresh migrates proven
legacy init `<!-- specgit:v2 -->` blocks and setup blocks to one stable project
entry in the same transaction. It preserves every byte outside the owned blocks.
The entry points to the project Skill and includes an initialization command and
an official installation link for a missing shared CLI. Runtime versions,
declaration summaries and dynamic hashes are not embedded in the entry.
`init` creates the generic project Skill/entry without adding hooks; `--mirror-claude`
also creates the Claude entry and Skill. Later `setup` selects additional hosts
and preserves existing hook choices.

#### Select project hook purposes

Repeat `setup --hook-purpose guard|context|observe|none` with selected `--agent`
hosts. Guard means native pre-commit/pre-push checkpoint checks. Context means
SessionStart and PreToolUse advisory context on a supported host. Observe is
recognized but declined because automatic callbacks are retired; use bounded
watch/inbox. Per-host `hook_purposes` reports requested, installed and declined
purposes with their reason. Never infer support from the selected host name.

Naming a new host with `--agent` installs project guidance and the Skill only.
Pass `--hook-purpose guard` and/or `--hook-purpose context` to opt into hooks.
Omitting purposes preserves recorded choices. To remove a single purpose, repeat
`setup --remove-hook-purpose guard|context`; it affects only hosts named with
`--agent`, or all recorded hosts when `--agent` is omitted. Removal cannot target
a host without an existing receipt. The same purpose cannot be added and removed
in one command; distinct purposes can be changed together. Repeating the same
removal value is invalid. `--hook-purpose none` adds nothing and removes nothing;
it can accompany a removal selector. Use `setup --uninstall` to remove all
recorded project integration assets for this worktree.
If a sibling worktree still consumes shared Git hooks, setup retains the guard
blocks and reports them under `retained`; the last consumer can remove them.
Repeating an already completed purpose removal is an unchanged successful plan.

Preview with `--dry-run` and apply within the existing task delegation. Init adds
no new hooks. `none` cannot combine with other purposes and requests no new hooks;
it does not uninstall recorded choices. Explicit purposes add to existing choices;
omission preserves them. Refresh migrates old event registrations to the current
purpose mapping without enabling an observer. Claude/Codex support context;
custom OpenCode requires `--opencode-claude-hooks`. Official OpenCode/generic
have no host callback registration, but Guard can still install native Git hooks.

Setup plans its guard changes in the same asset transaction as host integration.
It verifies and reuses an independently installed guard without taking ownership.
Setup-owned guard blocks use `setup-guard-hooks.json`; independent guards use
`guard-hooks.json`. Explicit `guard --install`
can transfer them to independent ownership while preserving their original
preimages. Uninstall retains shared blocks while an active setup or sibling
worktree needs them. A retiring setup owner moves retained ownership to the fixed
shared Git namespace in the same transaction as its host-asset removal. The last
setup consumer removes these retained blocks and their receipt; pruning earlier
consumers does not discard the remaining ownership proof. Independent guards keep
their separate ownership. After those consumers release them, independent uninstall
can remove its recorded blocks. Content or permission ambiguity remains a conflict.
The synchronous library setup API cannot discover Git guard paths; callers that
request Guard use `setup::project::install_with_context` with a typed `Process`,
or `install_with_guard_plan` with a prepared plan. This includes previews;
unsupported synchronous calls fail before writes rather than reporting a partial
plan. Existing no-guard callers keep the synchronous entry point. The typed
`install_with_context` and `install_with_guard_plan` entry points reject rollback
before writes; use either CLI rollback entry point for Git-aware recovery. The
legacy synchronous API also rejects transactions that affect native guard assets.
Library recovery first awaits `config::worktree::lock_native_guard`, then acquires
the asset store and calls `rollback_with_lock` with that `NativeGuardLock` token.
All CLI rollback paths follow this order. The previous `config::worktree::rollback`
signature remains available but returns an actionable diagnostic before writes:
an already locked asset store cannot safely establish the required lock order.

Project receipts use version 4, explicit per-host purposes and a unique install
generation. Refresh retains that generation; a later install gets a new one. Valid v1-v3
ownership evidence can migrate. Permission or history ambiguity is an ownership
conflict: older matching records cannot cancel newer evidence. Older published
CLIs cannot verify the shared project transaction history introduced in 2.12.
Use a 2.13-or-newer shared CLI after migration to v4 receipts; preserve the
receipt and assets during any downgrade. Never force-overwrite ownership or delete the
receipt to bypass it. These proof rules also apply to whole-project `remove`;
its apply requires the reviewed preview digest.

Project scope never installs a runtime binary inside the checkout and never
edits global agent settings. Project hooks invoke the currently installed
shared user executable directly — there is no global setup prerequisite — and
refresh after CLI upgrades re-records the selected executable. The 2.4 receipt
format omits `shared_root`. A 2.3-era project receipt is refreshed, removed or
recovered locally with foreign content and manual edits preserved; setup never
reads or writes the retired 2.3 global root. That global 2.3 data stays
preserved and untouched: 2.4 ships no global cleanup command. Operators who
want it gone must back up first and use the 2.3 CLI's exact owned cleanup
before upgrading; never blind-delete. Refresh is additive and keeps previously
recorded agents and explicit choices. Project `--uninstall` requires no
`--agent` and removes exactly that worktree's recorded project assets;
`--rollback` uses the project journal. Whole-project removal is a
separate `remove` command, not part of `setup`; see
[whole-project removal](#whole-project-removal).

Registration is reported as `written_not_verified`, with
`host_delivery.imported_event`, `context_injection`, `visible_message` and
`next_turn` as `not_checked`. `idle_wake: not_supported` makes the retired wake
path explicit. Actual isolated host context delivery needs separate evidence. Project Codex
selection reports `codex_trust: review_in_host_required`: Codex loads
`<repo>/.codex/hooks.json` only after the user reviews and trusts the project
`.codex/` layer in the host's `/hooks` menu, and SpecGit never performs,
assumes or automates that trust.

### Whole-project removal

`remove` retires one project's owned local SpecGit integration. It is introduced
in the 2.3 runtime contract; confirm `specgit remove --help` on the
installed executable before using it. Without `--apply`, or with `--dry-run`, it
prepares a read-only preview whose evidence carries a `preview_sha256`.
`--apply --expect <digest>` applies exactly that inspected preview as one
recoverable transaction, and `--rollback <transaction>` restores the transaction
offline without configuration or forge access.

Removal covers the untracked local declaration and `local-routing.json` only
when a committed init or migration journal proves their exact bytes and
permissions; a tracked `.specgit.yaml` blocks removal because removal never
changes the Git index. Init guidance blocks and recorded project agent skills,
guidance, settings (#652) and receipt-owned guard hooks join the same transaction.
An existing delivery checkpoint permits removal only after the native request is verified merged into
the recorded target with every selected Issue closed. The shared
`info/exclude` block is removed only when no sibling initialized worktree
still consumes it. A sibling with a declaration, or with SpecGit private state
whose declaration is missing, counts as a consumer.

An edited or damaged owned asset, a pending transaction, and an undelivered or
foreign checkpoint block the preview: its evidence lists the conflicts and
applies nothing. Unknown private evidence, journals, locks and backups are
retained rather than recursively deleted; global agent assets, the shared
executable and remote data are untouched. Rollback restores the exact recorded
bytes and permissions and refuses to overwrite later user edits.

Migration defaults to a preview. Supply the complete new declaration explicitly;
no old automation or orchestration policy is silently reinterpreted. Exact owned
local assets and native retirement evidence bound activation. Unknown writers,
dynamic includes, shared hooks or unfinished native runs can prevent activation.
Native workflow retirement is a separately authorized repository operation.
Private backups, foreign content and old drafts remain recoverable.

GitHub Releases are the only public distribution channel. Download a native ZIP:

| Platform | Binary |
|---|---|
| Linux glibc x64 | `specgit-<version>-linux-x64-gnu.zip` |
| macOS arm64 | `specgit-<version>-darwin-arm64.zip` |
| Windows x64 MSVC | `specgit-<version>-win32-x64.zip` |

Verify the same Release's `SHA256SUMS.sigstore.json` signature, then compare the
ZIP hash against `SHA256SUMS` before extraction. Follow the exact signer identity
and commands in the [installation guide](../docs/installation.md). Extract `specgit`
(`specgit.exe` on Windows) and put it on PATH. Unix requires `chmod +x specgit`.
Installation needs no Node.js, npm or Rust compiler. Each target receives native
smoke checks during release and the complete installed CLI regression suite in CI.
See [distribution](distribution/README.md) for publication and recovery.
Installation does not authorize publication or native administration.

### Local generated files

`init` and project `setup` maintain one owned block in Git's local `info/exclude`,
resolved by Git and shared by linked worktrees. The block excludes `.specgit.yaml`
and the generated `.agents/skills/specgit-native/SKILL.md`; selected Claude
integration also excludes `.claude/skills/specgit-native/SKILL.md`. These are exact
repository-root paths. Other Skills, notes and `AGENTS.md` / `CLAUDE.md` remain
visible. Existing generated-Skill exclusions are retained for sibling consumers.
Refresh removes legacy whole-guidance-file exclusions while preserving user rules
outside the block. Damaged or unknown rules require reconciliation.

Each clone/worktree initializes its local Skill and private records separately;
Git does not transport ignored assets. Run `specgit init --dry-run` and then
`specgit init`, supplying the original declaration with `--config-file` when
restoring a lost configuration. Existing registered hosts can also refresh through
`specgit setup --dry-run` and `specgit setup`. Read back the Skill and instruction
entry, run `status` and `doctor`, and repeat the previews to check convergence.
Installed records do not prove the host actually loaded the entry or Skill.

Older initialization blocks are recognized through their recorded ownership,
embedded digest or exact released template. Refresh can replace edited body text
only with the required transaction and permission evidence and complete unique
markers. It migrates the old block into the single project entry; it never adopts
foreign Skills or damaged/duplicate markers. Uninstall and rollback preserve later
edits. An empty initialization receipt retains the initialized-worktree marker
without owning another instruction block; the project receipt owns the Skill/entry.

The JSON `local_exclusion` result reports exclusions and already tracked files.
Ignore rules never untrack a file. Keep hand-written instructions tracked. Moving
an already committed generated Skill or local declaration out of Git requires an
explicit reviewed index change, such as `git rm --cached -- <exact-owned-path>`.
The local file remains, but crossing that commit in another clone/worktree deletes
its tracked copy. Preserve declarations and manual edits before crossing it; restore
the declaration and run `specgit init` to regenerate the Skill afterwards.
Repository/user ignore rules still apply; inspect them with `git check-ignore -v`.

`init --check` reports exclusion state (`absent`, `current`, `refresh`, `damaged`)
and tracked paths without writing. Rollback and whole-project removal keep shared
exclusions while another worktree still has a declaration or initialized private
state. A missing declaration with surviving initialized state is not a fresh clone:
guards fail closed, `init --check` reports `private_state`, and recovery requires
the original declaration. Setup-only registration does not fabricate initialization.

### 2.2 consistency boundaries

Adopted specifications are saved independently of native creation intents. Native
Git guards accept both validated adoption and resolved creation records.
Older adoption-only checkpoints must be selected once again to obtain the native
snapshot. Deletion and type-change commits also require a checkpoint.

Issue creation is serialized for a native project across linked worktrees
sharing the same common Git directory. The lock lives under
`<common_git_dir>/specgit-v2/issue-creation/` and covers candidate reads through
creation/readback. Independent clones and other hosts do not share this lock;
there is no user-global coordination directory. Use linked worktrees of one
checkout for concurrent work on the same WHY. Native search can also lag server
writes. If duplicate specs appear,
inspect their WHYs and select one exact native ID; reconcile duplicate Issues on
the platform within existing authorization. There is no distributed uniqueness
claim. Worktree, declaration and project identity are rechecked before writes.

Existing PR/MR bodies are never automatically overwritten by 2.2 adapters.
`pr --update-body --body-file <file> --dry-run` and
`pr --update-references --dry-run` retain previews with all parsed closing references.
A differing body without dry-run returns `unsupported_operation` before mutations.
Review and edit the current body on the native platform, then refresh `pr --status`.
Creation and draft-to-ready operations remain available.

Current-head checks are reread at the observation boundary; changed execution
identities or results invalidate the observation. Every result remains a dated
snapshot, not a promise about future reruns. GitHub observations also read the
bounded native workflow-run list for this head (Actions read access is required).
Only suites superseded within the same workflow, event, branch and associated PR
set are discarded. Independent check suites remain distinct. When a replacement
workflow has no visible check runs, use its own status and conclusion: queued or
running is pending, and completed with native `conclusion: "success"` can establish
passing evidence. Other completed conclusions do not establish passing checks.
Missing or incomplete run identities remain unavailable and never fall back to old
green checks. A running workflow cannot inherit old success.
This reads execution identities, not workflow jobs or dependency graphs.
Explicit watch/inbox delivers actionable check results before lifecycle completion
and preserves the subscription for resumption. Host hooks do not launch observation.

GitLab merged-results pipelines retain both `head` (source) and `tested_head`.
A differing tested SHA must be the MR's head pipeline on its merge ref, and the
native commit must have exactly the current source and target commits as parents.
Unknown ancestry, stale source/target results and merge-train ancestry that cannot
meet this proof are rejected; no SHA comparison is simply disabled.

### Git guard executable binding

New guard blocks in Git metadata pin the absolute shared CLI path and quote it for
POSIX/Git Bash. `guard --install` (or the recorded setup refresh) migrates owned
bare-command blocks after ownership checks. Pre-push temporary files use `TMPDIR`
when set. A `core.hooksPath` inside the worktree keeps a portable `specgit` PATH
lookup, reported as `executable_binding: path_lookup`; it never embeds a local
absolute executable path in that potentially committed hook. Host context settings
remain machine-local integrations and contain absolute executable paths; regenerate
them for each machine rather than treating them as portable configuration.

Unix process cleanup signals the owned process group while its exited leader is
still unreaped, then reaps the leader. A descendant that deliberately calls `setsid`
is outside that boundary. Windows uses an owned Job Object.

Rust embedding callers that create Git metadata hooks should use
`guard::preview_with_executable` / `guard::install_with_executable`, or pass an
explicit CLI path to `guard::setup_plan_with_executable`. The path must be
absolute, UTF-8 and free of CR, LF and NUL; the caller must keep that shared CLI
available. The existing `guard::preview`, `guard::install` and `guard::setup_plan`
signatures remain; new Git-metadata hooks outside the worktree resolve `specgit`
from PATH when no explicit path is supplied, and return a diagnostic if it cannot
be resolved. They do not create an unbound metadata hook. Maintenance retains a
proven absolute pin without requiring the old executable to remain installed. CLI guard commands
pass their current executable, and project setup passes its shared executable
after checking it is readable, executable on Unix, and outside the repository's
checkouts. A `core.hooksPath` inside the worktree remains portable and uses PATH,
as described above.
