# Lightweight SpecGit 2 runtime

This Cargo package builds the SpecGit 2 typed library and native CLI.
SpecGit manages specification Issues, aggregates them into a native PR/MR, and
observes changes for the Agent. The Agent supervises implementation and repairs.
GitHub/GitLab owns CI, reviews, protection, actual merge and ordinary Issue closure.

The Rust core, watch and hooks cannot merge, close Issues, delete branches or
administer native settings. An Agent can register native auto-merge through the
user's authenticated gh/glab session when existing authorization permits it.
Project preferences and hook messages grant no additional authority. Optional
Agent closure defaults off and requires authorization plus native readback.

The [command reference](REFERENCE.md) ships with the native npm wrapper. The
installed executable's offline `--schema` is the command/input/output discovery
source. [Distribution](distribution/README.md) describes the three-platform build and
installed-entrypoint checks. The root TypeScript workspace is private and retained
for engineering gates and historical regressions. Public v2 packages are generated
only by native distribution staging. Installation does not migrate a project.

## Using the runtime

```sh
specgit --schema
specgit init --provider github --check --json
specgit init --provider github --manual-observe --dry-run --json
specgit init --provider github --manual-observe --json
specgit issue 21 22 --dry-run --json
specgit issue 21 22 --json
```

Commit and push actual implementation through Git, then preview and create or
resume its request:

```sh
specgit pr --title 'feat: implement selected specs' --body-file /absolute/request.md --dry-run --json
specgit pr --title 'feat: implement selected specs' --body-file /absolute/request.md --json
specgit pr --status --json
specgit watch --request 42 --session task-42 --goal lifecycle --json
```

Issue/PR previews preserve local and remote business state. Missing catalog labels
require an explicit `--create-labels` choice. Uncertain writes retain their intent
and are reconciled against native objects; ambiguity requires inspection rather
than blind resubmission. Every selected Issue keeps its native closing reference.

`init --check` reads project capabilities without writing configuration. Native
auto-merge, target protection, closing expectations and request eligibility are
separate facts. Unsupported or unknown capability returns `confirmation_required`
with the report before any project asset write. Choose `--manual-observe` explicitly,
or have an authorized administrator configure the native platform and recheck.
The manual preference persists across refreshes. GitLab project metadata currently
cannot prove auto-merge support, so that capability remains unknown. A readable
GitHub repository auto-merge setting does not establish request eligibility or
complete target rules. Default branches come from the native project, not a guess.

`.specgit.yaml` contains the shared v2 declaration. `agent.native_auto_merge` and
`agent.close_issues_after_merge` both default to false. Native protection rules
remain on the platform. Unknown/duplicate fields, unsafe paths and invalid values
fail before writes; a retired declaration field requires explicit migration.

## Business boundaries

Issue and PR operations use separate `IssueWrite` and `RequestWrite` capabilities;
raw transport remains private to the forge adapters. Specification rules live in
`spec`, whose read-only view exposes rule operations and selected template/language
values. Workspace configuration stays private and observations receive only their
closure preference. Full declaration bytes are still checked for concurrent edits.
New specification rules belong in `spec`, request write operations in the request
capability and adapter, and host framing in the host adapter.

## Machine and host interfaces

Ordinary non-TTY output defaults to one JSON report. `--json` selects it explicitly;
`--human` selects text. `--input-file <path>` accepts one bounded JSON request and
`--input-file -` explicitly selects stdin. Ordinary argv calls never implicitly
consume stdin. Help and schema are offline and work outside a Git repository.
JSON is the output boundary: internal use cases share typed library values.

`pr --status` describes native facts without computing merge eligibility. A
successful observation is not approval to mutate. A merged request with linked
Issues still open produces attention; any supplementary closure belongs to an
explicitly authorized Agent action outside the runtime.

`watch` is bounded and session/worktree scoped. `inbox` refreshes pending changes;
`--no-refresh` lists unverified receipt IDs, and `--ack` records transport receipt.
Events carry stable IDs and are superseded by changed evidence. Branch or
configuration identity changes stop the subscription with a resumable notice.

`setup --dry-run` previews install, update or uninstall assets without creating
directories or taking the asset lock. Real apply rechecks file content and
permissions after locking. Exact ownership receipts, atomic replacements and
restorable preimages preserve foreign content. An interrupted transaction or
edited owned file needs explicit recovery. Uninstall retains recovery backups.
On Windows, a blocked atomic replacement retries the same staged file for up to
one second. Content or permission changes stop the retry; a persistent failure
keeps the destination intact and returns an error.

Claude registration exports SessionStart, PreToolUse, PostToolUse and Stop;
relevant PostToolUse can start a bounded asynchronous observer. The host adapter
uses its own event framing, not the ordinary report envelope. Registration reports
`written_not_verified`. Import, context injection, visible messages, next-turn
delivery and human reading are distinct evidence. Immediate idle wake is not
supported; pending notices remain available through explicit observation.

## Development and qualification

Use the pinned toolchain from this directory:

```sh
cargo fmt --check
cargo clippy --locked --all-targets --features test-fixtures -- -D warnings
cargo test --locked --all-targets --features test-fixtures
cargo install --locked --path . --root /tmp/specgit-native --debug
/tmp/specgit-native/bin/specgit --schema
```

The fixture executable is behind `test-fixtures` and excluded from ordinary
installation. Every target needs its own installed-entrypoint and runtime
qualification. An earlier run, a successful local build or another architecture's
result does not establish current Linux/macOS/Windows qualification.

Child transport uses absolute executable/cwd paths and argv arrays. Defaults bound
input to 1 MiB, each output stream to 4 MiB and exchange time to 20 seconds. A
separate two-second cleanup grace bounds direct-child reaping. Unix process groups
and Windows kill-on-close jobs own ordinary descendants; Windows children join
the job before resuming. Deliberate Unix group escape is outside this trusted-CLI
transport's containment guarantee. Cancellation terminates the owned process tree.

`node scripts/profile-tests.mjs --output <new-directory>` records suite timing and
exact results through the selected installed entrypoint. It requires the
`SPECGIT_TEST_BINARY`, `SPECGIT_TEST_LAUNCHER` and `SPECGIT_TEST_NODE` installation
evidence. `--compare <baseline/profile.json>` requires comparable platform,
Node version and workload. Measurements alone do not prove an improvement.

Migration preserves old work and requires an explicit v2 declaration plus an
exact reviewed preview digest. It changes owned local integration only; native
workflow retirement needs a separately authorized repository change. Unknown
writers, dynamic includes or unfinished native execution prevent activation.
See the packaged reference for recovery and release boundaries.
