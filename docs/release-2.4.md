# SpecGit 2.4 Preparation Ledger

Preparation date: 2026-10-03, on branch `feat/project-only-240`. This ledger
describes the selected scope and the remaining qualification/publication gates.
It is not a release receipt: publication requires the separate signed workflow
and native readback. Local host qualification below is not current-head CI or
three-platform release evidence.

Selected specification: [#660](https://github.com/LeXwDeX/SpecGit/issues/660),
permanent project-only redesign.

## Scope

SpecGit 2.4 makes agent integration permanently **project-only**. The shared
user-installed CLI remains the single operational binary; a project never
copies it, and no user-global integration root, host assets or global state is supported
now or later.

- `setup` keeps `--scope project` as the default and only scope value.
  `--agent generic|claude|codex|opencode` remains repeatable, and
  `--dry-run`, `--uninstall` and `--rollback` are retained.
  `--opencode-claude-hooks` is a new explicit custom-host opt-in that requires
  `--agent opencode`.
- The global integration scope and its options are removed from current
  commands: `--root`, `--provider`, `--api-host`, the legacy
  `--register-claude|--register-codex|--register-opencode` forms and the
  per-host `--claude-settings`, `--codex-root`, `--opencode-root` paths are
  rejected input, not deprecated aliases.
- `hook`, `watch` and `inbox` lose `--state-root`; their state is always
  Git-private.
- New project hooks invoke the currently installed executable directly, so no
  global setup prerequisite exists. The v2 receipt format omits `shared_root`;
  2.3-era project receipts are refreshed, removed or recovered locally with
  foreign content and manual edits preserved, never by reading or writing the
  retired global root.
- Existing 2.3 global data stays preserved. 2.4 ships no global cleanup
  command; operators back up first and use the 2.3 CLI's exact owned cleanup
  before upgrading if needed. Never blind-delete.
- Official OpenCode keeps the skill and guidance only. The
  `--opencode-claude-hooks` opt-in generates project `.opencode/hooks.json`
  for a custom OpenCode fork with claude-code input: top-level event entries,
  one single-quoted command string, no separate `args` field, and no asynchronous observer —
  observe manually with bounded `watch`. Qualification is build-specific;
  complete semantics are not proven. The fork's `/import-claude-hooks` command
  is an interactive LLM prompt that asks per settings entry; entries owned by
  native setup must not be imported again as unmanaged duplicates.
- Hook documentation states the actual decision contract: native input keys
  (`hook_event_name`, `session_id`, `cwd`, `tool_name`, `tool_input`,
  `stop_hook_active`), explicit deny via
  `hookSpecificOutput.permissionDecision` with a reason, pass-through
  otherwise, `apply_patch` verified by parsing its patch markers and checking
  each actual target through Git, and `additionalContext` guidance.

The `remove` command, `guard`, delivery lifecycle, forge responsibility
boundaries and `init` remain unchanged by this redesign except where setup
scope or state location is named above. Issue creation coordination now covers
linked worktrees sharing one common Git directory, not independent clones;
there is no user-global lock. Generated init guidance also states the permanent
project-only boundary.

## Local host qualification

The installed custom OpenCode `1.0.57` was exercised with an isolated project,
synthetic loopback model and fixture-only credentials. Project hook import,
tracked-write denial without a checkpoint, allowance with a valid fixture
checkpoint, and PreToolUse/PostToolUse model context passed. SessionStart
executed but its context was lost in `opencode run`, including continuation;
TUI/serve were not qualified. This host offered no patch tool, so patch aliases
have adapter/subprocess evidence only. These limitations are documented in the
[supported tools guide](supported-tools.md#observed-custom-host-behavior).

## Remaining gates (not yet met)

- Pinned Rust fmt/Clippy/all-target tests, native distribution tests, and
  installed-runtime qualification for the exact release source on Linux x64,
  macOS arm64 and Windows x64.
- PR review and current-head CI, native merge of the delivery request into
  main, and closure of #660.
- The separately dispatched signed Release workflow, published assets and
  native readback. Until then, this branch's documentation describes the
  intended 2.4 contract; the installed CLI's `--help`/`--schema` remains the
  authority for any currently installed version.

See the [release procedure](../runtime/distribution/README.md) for publication
and interrupted-publication recovery, and the
[native reference](../runtime/REFERENCE.md) for the command contract this
ledger summarizes.
