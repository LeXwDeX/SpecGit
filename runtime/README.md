# Native SpecGit 2 runtime

This private development Cargo package builds the SpecGit 2 library and native
executable: `doctor`, offline `status`, `setup`, `hook`, `init`, native `issue`/`pr`,
read-only `finish`, explicit `merge`, bounded `watch`, durable `inbox`, read-only
`promotion` and explicit `migrate`. Native npm staging and installed-entrypoint
checks are documented in [distribution](distribution/README.md). The TypeScript
publication entrypoint remains authoritative during this staged rewrite.
The [native command reference](REFERENCE.md) and `schemas/` are also included in
the staged npm wrapper; installation smoke compares every command/option name
against that installed artifact's actual help output.

The native delivery path shares typed facts from `delivery_model`. `observation`
collects and re-reads native/worktree facts; `assessment` evaluates those facts
in memory, including missing or changed observations. `finish` renders the result,
while `watch` and `merge` consume the typed outcome directly. Report JSON is an
output protocol. Concrete `forge/github` and `forge/gitlab` adapters own merge
capability and association protocols; opaque snapshots retain full native
readback equality without exposing raw fields to those workflows.

`merge --request 41 --mode auto --strategy squash` requires fresh accepted evidence
and delegates through the authenticated native CLI with the assessed source SHA.
The result distinguishes queued, completed and merged with open issues. An
uncertain response is read back without resubmission or closure/delete fallbacks.
GitLab plain merge requires project-enforced no-squash, and auto mode requires a
current-head pipeline. GitLab rebase and enabled/unknown merge-train routing remain unsupported; GitHub
queue-only responses without readable native auto-merge evidence remain unknown.

`watch --request 41 --session task-id --goal lifecycle` observes for at most 30
minutes by default. `--goal checks` ends at current check results without claiming
merge or closure; `--once` performs one fresh read. `inbox` with the same identity
refreshes before offering pending events. `--no-refresh` shows unverified receipt
IDs only, while `--ack <id>` records explicit transport receipt. Events remain
session/worktree scoped, carry stable IDs and are superseded by new evidence.
Installed Claude PostToolUse registration includes a separate asynchronous hook
with a 30-minute observer and a 1,830-second host timeout. Relevant edits resume
the selected native request for that session/worktree. Concurrent triggers use
the same OS lease; ordinary local edits invalidate assessments while observation
continues. Branch/declaration identity changes stop with a resumable event.
SessionStart and relevant synchronous PostToolUse hooks surface unverified pending
IDs without network calls. Immediate idle wake is not claimed.

Use the pinned toolchain from this directory:

```sh
cargo fmt --check
cargo clippy --locked --all-targets --features test-fixtures -- -D warnings
cargo test --locked --all-targets --features test-fixtures
cargo install --locked --path . --root /tmp/specgit-native --debug
/tmp/specgit-native/bin/specgit doctor --provider github --remote origin --json
```

`doctor --provider gitlab --remote <name>` selects GitLab independently of GitHub.
For account checks outside Git, use `--account-only` and optionally `--api-host`.
Probes use the existing native CLI session and GET requests only. An available
read probe never proves mutation permission. Inaccessible 404 responses remain
ambiguous; forbidden, authentication, network, rate, size and malformed-response
errors have separate codes. Probe evidence includes an observation timestamp.
Command compatibility is refreshed on every invocation, with executable metadata
identity recorded for diagnostics; there is no compatibility cache.

All child calls use absolute executable/cwd paths and argument arrays. Defaults
limit input to 1 MiB, each output stream to 4 MiB and exchange time to 20 seconds.
A separate two-second cleanup grace bounds direct-child reaping; Tokio retains
background reaping if the OS does not finish within that grace. Unix process
groups and Windows jobs own ordinary descendants. Children that deliberately
escape Unix process groups are outside this transport's containment guarantee.
Windows children start suspended and join the kill-on-close job before resuming.
Cancellation and dropping the operation terminate its owned tree. This transport
is designed for trusted native Git/forge CLIs, not arbitrary hostile executables.

