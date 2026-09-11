# SpecGit 2.0: Rust rewrite, native delivery and asynchronous hooks

> Historical baseline, superseded on 2026-09-10. The operative Rust target is now
> [the lightweight Agent-native CLI design](specgit-2-rust-design.md), with
> [explicit history/feature dispositions](specgit-2-rust-history.md) and
> [implementation handoff](specgit-2-rust-handoff.md). The text below preserves
> the earlier proposal. Its local acceptance/merge/promotion engines and absolute
> ban on optional Agent issue closure no longer define the new implementation.
> This supersession does not change the currently shipped 1.x runtime.

Status: design proposal under issue #507 and PR #508. This document defines the
2.0 target; it does not describe the currently shipped 1.x implementation.
The user approved native-only issue closure and source-branch deletion. Details
below are the proposed defaults for implementation and acceptance.

The detailed [harness contract](specgit-2-contract.md) specifies configuration,
language/templates, native command effects, binding and acceptance. The
[history ledger](specgit-2-history.md) records all reviewed issue dispositions.

## Product purpose

SpecGit connects issue-based specifications to an agent's delivery work. It
observes Git and forge facts, explains missing evidence, and returns actionable
updates through hooks. GitHub/GitLab own CI execution, merge protection, native
merge operations, issue closure and source-branch deletion. The agent owns
reasoning about repairs and acting within the user's authorization.

An issue is the spec unit. A delivery binds one or more issues to one PR/MR.
A successful CI run, a merged request, closed issues and a deleted source branch
are distinct facts. Notifications preserve these distinctions.

The repository may remain private while the npm distribution is public. This
release architecture does not require changing either visibility.

## User journey

1. Install the CLI, then run `specgit setup` once for the user account. Setup
   installs versioned, global agent integration assets and a Claude-shaped hook
   manifest. It works outside a Git repository.
2. The host imports that manifest. A native Claude registration option can merge
   the owned entries into Claude user settings. Codex and other hosts own their
   import/translation; a compatible JSON shape alone does not prove host support.
3. Run `specgit init` in a project. It discovers the selected Git remote, confirms
   the forge, reads native defaults and the intended PR/MR target, and writes only
   the project declaration and necessary ignored local state references.
4. Start or adopt spec issues through `specgit issue`; group related independent
   specs in one delivery when they can be reviewed together. Bootstrap is
   resumable and must not duplicate issues or requests after an interruption.
5. Work normally. Session hooks supply compact local context. Relevant tool
   events discover changed delivery identity and start or resume observation.
6. A background observer follows the selected request and current-head checks.
   Significant changes and terminal outcomes are returned to the host. The agent
   decides what to do with a failure; observing does not grant write authority.
7. Use native merge/auto-merge under existing permissions. After merge, report
   actual issue closure and source-branch cleanup. Where native closure cannot
   occur, report `merged_issues_open` with an explanation; never compensate by
   calling the issue-close API.

A global integration must be silent outside initialized projects. `setup` does
not silently initialize all repositories on the machine.

## Responsibilities

| Owner | Responsibility |
| --- | --- |
| Issues | Spec intent and independently verifiable acceptance criteria |
| PR/MR | Group of bound issues, reviewable change, actual source/target and merge state |
| Project declaration | Selected remote/provider, intended flow and verification/notification choices |
| GitHub/GitLab | Native CI, branch protection, merge, issue closure, source-branch deletion |
| SpecGit | Binding, observation, current evidence assessment, diagnostics and hook output |
| Agent | Implementation, investigation, repair and authorized native operations |
| Host | Running hooks and delivering their outputs into the correct conversation |

SpecGit must not become a second issue tracker, CI runner, merge controller,
notification server or general task scheduler.

## Modules and interfaces

The implementation target is one Rust Cargo package with a library and binary.
The runtime is organized around six modules, with CLI commands as composition
roots rather than owners of domain behavior.

