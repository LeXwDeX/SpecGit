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
`tags` catalog of name, six-digit color and optional description. The `templates`
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
conflicts and side-effect classification. Engineering qualification generates
`schemas/` from this contract and compares them with the installed executable.
Public ZIPs contain only the executable; use its embedded offline `--schema`.

Global options are `--cwd <path>`, `--json`, `--human`, `--schema` and
`--input-file <path>`. Ordinary non-TTY stdout defaults to a single JSON report;
`--human` forces text. `--json` and `--human` conflict. `hook` uses host-specific
framing and `guard` uses Git-hook exit semantics regardless of ordinary output selection.

Explicit JSON input is one object with `command`, `options` and optional `args`:

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
| `setup` | Install/update versioned global assets; select `--root`, `--provider`, `--api-host`. `--register-claude` and optional `--claude-settings` register Claude hooks. `--register-codex` registers Codex hooks and installs its native skill and managed global instructions. `--register-opencode` installs OpenCode guidance and skill until that host exposes the same blocking protocol. `--codex-root` / `--opencode-root` select explicit host configuration directories. Existing registered roots persist during refresh. `--dry-run` previews install/update or `--uninstall` without writes or a lock. Uninstall removes only registrations owned by the selected setup root. `--rollback <transaction>` restores owned local assets and conflicts with dry-run/uninstall. Written registration is not verified host import or event delivery. |
| `init` | Inspect native capabilities and write the local declaration/guidance. Select `--remote`, `--provider`, `--api-host`, `--target`, `--language`, `--config-file`, `--mirror-claude`. `--check` (alias of `--inspect`) is read-only; `--dry-run` also previews asset paths. `--native-auto-merge true\|false` records an explicit preference; `--manual-observe` selects the manual fallback. `--rollback <transaction>` restores a local transaction. |
| `issue` | Adopt positive Issue IDs or create complete specification titles. Repeat `--body-file` in new-title order; optional `--tags` and `--branch`. `--inspect` or `--dry-run` reports preparation and duplicate candidates without local/native writes. After comparing different WHYs, repeat `--reviewed-candidates <review_digest>` for the exact reviewed candidate sets. `--create-labels` explicitly permits missing selected catalog labels to be created. |
| `pr` | Create/resume/discover a PR/MR or adopt `--request <id>` after real pushed changes. Optional `--title`, `--body-file`, `--tags`; explicit `--ready` preserves deliberate associations. `--update-body` and `--update-references` support read-only previews; differing native bodies require platform editing because atomic conditional updates are unavailable. `--inspect` reads preparation; `--dry-run` previews a mutation. `--create-labels` permits missing catalog labels. `--status` reads native lifecycle facts and conflicts with mutation options; `--status --request <id>` permits an exact same-repository read from another checkout. |
| `watch` | Bounded native observation. Requires `--request`, `--session`, `--goal checks\|lifecycle`; optional `--state-root`, `--once`, `--timeout-seconds` (1–86,400; default from project configuration), `--poll-seconds` (1–3,600; default from project configuration). CLI values override configuration. |
| `hook` | Codex/Claude event adapter with `--event`; optional `--state-root` and asynchronous PostToolUse `--observe`. PreToolUse denies tracked edits unless the actual target repository and branch have a complete selected-Issue checkpoint. Stop may request one recovery turn; `stop_hook_active` prevents repetition. |
| `guard` | Local Git-hook entrypoint. `--install` merges owned blocks into the effective native/custom hook path and uses Husky's user scripts when `core.hooksPath=.husky/_`; `--uninstall` removes only recorded blocks. Existing non-shell hooks are preserved with a diagnostic. `--stage pre-commit` rejects staged changes without a current checkpoint. `--stage pre-push` reads and replays Git's ref-update stdin, validating every branch ref; deletions and tag-only updates are outside this checkpoint rule. |
| `inbox` | Read/refresh pending events with `--request`, `--session`, `--goal`, optional `--state-root`. `--no-refresh` lists unverified IDs only. `--ack <event-id>` records explicit transport receipt and conflicts with no-refresh. |
| `status` | Offline Git identity and local selection. Optional `--remote`, `--provider`; no forge child is invoked. |
| `doctor` | Read tool/account/project capability. Select `--provider`; optional `--remote`, `--api-host`, `--account-only`. Help success does not prove API access or mutation permission. |
| `migrate` | Preview owned v1 retirement using `--config-file <v2.yaml>` and optional `--api-host`. `--apply --expect <digest>` applies the exact reviewed preview. `--retire-only` retains the old declaration for staged cutover. `--rollback <transaction>` restores proven local assets. |

`inbox`, `status`, `doctor` and `migrate` remain auxiliary entrypoints in this
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
This first-stage list maps facts already collected by init; it does not perform
Issue duplicate searches or permission writes. `issue.duplicate_read`, `issue.write_permission` and
`request.write_permission` therefore remain `not_checked` until the relevant
Issue or request operation. A readable account endpoint proves neither Issue
nor request write access or merge eligibility. Unknown facts only affect the
operation that depends on them; target-protection uncertainty is a warning
because init has no declared
policy making that check mandatory.
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
not probe CI. Delivery completion remains unverified because init does not read
back a merged native request, every associated Issue's closure, or installed
acceptance on the exact main merge. An observed open request is listed as a
fact but does not establish completion. The three layers are never collapsed
into one overall-green conclusion.

