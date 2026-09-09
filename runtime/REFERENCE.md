# SpecGit 2 native command reference

This reference describes the Rust 2 development artifact. The repository's root
TypeScript package, `skills/` and older documentation describe the retained 1.x
distribution until an explicitly approved major-version cutover. Installing or
testing a 2.0 development artifact does not publish it or migrate any project.

## Install and authority

The npm wrapper selects an exact-version precompiled platform package, verifies
its binary digest and invokes Rust with unchanged arguments and inherited I/O.
Supported package targets are Linux x64/arm64 with glibc, macOS x64/arm64 and
Windows x64 MSVC. Node.js 20.19 or newer is required; Rust and private source
access are not installation requirements. Linux requires at least the glibc
version recorded in the selected platform manifest. Other targets report an
explicit unsupported-platform error. Public registry installation is a separate
qualification gate; development tarball installation does not establish it.

`setup` installs owned global assets; `init` writes the shared project declaration
and owned guidance. Neither creates a CI workflow. The selected project's native
CI owns scheduling, caches and path applicability. Required checks must produce
current, readable native evidence. Readiness and body edits require a fresh
assessment but do not themselves require another business-test execution.

The project declaration is `.specgit.yaml` with `version: 2`. It is the only shared
configuration. The ignored Git-directory checkpoint contains local selection,
submission recovery and subscriptions; it does not establish remote completion.
Unknown/duplicate keys, invalid paths and out-of-bounds values are rejected.

```yaml
version: 2
remote: origin
provider: github
language: en
validation:
  titles: true
  labels: kind
  bodies: true
verification:
  required_checks: [Native verification]
```

`target` is optional and defaults to the native project default branch. `labels`
defaults to `off`; `project` mode requires a declared `tags` catalog. Template
selectors are `builtin`, `repository` with a safe relative `path`, or `inline`
with a nonempty `body`. Both issue and request templates can define a `title`
and `required_sections`. Omitted validation booleans default to false.
Observation defaults are 15 seconds between polls, 1,800 seconds maximum, and
attention/completed notifications. The declaration schema records all fields;
runtime parsing additionally enforces YAML duplicate keys, UTF-8 byte bounds,
Git-ref syntax, unique tag names and relational timing bounds.

## Commands

All commands accept `--cwd <path>` and `--json`. Run `specgit <command> --help`
for the complete CLI syntax. Files in `schemas/` describe normalized options;
they do not add a JSON input transport. `hook` has separate host stdin/output.

| Command | Purpose and principal options |
| --- | --- |
| `doctor` | Read command/account/project capability. Requires `--provider github\|gitlab`; optional `--remote`, `--api-host`, `--account-only`. Successful help does not prove API access or mutation permission. |
| `setup` | Install/update global native assets. Optional `--root`, `--provider`, `--api-host`; explicit `--register-claude` and optional `--claude-settings` select host registration. `--uninstall` or `--rollback <transaction>` preserves foreign assets and refuses ownership drift. |
| `init` | Inspect native flow and generate project assets. Select `--remote`, `--provider`, `--api-host`, `--target`, `--language en\|zh`, `--config-file`, or `--mirror-claude`. `--inspect` is read-only. Explicit `--native-delete-source true\|false` changes that native setting with readback; `--rollback` restores owned local assets only. |
| `issue` | Select positive issue IDs or create complete specs from titles. Repeat `--body-file` in new-title order; optional `--tags`, `--branch`, `--inspect`. Duplicate candidates require inspection and deliberate adoption. No binding-only commit or push is created. |
| `pr` | Create after a real pushed diff, resume, or adopt `--request <id>`. Optional `--title`, `--body-file`, `--tags`; explicit `--ready`, `--update-body`, or `--update-references` preserves every existing deliberate association. `--inspect` performs no mutation. |
| `status` | Offline Git identity, local selection and pending subscription state. Optional `--remote` and `--provider`; no forge child is invoked. |
| `finish` | Read-only fresh acceptance; optional exact `--request`. Re-reads native request/issue/head/target/rules/check attempts. Candidate configuration cannot exempt itself from target-approved requirements. |
| `merge` | Explicit native delegation with required `--request`, `--mode now\|auto`, and `--strategy merge\|squash\|rebase`. Fresh acceptance and supported native capabilities are required. Queue acceptance is reported as queued. |
| `promotion` | Inspect issue association evidence for `--request`, optionally selecting repeated `--source-request`. Uses exact native associations and Git postimages; ambiguous partial/reverted/cherry-picked changes remain unproven. |
| `watch` | Bounded current checks/lifecycle observation. Requires `--request`, `--session`, `--goal checks\|lifecycle`. Optional `--once`, `--state-root`, `--timeout-seconds` (1–3,600), `--poll-seconds` (1–300). |
| `inbox` | Refresh one request/session/goal subscription. `--no-refresh` lists unverified IDs only; explicit `--ack <event-id>` records transport receipt. It does not prove human reading or acceptance. |
| `hook` | Host adapter with required `--event`; optional `--state-root` and asynchronous PostToolUse `--observe`. Synchronous framing is bounded and informational. |
| `migrate` | Preview explicit 1.x retirement using `--config-file <v2.yaml>`. Apply the exact preview with `--apply --expect <digest>`; `--retire-only` leaves v1 authority for an intermediate retirement commit. `--rollback <transaction>` restores proven local assets. |