| Module | Small interface | Hidden implementation |
| --- | --- | --- |
| Project | `resolve(cwd)`, `inspect(project)`, `initialize(options)` | Git/worktree identity, schema/migration, native flow capability diagnostics |
| Spec | `prepare(input, rules)`, `validate(content, rules)` | Selected templates, one-pass rendering, language/title/body/label conventions and reference completeness |
| Delivery | `bind(specs, options)`, `observe(identity)` | Resumable bootstrap, many-issue binding, request identity and live facts |
| Assessment | `assess(declaration, observation)` | Pure decisions separating checks, merge, issue closure and cleanup |
| Watch | `follow(identity, options)`, `resume(context)` | Bounded polling, request deduplication, retry/backoff, durable pending events |
| Integration | `install(options)`, `handle(event)` | Global assets, host protocol, ownership-safe reconciliation, output rendering |

Git, filesystem, process/time and forge adapters sit at the interfaces actually
needed by these modules. GitHub and GitLab are the two concrete forge adapters.
Native administration is a separate capability from read-only observation.
Do not pass the full 1.x provider port to a watcher or hook.

Illustrative Rust contracts (design sketches, not compilable or released APIs):

```rust
struct DeliveryId { repository: RepositoryId, request: NonZeroU64 }
struct Snapshot {
    identity: DeliveryId,
    head: ObjectId,
    target: BranchName,
    checks: Evidence<CheckSummary>,
    request: RequestState,
    issues: Vec<(IssueRef, Evidence<IssueState>)>,
    source_branch: Evidence<BranchState>,
    observed_at: Timestamp,
}
enum Evidence<T> { Known(T), Unknown(Diagnostic) }
trait ForgeRead {
    async fn inspect_project(&self, repo: &RepositoryId) -> Result<ProjectFacts>;
    async fn observe(&self, delivery: &DeliveryId) -> Result<Snapshot>;
}
trait ForgeBootstrap {
    async fn reconcile(&self, intent: BootstrapIntent) -> Result<Binding>;
}
fn assess(rules: &ProjectRules, snapshot: &Snapshot) -> Assessment;
// CLI roots compose Project, Delivery and Watch; hooks receive read capability.
```

Keep `runtime/Cargo.toml`, `runtime/Cargo.lock`, `runtime/src/{lib,main}.rs`,
`runtime/src/{project,spec,delivery,assessment,watch,integration,forge,process}` and
`runtime/tests` in one package initially. `npm/` contains only launch/distribution
assets. This is a proposed layout; no Rust implementation is included here.
Use clap for argument parsing, serde/serde_json for versioned JSON, and Tokio for
bounded asynchronous process/observer work. Select a maintained YAML parser by
schema, duplicate-key, unknown-field and migration tests; do not mechanically
port the existing JavaScript dependency. Pin the Rust toolchain/MSRV and lockfile
when #509 establishes builds. Add dependencies only for demonstrated needs.

The process module owns argument arrays, explicit cwd, bounded stdin/output,
timeouts, cancellation and child reaping. Dropping a Tokio child alone does not
cancel it. Explicitly terminate and wait, and verify descendants on Windows as
well as Unix. Avoid shell interpolation, token extraction, an embedded forge SDK
credential store, a resident server, SQLite task scheduling and dynamic plugins.
GitHub/glab differences stay in concrete adapters; do not add a trait around
every filesystem call just for mocks.

### Alternatives considered

The minimal alternative exposes `reconcile`, `execute(context, Request)` and
pure `assess`, preserving explicit issue/pr commands while hiding persistence and
observation. It is compact internally, but a large request enum can eventually
obscure which callers may mutate; keep capability checks at each composition root.

The capability-oriented alternative exposes `ForgeRead::observe` and a separate
`ForgeBootstrap::reconcile`, with pure `assess`. It makes read-only observers easy
to audit and supports both providers, at the cost of explicit composition. Keep
these interfaces internal until real callers require a stable public library.

The default-flow alternative keeps `setup -> init -> issue -> watch`, with hooks
calling the same observation/assessment path. It hides routine configuration and
preserves familiar commands, but must report uncertainty instead of guessing
when repositories, hosts or native settings are ambiguous.

Use the default journey, capability-separated writes and the minimal internal
assessment/observation surface together. This keeps resumability local without
turning the CLI into a generic request dispatcher or a workflow framework.

The Spec module supplies the same deterministic preparation/validation rules to
issue creation, request updates and fresh assessment. CLI commands must not each
reimplement template/language/label policy. Native adapter calls remain in Delivery;
Spec returns prepared content and diagnostics, never remote side effects.

