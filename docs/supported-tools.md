# Supported coding agents

SpecGit 2.16.0 provides a native CLI and managed project guidance. One shared
user-level `specgit` executable serves every repository and worktree. Run
`specgit init` in every clone and worktree: it installs the common project Skill
and stable guidance entry points. Local declarations, Skills and private receipts
do not travel with Git. On a new project `init` also installs the native Git guard,
so every commit binds an Issue; it does not install host hooks. Select host integration
separately with `specgit setup`; it refreshes recorded hosts plus explicitly
selected agents (`--agent generic|claude|codex|opencode`, repeatable). Setup is
project-only and does not copy the runtime binary or scan other repositories.
Hooks invoke the shared installed executable directly.
Refresh replaces recorded assets and complete, uniquely marked managed blocks,
including edited body text, while preserving bytes outside blocks, configuration,
checkpoints and other tools' hooks. It migrates recorded, uniquely owned legacy
guidance blocks; unknown ownership and damaged or duplicate markers remain conflicts.
Written registration is not proof of host import or notification delivery. Follow
the [installation guide](agent-install.md) for the matching host registration
option and verification steps. With the CLI already
installed, use the [project maintenance guide](agent-project-refresh.md) instead;
unknown optional remote capability does not block applicable local refresh.

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

Naming a new host with `--agent` selects its project guidance and Skill only.
Hooks are opt-in: add `--hook-purpose guard` for native Git commit/push checks
or `--hook-purpose context` for supported SessionStart/PreToolUse context. An
omitted purpose leaves existing recorded choices unchanged. Use
`--hook-purpose none` when adding guidance without hooks.

| Agent | Project assets |
| --- | --- |
| `generic` | Root `AGENTS.md` stable entry to `.agents/skills/specgit-native/SKILL.md`; no hooks |
| `claude` | Root `CLAUDE.md` stable entry to the canonical `.agents` Skill; `.claude/skills/specgit-native/SKILL.md` copy for host discovery and selected `.claude/settings.json` hooks |
| `codex` | Root `AGENTS.md` (or existing nonempty `AGENTS.override.md`) stable entry to the canonical `.agents` Skill, plus selected `.codex/hooks.json` hooks |
| `opencode` (official) | Root `AGENTS.md` stable entry to `.agents/skills/specgit-native/SKILL.md`; no hooks |
| `opencode` custom fork with `--opencode-claude-hooks` | Adds compatible SessionStart and PreToolUse hooks in `.opencode/hooks.json` with `inputFormat: claude-code` |

Select supported SessionStart and PreToolUse hooks only. SessionStart gives brief rules and the Skill entry; PreToolUse supplies relevant context or recovery. No PostToolUse, Stop callback or idle wake is supported. `guard` configures native Git commit/push hooks; `context` needs actual host support. `observe` is recognized but declined; use bounded watch/inbox. Omission preserves exact recorded
modes on ordinary refresh. Explicit purposes apply to hosts named by `--agent`,
or all recorded hosts when `--agent` is omitted; keep changes within the current task.
`none` adds no purposes and preserves valid purposes and native Git guard;
refresh still removes owned retired PostToolUse/Stop registrations.
`--remove-hook-purpose guard` or `--remove-hook-purpose context` removes only
that recorded purpose, keeping the other purpose and unrelated host entries.
Review/report all affected hosts' asset changes, even with `none`. Host hook entries depend on that selection and actual host support. Generic has no host callbacks; native Git guard is available separately. See
the [purpose and receipt contract](../runtime/REFERENCE.md#select-project-hook-purposes)
for per-host declined reasons and older-client downgrade limits.

Every entry point contains stable instructions pointing to the canonical
`.agents/skills/specgit-native/SKILL.md`, without versioned declaration summaries
or hashes. Claude also gets
`.claude/skills/specgit-native/SKILL.md` for host discovery. Project scope resolves
the Git checkout and private absolute Git directory. The receipt remains at
`<git_dir>/specgit-v2/agent-assets/ownership.json`; new transaction journals are
stored under `<git_dir>/specgit-v2/assets/`. Older journals under `agent-assets/`
are used only as migration evidence or for recovery. This state keeps each linked
worktree's integration independent. The 2.4 receipt omitted `shared_root`; current CLIs refresh, remove or recover
2.3-era receipts locally while preserving foreign content and manual edits. Setup
does not access the retired 2.3 global root. During a 2.3-to-2.4 migration, old
global data remained untouched because 2.4 had no cleanup command; required cleanup
used the 2.3 CLI's exact owned cleanup before upgrading. New projects need no `--agent`:
`setup` installs the shared Skill and guidance baseline. `--agent` remains a compatibility
selector for named hosts. `--uninstall` without it removes this worktree's recorded assets.

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
Only SessionStart and PreToolUse are supported. If automatic observation cannot be delivered through those events, report the limitation and use bounded `watch`/`inbox` or manual continuation. Do not claim idle wake.
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
with a loopback fixture model. The actual host imported project hooks and denied a
tracked `write` without a checkpoint, permitted it with a valid fixture
checkpoint, and delivered PreToolUse/PostToolUse context to the model. This is a dated historical qualification of older behavior, not the current hook contract.

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

Read-only inspection and `--dry-run` previews do not authorize writes by themselves.
Installation or enablement delegates the current task workflow within its scope, so
continue through required Issue, implementation, verification and delivery steps without
repeated approvals. Select complete Issues before commit/push; ordinary edits are free.
For larger goals, use a Milestone with Issues split by outcome and dependency. TDD and
PR Actions/CI follow-up are recommended; project/platform-required checks remain required. Create or adopt a draft PR/MR with
`specgit pr`, preserving every closing reference.

When review preparation is complete, preview with
`specgit pr --ready --request <id> --dry-run --json`, then
`specgit pr --ready --request <id> --json` marks
the request ready within the task delegation. Review and merge happen
on GitHub or GitLab; `specgit watch` only observes current evidence. After the
platform reports a merge, use `specgit pr --status --request <id>` to read back
the native request and associated Issue state. Exit zero means that operation
succeeded; it does not by itself prove merge or completed delivery.

For v1 projects, use the [v1 to v2 migration guide](migration-v2.md). The old
`finish`, `accept`, `bind`, and `unbind` commands belong to SpecGit v1 and are
not commands in the native v2 CLI.