JSON stdout is one object with `schema_version`, `version`, `operation`, `status`,
`exit`, `evidence`, and `diagnostics`. Invalid input exits 2, unavailable evidence
3, cancellation 130, successful observations 0. Observation success is not a
delivery verdict. `finish` evaluates current native delivery evidence separately.
Raw provider stderr is classified locally and never copied into diagnostics.
Offline status only invokes Git and explicitly refuses to reinterpret existing
legacy declarations; use the explicit version-aware migration.

The fixture binary is gated behind `test-fixtures` and is excluded from ordinary
installation. CI builds release platform packages, installs them with npm outside the checkout,
and repeats public journeys through their installed entrypoint on the available
Linux, macOS and Windows runners. Local package installation does not establish
public-registry availability or qualification for other architectures.

`node scripts/profile-tests.mjs --output <new-directory>` runs every Cargo test
executable through the selected installed entrypoint and records each suite's
wall time, exact test names/results and total build/test time. It requires
`SPECGIT_TEST_BINARY`, `SPECGIT_TEST_LAUNCHER` and `SPECGIT_TEST_NODE` from the
installation evidence. `--compare <baseline/profile.json>` rejects a failed or
different platform, Node version or test workload. Child CLI/Git/fixture costs
are included in their suite time but are not separately attributed. The same
15-minute CI test budget applies; baseline measurements alone do not demonstrate
a performance improvement.

## Global integration stage (#510)

`setup --provider github` now installs versioned native assets and a hook manifest
under the native per-user data directory. `--root <absolute-path>` isolates the
installation. `--register-claude` explicitly selects native Claude registration;
`--claude-settings <absolute-path>` selects an isolated host configuration. An
existing recorded registration is retained on refresh. Registration also places
the portable skill under that host configuration directory's `skills` folder.

The ownership receipt records exact asset hashes and host groups. User fields,
foreign hook ordering, pre-existing empty keys, and file permissions survive
refresh/uninstall. Edited or missing owned content causes a conflict. Each change
uses a bounded OS lock, expected-content/permission checks and atomic replacement.
Transactions retain private preimages. `setup --root <path> --rollback <id>`
restores an explicitly selected transaction, refusing later user edits; repeat the
host settings selection when recovering a removed registration. An interrupted
transaction is reported before further writes. Backup directories remain for
recovery after uninstall; unrelated files and directories are retained.

Assets may install while account readiness is unknown; JSON reports `installed`
separately from `readiness`, and exits 3 for unavailable read evidence. A written
registration remains `written_not_verified`. Context delivery, visible messages,
next-turn delivery and idle wake are separate evidence claims.

`hook` uses the native host protocol, not the ordinary CLI report envelope. It
bounds stdin and collection time, emits informational diagnostics with exit 0,
and remains silent for uninitialized projects and irrelevant tools. It never
emits a permission grant. Stop uses an informational system message rather than
requesting another model turn. Session/worktree/head context has a stable local
identifier. Native issue selection and durable bounded background observation are integrated.
The hook never acknowledges its own output. A transport receipt remains pending
until an explicit `inbox --ack`; host configuration writes alone still do not
prove host delivery.

A Claude Code 2.1.241 smoke used an installed binary, isolated configuration,
fake credentials and a loopback-only Messages API fixture. The real host executed
SessionStart/Stop and included the hook context identifier in its actual request;
there was one request, so Stop did not loop. The API response was synthetic. This
proves the host import/context construction path, not external model delivery or
human acknowledgment. The external model readback remains unverified.

Reproduce the host import and skill discovery check with Python 3 and an installed
Claude Code (currently a POSIX probe):

```sh
python3 runtime/scripts/claude-local-host-probe.py --binary /absolute/path/to/specgit
```

The probe creates a synthetic repository and isolated host configuration, uses a
placeholder key and a loopback API, and leaves private evidence in its reported
temporary directory. It exits nonzero if the registered skill is absent, the
context identifier is missing, the host fails, or more than one model request
occurs. No external model response is involved.