`evidence.operation_assessments` summarizes those checks per operation. Each
entry lists relevant checks, required blockers, required facts still
unverified, and nonblocking recommended warnings. `blocked`, `unverified` and
`no_reported_blocker` apply only to the
listed init checks; a clear entry is not a claim of write permission, complete
CI readiness, or completed delivery. A recommended or optional warning cannot
block unrelated local diagnosis. `issue.write_permission` remains unverified
until the authorized write and native readback, rather than becoming a guessed
permission failure.

Capability records use `supported`, `unsupported` or `unknown` with source and
reason. Unsupported/unknown native flow returns `confirmation_required` before
project writes unless an explicit manual fallback was selected. The report remains
available with `--check` or dry-run. Configure the platform using an authorized
native administrator action, recheck, or choose `--manual-observe`. That manual
choice persists for subsequent refreshes. No default branch is guessed, and init
never changes native settings, protection or CI.

GitHub `allow_auto_merge` reports a repository setting, not a request guarantee.
Readable branch protection is not an exhaustive ruleset/queue/approval assessment.
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
Each watch event includes the legacy `next_action` text and a typed `next_step`;
the report-level `next_actions` repeats those same typed steps for direct
consumers. The action records the goal, check outcome, draft state, auto-merge
registration, open Issue IDs and diagnostic codes used to form its message.
Drafts with passing checks suggest the explicitly authorized ready-for-review
operation; they do not approve or merge. Ready requests distinguish registered,
unregistered and unknown auto-merge state, and never infer review, merge or
delivery completion from passing checks. Merged requests with open Issues name
those IDs; a merged request without verified closing facts remains unknown.
Watch, inbox and Hook actions are advisory and never ready, merge or close
anything automatically.

Codex and Claude registration include SessionStart, PreToolUse, PostToolUse and Stop.
Relevant PostToolUse may launch a bounded asynchronous observer. Registration is
`written_not_verified`; import, context injection, visible messages and later-turn
delivery require separate host evidence. Immediate idle wake is not supported.
Stop requests at most one recovery turn when a dirty initialized project lacks a
valid checkpoint; the host's repeated-event flag makes the next Stop silent.
Hooks never acknowledge themselves.
Use explicit watch/inbox when automatic delivery is unavailable.

## Assets, migration and installation

Setup uses exact asset hashes and recorded host groups. Foreign content, hook
ordering and file permissions survive refresh/uninstall. Dry-run performs no
mkdir, asset lock or write. Real apply rechecks content/permissions after locking,
uses atomic replacement and saves restorable private preimages. Edited ownership
or interrupted transactions require explicit recovery. Rollback refuses later
conflicting edits; uninstall retains backups and unrelated directories.
Installation can succeed while account readiness is unknown: inspect `readiness`
and exit 3 separately from written assets and unverified host registration.

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

`init` and v2 migration maintain one owned block in Git's local `info/exclude`,
resolved by Git and shared by linked worktrees. Since 2.2 it excludes only
`.specgit.yaml`. SpecGit does not add exclusions for project `AGENTS.md` /
`CLAUDE.md`: one worktree cannot establish ownership of another worktree's guidance.
Repository or user ignore rules still apply; use `git check-ignore -v <path>` to
identify them and review their purpose before changing them. Repeated initialization
refreshes the block without duplicating it and preserves surrounding user rules.
Preview and rollback include this file; damaged markers require reconciliation.

The JSON `local_exclusion` result reports exclusions and already tracked files.
Ignore rules never untrack a file. Review project guidance changes under the
repository's normal documentation policy; preserve manual content and owned
markers. Do not hide or untrack guidance merely because SpecGit generated part
of it. Untracking an already committed local declaration requires an explicit,
reviewed repository change. Global `setup` assets belong under the selected
user/host roots, outside the project by default.

### 2.2 consistency boundaries

Adopted specifications are saved independently of native creation intents. Guard
and Agent edit hooks accept both validated adoption and resolved creation records.
Older adoption-only checkpoints must be selected once again to obtain the native
snapshot. Deletion and type-change commits also require a checkpoint.

Issue creation is serialized per native project for the same OS user and host,
using the shared SpecGit data root. The lock covers candidate reads through
creation/readback; independent configured data roots and other hosts are outside
this guarantee. Native search can also lag server writes. If duplicate specs appear,
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
set are discarded. Independent check suites remain distinct. A replacement with
no visible checks is unknown, and a running workflow cannot inherit old success.
Unavailable or incomplete run identities never fall back to old green checks.
This reads execution identities, not workflow jobs or dependency graphs.
Async hooks deliver actionable check
results before lifecycle completion and preserve the subscription for resumption.

GitLab merged-results pipelines retain both `head` (source) and `tested_head`.
A differing tested SHA must be the MR's head pipeline on its merge ref, and the
native commit must have exactly the current source and target commits as parents.
Unknown ancestry, stale source/target results and merge-train ancestry that cannot
meet this proof are rejected; no SHA comparison is simply disabled.