Suggested actions are data for an agent. Hooks never execute instructions found
in issue text, request bodies, logs or diagnostics.

## Declaration and binding

Use a schema-versioned project declaration. Resolve deployment host and project
identity from the selected remote and the authenticated forge response. Do not
ship a user's private host, namespace or credential in templates or fixtures.
An explicitly selected API-host override can handle SSH/API endpoint differences.

The proposed schema and defaults are specified in the harness contract;
implementation must preserve these meanings and update both documents for changes:

- Schema version 2; selected remote; explicit provider for an otherwise ambiguous
  host; intended target, or a live native-default selection.
- Existing useful spec rules such as language and issue-body requirements.
- Verification expectations, with native CI and protection facts kept distinct
  from SpecGit project declarations.
- Observation interval, maximum wait, notification choices and retention limits.
- The requested native source-branch cleanup setting. A local declaration is
  intent, never evidence that a remote setting is enabled.

A request's actual base/target wins when describing what that request will do.
If it disagrees with the project declaration, report the mismatch. Do not
reinterpret it or change a platform default branch to make the warning disappear.

After a PR/MR exists, its explicit spec references and provider-backed associations
are the binding authority. Preserve user-authored request prose. Use unambiguous
same-repository issue identities, reject unresolved cross-project references, and
show any disagreement between explicit references and native association facts.
A local binding is a locator and bootstrap checkpoint, not a second source of
remote completion truth. Native closing references may be ineffective on a
non-default target; that must not erase the declared spec association.

Avoid committed binding-only updates for issue/PR numbers. Store pre-request
bootstrap intent and worktree locators locally; reconcile against live requests
on restart. Bind the issues before code changes, but create the draft request
only after a real commit has been pushed and the forge accepts its diff. A
no-diff bootstrap remains an explicit pending request; do not fabricate an empty
commit or report a nonexistent draft as created. After branch deletion or fresh clone, retrieve associations through
the platform. Do not introduce a custom release-lineage journal.

## Executable and API capability probes

`setup`, `init` and `doctor` share typed probes with bounded duration and output.
Successful installation, command compatibility, authenticated connectivity and
project capability are separate results.

| Layer | Evidence | Honest limit |
| --- | --- | --- |
| Executable | Resolved executable identity and `--version` | Presence is not command compatibility |
| Command | `--help` and required subcommand/flag probes for git and selected gh/glab | Help is not API reachability; localized prose is not a parse contract |
| Account/API | Bounded authenticated read-only identity/API request for selected configured host | Authentication alone does not prove project access |
| Project | Exact repository identity, default/intended target, request/check access and readable native settings | Read access does not prove create/merge/configure rights |
| Integration | Real bounded hook stdin/stdout round-trip and selected host delivery | Manifest creation does not prove host import or wake-up |

Outside a repository, setup can probe selected configured accounts but reports
project checks `not_checked`. Init must perform the project requests. An absent
optional glab does not block GitHub-only setup, and vice versa. Refresh cached
command evidence when executable identity changes; refresh remote facts before
relying on them. Record operation, version, host/project, observation time,
status and remedy without storing credentials.

Distinguish missing executable, unsupported operation, authentication failure,
permission denial, ambiguous not-found, rate limiting, network/TLS failure and
malformed/truncated output. Unknown or untested is not unavailable, and neither
is success. A failed probe must not leave partial configuration. Probes never
create issues, branches or tokens, merge, or change settings. Isolated live
acceptance separately verifies the write interfaces actually shipped.

## Native flow inspection

Inspect the intended request target, not merely whether the checked-out feature
branch equals the default branch. A feature branch targeting the native default
is the ordinary valid path.

Required diagnostics include:

- A non-default target: explain that native closing keywords do not provide the
  requested closure at this stage. Include actual and native-default targets.
- Automatic issue closing disabled by project settings.
- Custom self-managed closing patterns or permissions that cannot be proved:
  report uncertainty, never an unconditional promise of closure.
- Source-branch cleanup disabled, unavailable or prevented by native branch
  rules. Cleanup is a separate observation, not proof of failed code delivery.
- Missing authentication, wrong project identity, missing request, ambiguous
  branch-to-request mapping and declaration drift.