GitHub/GitLab writes use the selected authenticated `gh`/`glab` session. SpecGit
does not store credentials. API-host selection is local routing, not a credential
field in the shared declaration. A forbidden or ambiguous 404 never proves that
a project, protection rule or CI result is absent.

## Ordinary delivery

Initialize the project once. Before a tracked edit, select the native issues:

```sh
specgit init --provider github --config-file /absolute/path/project-v2.yaml --json
specgit issue 21 22 --json
```

Commit and push the real work through Git, then create or resume the request:

```sh
specgit pr --title 'feat: implement the selected specs' --body-file /absolute/path/request.md --json
specgit pr --ready --json
specgit finish --json
```

Use `Closes #21` and `Closes #22` for same-project associations. Native closing
rules depend on the target/default branch and project settings. A merge into an
intermediate branch can legitimately leave issues open. SpecGit reports that
state and never compensates through an issue-close or branch-delete endpoint.
Only an already authorized merge may be requested:

```sh
specgit merge --request 42 --mode auto --strategy squash --json
specgit watch --request 42 --session task-42 --goal lifecycle --json
specgit inbox --request 42 --session task-42 --goal lifecycle --json
```

GitLab rebase and enabled/unknown merge-train routing are currently unsupported.
GitLab plain merge requires project-enforced no-squash. Fork writes and unproven
native queue capabilities are refused. Recover from an uncertain write by
resuming the exact request; inspect ambiguity instead of resubmitting blindly.

## Results and host delivery

Ordinary JSON stdout is one report with `schema_version`, `version`, `operation`,
`status`, `exit`, `evidence`, and `diagnostics`. Exit values are 0 for successful
observation, 1 for rejected evidence, 2 for invalid input, 3 for unavailable
evidence, and 130 for cancellation. An exit 0 from a probe is not acceptance;
`finish` must report `accepted`. `completed` also requires the observed native
merge and closed associated issues. Source cleanup is independently reported.

Claude registration includes SessionStart, PreToolUse, PostToolUse and Stop.
Relevant PostToolUse can start a bounded asynchronous read-only observer.
Registration reports `written_not_verified`; configuration alone never proves
notification. The demonstrated host fallback delivers pending events on a later
model turn. Immediate idle wake and external model interpretation are not
claimed. Stop does not request another turn, and no hook acknowledges itself.

## Migration and release boundaries

Retain the 1.x executable while inspecting an unmigrated project. Preview first;
only exact owned assets and proven remote writers can be retired. Shared hooks,
edited assets, unknown workflows/includes and old in-flight executions can block
migration. Apply preserves private backups and foreign content; rollback refuses
later conflicting edits. Existing draft requests remain preserved.

Retired 1.x commands `bind`, `unbind`, `accept` and orchestration options such as
`--automation`, `--close-issues`, `--scope`, `--plan-checks` and `pr --merge` return
actionable major-version diagnostics. Native issue/request association, explicit
`merge`, and project-native CI replace their applicable behavior.

Local staging, qualification, programme merge/issue closure, and public publication
are separate outcomes. All five native packages and the exact pinned wrapper
must be independently qualified before publication. Partial publication recovery
reads registry identity/integrity and never silently advances a tag. The current
owned-runner-only policy does not satisfy npm's hosted-only OIDC requirement;
no source visibility change or publishing credential is inferred.