The asynchronous regression uses the same real host against an isolated complete
native-request fixture. It verifies that a persisted event ID enters an actual
later model request and is returned by the synthetic API. Reproduce explicitly
from `runtime/` with `cargo test --features test-fixtures --test watch
real_claude_host_consumes_async_observer_event_on_the_next_model_turn -- --ignored
--nocapture`. This proves next-turn context delivery, not immediate idle wake,
a real remote forge lifecycle, external model interpretation or human reading.

## Project initialization stage (#511)

`init --provider github` inspects the selected project through native CLI/API
reads, resolves its current request target or intended native default, and writes
a strict v2 declaration plus an owned AGENTS block. `--inspect` performs the same
reads without writes. `--config-file` selects complete new declaration content;
otherwise refresh preserves existing conventions and template choices. Explicit
CLI choices override only their corresponding fields.

`--mirror-claude` also creates the marked CLAUDE block; refresh retains an existing
owned mirror. User content outside markers survives byte-for-byte. Damaged or
edited blocks are conflicts. `init --rollback <transaction>` restores a recorded
local transaction and preserves subsequent content/permission edits.

`--api-host` selects private per-worktree routing without putting that endpoint
in shared files. An explicit `--native-delete-source true|false` sends only the
provider's native cleanup boolean and reads it back. It never modifies default
branches or protection. An applied native setting is not silently compensated if
later local work fails. Native issue closing and branch cleanup remain separately
reported settings/eligibility observations, not a claim that a merge occurred.

Selected repository Markdown, inline templates and final body files have explicit
precedence. Native form candidates and inherited-template uncertainty remain
visible. Native issue creation and selected-template metadata reconciliation use these
same declaration/template rules. Real read-only GitHub/GitLab init probes passed;
actual setting writes and native closure lifecycle fixtures remain unverified.

## Promotion association inspection (#477)

`promotion --request 41 --source-request 42,43` combines native commit associations
with deliberately selected source requests. It reports the original issues and
current states for the actual target-to-head Git range. Full exact merge/squash
postimages can be suggested for deliberate association; reverts are excluded and
partial changes or unanchored cherry-picks stay unverified. Native associations
survive branch deletion; missing Git history is an actionable proof limitation.
The command never closes/reopens issues or edits the promotion body. Native
association discovery is explicitly non-exhaustive, with a 200-commit bound.

## Explicit migration stage (#513)

`migrate --config-file /absolute/next-v2.yaml` previews the exact local inventory,
proposed content hashes, preserved old request/issue binding and native retirement
evidence. Supply a complete v2 declaration explicitly; the operation does not
silently map old automation, independent closure, aggregate scopes or reuse flags.
`--apply --expect <preview_sha256>` applies only the matching preview. Restorable
preimages and an archive of all bounded legacy inputs are saved before any owned
writer is retired. V2 configuration is written last. `--rollback <transaction>`
restores expected content and refuses to overwrite later user edits.

`--retire-only` stages local retirement while leaving the v1 declaration in place.
It supports a separately reviewed native workflow retirement before cutover.
The migration command itself never changes native settings, workflows, protection,
issues, requests, schedules or source branches. GitHub activation checks the native
workflow catalogue, exact-default-commit configuration and unfinished run states.
GitLab reads the complete bounded native tree, follows static local CI includes,
and checks ordinary/child pipelines and active schedule refs. External/dynamic include boundaries, unknown
legacy assets and non-quiescent native execution prevent activation. These are
observations of known v1 integration, not a proof about arbitrary business scripts
or a guarantee against future external reconfiguration.

Owned block removal preserves surrounding prose and hook code. Unknown JSON
fields and foreign hook entries remain intact. GitLab's preserved business file
is restored to the root when its generated router is retired. Hooks shared by v1 worktrees are reported from either the main or linked
checkout and left to coordinated repository migration.
Untracked/private fixtures, policies/scopes and old drafts remain available to the
v1 executable; no old binding becomes a v2 native association automatically.