Warnings offer concrete native options, such as choosing the intended target,
using valid closing references, enabling the relevant native setting with
permission, or accepting that this stage leaves issues open. SpecGit does not
silently pick an option for the user.

Configuration may use native settings APIs when explicitly requested. Read back
settings after writes. Insufficient permission produces an actionable diagnostic
and preserves unrelated settings. Never install a replacement closure workflow,
change the default branch, loosen required checks or override protected branches.

## Hooks and global setup

The default distributable manifest follows Claude's event/matcher/command-hook
shape. A single installed `specgit hook` entry point accepts bounded JSON on
stdin and produces the event-appropriate response. Package the executable
adapter; avoid on-demand package downloads or repository-supplied shell snippets.

| Event | Work | Output |
| --- | --- | --- |
| SessionStart / resume | Resolve initialized project, refresh local context, deliver pending events | Current delivery and outstanding work |
| PreToolUse | Cheap local checks for relevant mutating tools | Binding/flow diagnostic; no remote polling |
| PostToolUse | Detect relevant delivery changes and start/resume background observation | Asynchronous state-change or terminal result |
| Stop | Report relevant pending delivery state, without an unconditional blocking loop | Honest handoff when work remains |

A command-shaped event is only a trigger hint. Re-read actual Git/forge facts;
never infer a successful push or merge solely from a shell command string. Ignore
SpecGit's own observation calls to prevent recursive hook invocation.

Host capability negotiation distinguishes context injection, visible message,
next-turn delivery and idle wake-up. Standard async output may wait until the
next interaction. Use a host's wake-up feature only when supported and tested;
SpecGit exit codes must be translated, not forwarded as hook control codes.
A fallback pending-event inbox must be disclosed and exercised on resume.

Setup installs global hook assets and skills under an OS-appropriate per-user
location, with an override for isolated tests. It reports the installed path,
schema version and import/registration status. Native Claude registration is an
explicit host choice. Existing user hooks/settings remain intact; updates and
uninstall touch only provably owned entries. Preserve unknown JSON and hook
stdin, reject unsafe symlink/path traversal, detect concurrent user edits and
use atomic writes with rollback. Never overwrite a foreign entry based on name. Project init never writes global
settings, and setup never writes project policy or remote settings.

## Asynchronous observation and notification

The default task is a bounded background observer, not a resident server. The
CLI exposes the same behavior for hosts without automatic hook import. Define
watch goals such as current checks or request lifecycle explicitly; a completed
check watch does not imply a merged request.

- Scope task identity to canonical repository, request, worktree/session
  subscription, head revision and relevant declaration version.
- Share observation for duplicate subscriptions where appropriate; keep event
  delivery scoped to the correct subscribed conversation. Two worktrees must not
  steal one another's results.
- Re-read head/target/binding before terminal delivery. A new push invalidates
  the old assessment and produces a new revision of the observed task.
- Emit only material transitions. A failed required check, a cancelled request,
  missing evidence, timeout and a native closure limitation are different events.
- Include stable event ID, request identity, head, observed time, reason and
  suggested action. Keep routine messages short; retain bounded local details
  without copying tokens or raw private logs into shared files.
- Persist only resumable observation intent and pending notification receipts.
  The forge remains authoritative. Locks need stale-owner recovery, bounded
  retries, interruption handling and atomic file replacement.
- Delivery is at least once with stable IDs and deduplication. Hook output alone
  is not proof the agent or user read the message; do not promise exactly once.
- On agent/session exit, persist enough to resume. No promise of immediate
  out-of-session delivery without an explicitly supported host/background
  execution capability. Resume re-reads live facts before presenting success.
- Timeouts remain pending/unknown with a next action. They never become success.
  Network/auth errors use bounded backoff and do not start new repair issues.

## Assessment and CI

`finish` remains a read-only explicit assessment; hooks invoke the same rules.
Preserve structured output and distinguish failure with evidence from missing
evidence. A notification adapter cannot grant acceptance.

CI scheduling, path filters, dependency caches, matrices and native auto-merge
belong to the adopting project and platform. SpecGit reports applicable current
checks and missing verification; it does not trigger full CI on each edit, copy
old green checks onto a new head, or own a general verification-reuse protocol.
Agents may generate project-specific CI using explicit requirements and native
features. Required checks remain effective; an absent check is not automatically
not-applicable. Changing issue text requires fresh spec assessment, not automatic
re-execution of unchanged product tests.

