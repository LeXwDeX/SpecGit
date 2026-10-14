# Supported coding agents

SpecGit 2.10.0 provides a native CLI and managed agent integrations. One shared
user-level `specgit` executable serves every repository and worktree.
`specgit setup` refreshes all recorded agents plus explicitly selected
agents (`--agent generic|claude|codex|opencode`, repeatable); the flag does not
confine refresh to that host. Setup is
permanently project-only: `--scope project` is the default and the only scope
value, writing documented checkout assets with a worktree-private receipt.
Setup never copies the runtime binary into a project and never installs user-global
host integration assets or state; project hooks invoke the installed executable
directly, so there is no global setup prerequisite.
Refresh replaces recorded assets and complete, uniquely marked managed blocks,
including edited body text, while preserving bytes outside blocks, configuration,
checkpoints and other tools' hooks. Unknown ownership and damaged/duplicate markers
remain conflicts. `specgit init` remains project-scoped; agent integration stays
optional and separate. Written registration is not proof of host import or
notification delivery. Follow the [installation guide](agent-install.md) for
the matching host registration option and verification steps. With the CLI already
installed, use the [project maintenance guide](agent-project-refresh.md) instead;
unknown optional remote capability does not block applicable local refresh, but init
still requires an explicit manual-observation choice where its preference requires one.

## Project integration assets

Project integration remains project-only. The only user-level asset is the
explicitly installed Skill file; no global hooks, state or receipts.
`specgit skill --user` is a separate explicit opt-in for
`~/.agents/skills/specgit-native/SKILL.md` (Windows uses `%USERPROFILE%`). Setup
does not install it. Use `--dry-run` to preview, `--remove` for managed unedited
content, or `--refresh-only` to refresh only an existing managed file. A successful
`update` refreshes that managed user Skill through the new executable; failures
retain the binary and give `specgit skill --user` as the remedy. Host discovery
still follows the host's documented paths; installation alone proves no import.

| Agent | Project assets (the only scope) |
| --- | --- |
| `generic` | `.agents/skills/specgit-native/` plus root `AGENTS.md` guidance; no hooks |
| `claude` | `.claude/skills/specgit-native/` copy, root `CLAUDE.md` guidance, `.claude/settings.json` hooks |
| `codex` | Root `AGENTS.md` (or existing nonempty `AGENTS.override.md`) guidance plus `.codex/hooks.json` |
| `opencode` (official) | `.agents` skill and root `AGENTS.md` guidance only; no hooks |
| `opencode` custom fork with `--opencode-claude-hooks` | Adds selected compatible hooks in `.opencode/hooks.json` with `inputFormat: claude-code`; idle wake also requires explicit `--opencode-async-rewake`, confirmed capability and observe/context purposes |

In 2.8, select minimal authorized purposes with repeatable `--hook-purpose
guard|context|observe`, or `none` for no new hooks. Omission preserves exact recorded
modes on ordinary refresh. Explicit purposes apply to all recorded and newly
selected hosts; purpose changes need authorization for every affected host.
`none` preserves existing purposes and never uninstalls hooks or Git guard.
Review/report all hosts' asset changes, including shared Skill refresh, even with
`none`. Claude/Codex hook entries in this table depend
on that selection. Official OpenCode and generic remain guidance/Skill only. See
the [purpose and receipt contract](../runtime/REFERENCE.md#select-project-hook-purposes)
for per-host declined reasons and older-client downgrade limits.

Every project agent selection writes the canonical
`.agents/skills/specgit-native/SKILL.md`; Claude additionally receives its
native skill copy. Project scope resolves the Git checkout and the private
absolute Git directory, records its receipt and journal under
`<git_dir>/specgit-v2/agent-assets/`, and therefore integrates each linked
worktree independently. The 2.4 receipt omits `shared_root`; a 2.3-era project
receipt is refreshed, removed or recovered locally with foreign content and
manual edits preserved, and setup never reads or writes the retired 2.3 global
root. Existing 2.3 global data stays preserved — 2.4 ships no global cleanup
command, so back up first and use the 2.3 CLI's exact owned cleanup before
upgrading if it must go; never blind-delete.
Selection is additive on refresh, a new project integration requires an
explicit `--agent`, and `--uninstall` (without `--agent`) removes exactly the
recorded project assets of that worktree.

## Discovery boundaries

Each host discovers only what its own documentation says it discovers.
`.agents/skills` is an entry point documented by Codex, which scans it from
the working directory up to the repository root and also reads
`~/.agents/skills` ([build skills](https://learn.chatgpt.com/codex/build-skills))
and by OpenCode, which reads project `.opencode/`, `.claude/` and
`.agents/` skills plus the matching global roots
([Agent Skills](https://opencode.ai/docs/skills/)). Claude Code documents
project skills at `.claude/skills/<name>/SKILL.md`
([skills](https://code.claude.com/docs/en/skills)) and command hooks in
`.claude/settings.json`, `.claude/settings.local.json` or
`~/.claude/settings.json`, including exec-form `command` plus `args`
handlers ([hooks](https://code.claude.com/docs/en/hooks)). Codex documents
project hooks at `<repo>/.codex/hooks.json`
([hooks](https://learn.chatgpt.com/docs/hooks)). Generic `.agents` support is
therefore limited to hosts that document it; it is not a universal standard,
and other agents can still use the CLI and project guidance directly.

Codex requires the user to review and trust non-managed hooks, and
project-local hooks load only when the project `.codex/` layer is trusted in
the host's `/hooks` review. SpecGit reports this as
`codex_trust: review_in_host_required` and never performs, assumes or
automates that trust. The official OpenCode build has no hook registration in
this integration; it receives the skill and guidance only. The
`--opencode-claude-hooks` opt-in targets a custom OpenCode fork with
claude-compatible hooks. Qualification is specific to the installed build,
not a guarantee of complete semantics or compatibility with every fork. The
compatibility flag alone enables no asynchronous observer. In 2.8, custom idle
wake needs real `asyncRewake` capability confirmation, user authorization and
`--opencode-async-rewake` with observe/context. Upgrade alone never opts in.
Without verified delivery, use bounded `watch`/`inbox` or manual continuation.
Configured idle wake is not proof of actual context or idle delivery.
The fork's `/import-claude-hooks` command is an
interactive LLM prompt that reads the project's Claude settings and asks about
each entry individually — it is not an automatic read, and entries that native
setup already owns must not be imported again as unmanaged duplicates. In every case setup reports
registration as `written_not_verified` with host delivery facts
(`imported_event`, `context_injection`, `visible_message`, `next_turn`) as
`not_checked`; a reload, trust review or later turn may be needed before the
host actually consumes the assets.

Custom hooks use Bash. On Windows, the host's `bash` must resolve to Git for
Windows Bash, not the Windows WSL launcher. Put Git's `bin` directory before
the WSL launcher in the host's PATH and qualify the generated command in that
same environment; merely having Git available does not select its Bash.

### Observed custom-host behavior

An isolated qualification on 2026-10-03 used custom OpenCode `1.0.57`
(binary SHA-256 `7db7cb2cd1ba69d7ece113023c2e5aba0f572f9e1d225fece429f295b376d7db`)
with a loopback fixture model. The actual host imported project hooks, denied a
tracked `write` without a checkpoint, permitted it with a valid fixture
checkpoint, and delivered PreToolUse/PostToolUse context to the model.

In that build's `opencode run` mode, SessionStart executed but its
`additionalContext` did not reach the model, including on a continued session.
Do not depend on startup context or notices there; use project guidance,
tool-event context and explicit bounded `watch`/`inbox`. TUI and serve modes
were not qualified. The host offered no `apply_patch` tool: patch aliases are
verified at the SpecGit adapter/subprocess boundary, not by that live-host run.
Registration still reports `written_not_verified`; local qualification does
not automatically certify another installation or human reading.

Use the installed executable's `specgit --help` and `specgit --schema` as the
command contract. The maintained command, configuration, and JSON reference is
the [native runtime reference](../runtime/REFERENCE.md). The installed
[SpecGit skill](../runtime/assets/SKILL.md) describes the agent workflow.

## Delivery flow

Read-only inspection and `--dry-run` previews do not authorize writes. Select
complete relevant Issues before tracked product edits, then implement, verify,
commit, and push the actual changes. Create or adopt a draft PR/MR with
`specgit pr`, preserving every closing reference.

When review preparation is complete, preview with
`specgit pr --ready --request <id> --dry-run --json`, then
`specgit pr --ready --request <id> --json` marks
the request ready within existing user authorization. Review and merge happen
on GitHub or GitLab; `specgit watch` only observes current evidence. After the
platform reports a merge, use `specgit pr --status --request <id>` to read back
the native request and associated Issue state. Exit zero means that operation
succeeded; it does not by itself prove merge or completed delivery.

For v1 projects, use the [v1 to v2 migration guide](migration-v2.md). The old
`finish`, `accept`, `bind`, and `unbind` commands belong to SpecGit v1 and are
not commands in the native v2 CLI.