A lifecycle result distinguishes `checks_passed`, `merged`, `merged_issues_open`,
`completed`, `closed_unmerged`, `failed` and `unknown`. Completion of the selected
delivery goal requires platform-confirmed merge and closure of every bound issue.
Source-branch cleanup is reported separately. Non-default targets may reach a
terminal attention state without reaching completed; observers must not wait
forever for a native action that cannot happen there.

## CLI direction

Retain familiar commands where their meaning survives: `issue`, `pr`, `status`,
`finish` and `doctor`. Change `setup` to global installation and `init` to project
initialization/inspection. Add `hook` as the host protocol adapter and `watch` as
explicit asynchronous observation. Avoid a new command for each notification.

Remove custom `pr --close-issues`, custom completion workers and automatic repair
issue creation from 2.0. Native merge delegation, if exposed, must keep platform
protection and explicit authorization and must never fall back to direct merge
or issue-close loops. Do not infer a request for auto-merge from a request for
automatic source-branch deletion.

Freeze all removed flags, aliases, JSON envelopes and diagnostic codes in the
migration implementation; obsolete flags receive a specific migration error,
not silent reinterpretation under 2.0.

## Migration and existing work

The 1.x runtime and current delivery remain available during this design phase.
Use an isolated branch/worktree. No publication is implied by merging this RFC.

| Existing item | 2.0 disposition |
| --- | --- |
| #493 automation programme | Re-plan as the parent for the approved 2.0 direction; retain historical 1.x evidence |
| #473 / draft PR #496 custom verification reuse | Preserve implemented work and evidence; retire the custom protocol from the 2.0 target; fulfill its efficiency goal through project/native CI ownership |
| #474 Windows verification time | Retain; measure the resulting 2.0 suite without dropping applicable platform cases |
| #477 promotion lineage | Preserve the need to expose original issue associations; replace the custom release-stage ledger proposal with native facts and explicit limitation reporting |
| #492 interrupted completion recovery | Replace custom post-merge mutation recovery with observer/subscription recovery and pending hook delivery |

Do not mark these issues completed by rewriting their descriptions. Record the
user-authorized scope change; explicitly distinguish retained acceptance,
superseded requirements and still-unimplemented work. New independently
verifiable implementation work is tracked as issues and bound before edits.

Migration must inventory and preview removal of SpecGit-owned remote completion
workflows, generated local hooks, project-level entry points and 1.x schemas.
Preserve user content, unrelated CI, branch protections and private local live
fixtures. Snapshot owned files/settings for rollback. Never uninstall generic
user workflows based solely on a familiar filename.

Reject version-1 declarations under 2.0 with an explicit migration plan unless
compatibility is proven for the specific operation. During coexistence, prevent
1.x completion writers and 2.0 observers from appearing to share one authority.
Converge to one active major-version integration per project before general
release.

## Implementation sequence and acceptance

The [feature acceptance matrix](specgit-2-acceptance.md) defines 48 required
feature checks and independent final code/smoke/regression/live acceptance.
Completion requires evidence against the document, not only a task summary.

The [historical ledger](specgit-2-history.md) maps every reviewed issue to retained
requirements, changed ownership, retired mechanisms or historical evidence.
Issue bodies contain independently executable acceptance; changing their scope
does not implement them. All implementation items remain open.

| Order | Tracker | Deliverable and dependencies |
| --- | --- | --- |
| 0 | #507 / PR #508 | This architecture, full history dispositions and issue-backed plan; no runtime edits |
| 1 | #509 | Rust package, process contract, typed facts/diagnostics and layered probes |
| 2 | #510, #511 | Global hooks/install and project/native inspection; both depend on #509 |
| 3 | #512 | Issue bootstrap and many-issue binding; depends on #509 and #511 |
| 3 | #492 | Bounded watcher, subscription/outbox and restart recovery; depends on #509–#512 |
| 4 | #477 | Evidence-based promotion associations; depends on #512 and observer facts |
| 4 | #473 | Native/project CI scheduling and fresh assessment without custom reuse engine; depends on #511–#512 |
| 5 | #513 | Ownership-safe migration and removal of 1.x writers; depends on preceding runtime behavior |
| 5 | #474 | Real Windows profiling and equivalent retained coverage; depends on runnable #492/#512/#513 |
| 6 | #514 | Public npm native artifacts and release recovery; local packing starts after #509, release qualification follows #513/#474 |
| 7 | #493 | Integrated acceptance of all required items; publication remains a separate authorized action |

Preserve applicable outcome regressions, not obsolete implementation helpers.
Map any removed Windows/TypeScript test to a retained outcome, explicit native
ownership or a retired requirement before deleting it. Do not claim speedup
from a smaller unrelated workload or use old 1.x CI to certify Rust.

Integrated acceptance requires:

- Real installed Rust executable and thin launcher on Linux, macOS and Windows;
  command/API probes against both GitHub and GitLab.
- Clean global install, update and uninstall outside Git in an isolated home;
  user-hook preservation, concurrent edits, symlinks and rollback.
- Several issues in one request, native default-target merge/closure/cleanup,
  and honest non-default/disabled/unknown capability behavior. No fallback
  issue-close or branch-delete call may occur.
- Real supported host event/context delivery, separately tested idle wake-up,
  next-turn inbox fallback, interruption, stale head, duplicate sessions,
  subscription isolation, timeout and offline/auth recovery.
- Migration preview/apply/rollback with one active major-version integration,
  preserved unrelated CI/protection and no stale 1.x completion writer.
- Real same-workload Windows timing, current-head verification and merged
  independently accepted deliveries for every required implementation issue.

Mocks establish adapter contracts; they cannot establish native closure or host
notification. Record executable, host, forge and runner versions for live cases.
Keep private addresses in ignored configuration or derive them from remotes.

## Public npm distribution from private Rust source

The source repository stays private and npm stays public. Prefer exact-version
platform npm packages containing precompiled Rust binaries plus a thin launcher;
end users must not need GitHub credentials, a private Release download, a Rust
compiler or source checkout. Support Linux x64/arm64, macOS x64/arm64 and Windows
x64, with explicit libc/unsupported-target diagnostics. Verify fresh installs
with disabled lifecycle scripts where supported by the chosen packaging.

The launcher forwards arguments, stdin/stdout, signals and exit status without
owning product logic. Validate binary/wrapper version and integrity together.
Publish platform artifacts before promoting the complete launcher release;
recover partial publication without pointing `latest` to an incomplete set.
Check packaged files and binary source/debug paths for private material.

npm trusted publishing can publish a public package from private source, but
npm provenance is not generated for a private repository. Verify the actual
OIDC workflow and remove an unconditional provenance requirement in the eventual
release design; do not change source visibility or invent an attestation.
Cargo source publication is unnecessary. Building/packing qualification fixtures
is distinct from authorized public publication; this RFC publishes no package.

## Basis and limits of this design

The bounded 1.x source review inspected the CLI registry, init/setup/issue/pr/
finish entry points, agent-surface and harness generation, the forge port and
completion module. The graph traced `completeDelivery` from remote execution and
CLI merge; `runFinish` dispatches assessment, scope and verification planning.
All relied paths had matching metadata and no recorded coverage gap. This is
migration seam evidence, not an exhaustive audit of the whole source tree.

Official contracts consulted:

- [Claude hooks](https://code.claude.com/docs/en/hooks): event-specific JSON,
  async output timing and host-controlled wake-up.
- [GitHub closing references](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue): native target semantics.
- [Tokio process lifecycle](https://docs.rs/tokio/latest/tokio/process/index.html): cancellation and child ownership.
- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/): private-source publishing and provenance limits.
- [clap](https://docs.rs/clap/latest/clap/) and [serde](https://docs.rs/serde/latest/serde/): proposed Rust CLI/JSON dependencies.
- [GitLab automatic issue closing](https://docs.gitlab.com/user/project/issues/managing_issues/#closing-issues-automatically): default-branch behavior and configuration caveats.

Provider settings and host versions must be verified during implementation.
This document is not a claim that arbitrary hosts already import the manifest,
that GitLab permissions are sufficient for every native setting, or that the
existing 1.x build implements any 2.0 behavior.
