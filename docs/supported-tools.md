# Supported coding agents

SpecGit 2.21.0 provides a native CLI and managed project guidance. One shared
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

## Support matrix

New capability lands in the CLI and the native Git guard first and works fully
with zero host integration. Host hooks only supply prompts and context; they do
not carry business rules. Each host adaptation states its support status and
fallback in the installation catalog (`specgit setup --catalog --json`), and the
matrix below is the maintained summary. Host discovery boundaries and dated
evidence follow.

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

| Host | Guidance entry | Skill discovery | Context hooks | Read-only allowlist | Fallback |
| --- | --- | --- | --- | --- | --- |
| `generic` | `AGENTS.md` | `.agents/skills/specgit-native/SKILL.md` when the host reads `.agents` | none; declined | declined: no host permission configuration | Read guidance and the Skill directly |
| `claude` | `CLAUDE.md` | Canonical `.agents` Skill plus `.claude/skills/specgit-native/SKILL.md` | `.claude/settings.json` SessionStart/PreToolUse | `.claude/settings.json` `permissions.allow` with `--readonly-permissions` | Re-read guidance and Skill |
| `codex` | `AGENTS.md`, or an existing nonempty `AGENTS.override.md` | Canonical `.agents` Skill; Codex scans it from the working directory to the repository root and also reads `~/.agents/skills` | `.codex/hooks.json`; requires the host `/hooks` trust review | declined: experimental approval and sandbox | Re-read guidance and Skill |
| `opencode` (official) | `AGENTS.md` | `.agents` Skill; the host also reads project `.opencode/` and `.claude/` skills | none; declined | declined: default-allow, no portable allowlist | Re-read guidance and Skill; bounded `watch`/`inbox` |
| `opencode` custom fork with `--opencode-claude-hooks` | `AGENTS.md` | Same as official OpenCode | `.opencode/hooks.json` with `inputFormat: claude-code`; requires `--agent opencode` plus an explicit hook purpose | declined | Same as official OpenCode |

`guard` is the native Git pre-commit/pre-push check, not a host callback. It
applies to every host, including generic, through `setup --hook-purpose guard`
or `specgit guard --install`. Context hooks are optional; they only prompt and
provide context, and never carry business rules.

Preview, then apply each host selection:

```sh
# Generic: guidance and canonical Skill; no host callbacks
specgit setup --agent generic --dry-run --json
specgit setup --agent generic --json

# Claude Code: guidance and both Skills, plus optional context and read-only rules
specgit setup --agent claude --dry-run --json
specgit setup --agent claude --json
specgit setup --agent claude --hook-purpose context --dry-run --json
specgit setup --agent claude --hook-purpose context --json
specgit setup --agent claude --readonly-permissions --dry-run --json
specgit setup --agent claude --readonly-permissions --json

# Codex: guidance, Skill and .codex/hooks.json; trust the project layer in /hooks
specgit setup --agent codex --hook-purpose context --dry-run --json
specgit setup --agent codex --hook-purpose context --json

# OpenCode: the official build gets guidance and Skill only
specgit setup --agent opencode --dry-run --json
specgit setup --agent opencode --json
# Custom fork only:
specgit setup --agent opencode --opencode-claude-hooks --hook-purpose context --dry-run --json
specgit setup --agent opencode --opencode-claude-hooks --hook-purpose context --json
```

A new `--agent` host adds guidance and the Skill only. Hooks and managed
read-only permissions are separate explicit choices. Written registration does
not prove host import, context delivery or actual prompt behavior.

## Hook and permission selection

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

Claude Code additionally supports an optional managed read-only command
allowlist: `setup --agent claude --readonly-permissions` appends a fixed set of
`Bash(specgit <argv> *)` rules to project `.claude/settings.json`
`permissions.allow`, preserving user rules and their order; refresh is
idempotent and `--remove-readonly-permissions` removes only managed entries.
This is prompt reduction, not a sandbox or an authorization boundary: write
commands and excluded reads such as `pr --status` still prompt, and written
rules do not prove that the host loaded them. Verify both that managed read-only
commands stop prompting and that write commands still prompt in the real host.
OpenCode, Codex and generic are not supported and keep per-invocation approval:
OpenCode allows tools by default and a read-only allowlist would need global
deny-by-default configuration with JSONC and multi-path ownership; Codex
approval and sandbox configuration is still experimental and allow rules can be
bypassed; generic has no host permission configuration. Installation reports
those hosts as declined, and removal requires a recorded Claude registration. See the
[read-only permission contract](../runtime/REFERENCE.md#select-read-only-host-permissions).

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

## Candidate host evaluation

On 2026-11-14 we reviewed first-party documentation for eight additional coding
agents against the same dimensions as the matrix above: guidance entry, Skill
discovery, hooks and non-interactive verification. These are documentation
evaluations, not live host qualifications; written support does not prove host
import, context delivery or prompt behavior. None of these hosts is a supported
`--agent` selection. Where `generic` already covers the host's documented
guidance and Skill paths, no adapter is needed.

| Host | Guidance entry | Skill discovery | Hooks | Non-interactive check | Conclusion |
| --- | --- | --- | --- | --- | --- |
| Pi | `AGENTS.md` by default; also reads `CLAUDE.md` and `AGENTS.override.md`; `-nc`/`--no-context-files` disables discovery | `.agents/skills/` from the working directory through ancestors to the repository root, plus `~/.agents/skills` | TypeScript extensions in `.pi/extensions/` or `~/.pi/agent/extensions/`; `session_start`, `before_agent_start`, `tool_call` (can block); project-local extensions load only after project trust | `pi -p "..."`; `pi --mode json "..."` writes JSONL events | Covered by `generic`; no `.pi/` assets needed |
| Cursor | `AGENTS.md` in the project root and subdirectories; `.cursor/rules/*.mdc` | `.agents/skills/`, `.cursor/skills/`; also `.claude/skills/` and `.codex/skills/` | `.cursor/hooks.json`; `sessionStart`, `preToolUse`, `postToolUse` and other agent events | `agent -p` / `--print`; `--output-format json` | Covered by `generic`; optional hooks enhancement |
| Cline | `AGENTS.md` (documented as cross-tool) and `~/.agents/AGENTS.md`; `.clinerules/` or `.cline/rules/` | `.cline/skills/`, `.clinerules/skills/`, `.claude/skills/`; `.agents/skills` is not documented | `.clinerules/hooks/<Event>`; `TaskStart`, `PreToolUse` (cancel blocks) and other events | `cline --json "..."` emits one JSON object per line | Covered by `generic`; optional hooks enhancement |
| Amp | `AGENTS.md` from the working directory and parents up to `$HOME`; falls back to `AGENT.md` or `CLAUDE.md` per directory | `.agents/skills/` (project and parents), `.claude/skills/`, `~/.config/agents/skills/` | Bun/TypeScript plugins in `.amp/plugins/` or `~/.config/amp/plugins/`; `session.start`, `agent.start`, `tool.call` | `amp -x "..."` / `--execute` | Covered by `generic`; optional hooks enhancement |
| Gemini CLI | `GEMINI.md` by default; `AGENTS.md` only when `context.fileName` includes it | `.gemini/skills/` or `.agents/skills/` (native alias) | `.gemini/settings.json` top-level `hooks`; `SessionStart` `additionalContext`, `BeforeTool` deny/block | `gemini -p` with `--output-format json` | Needs adapter: guidance entry first, optional hooks |
| Aider | `CONVENTIONS.md` only through `--read` or `.aider.conf.yml` `read:`; no default `AGENTS.md` discovery | No Skill surface documented | No hook surface documented | `aider -m "..." --yes` | Needs guidance-only adapter |
| Continue | Official rules docs list only `.continue/rules/`. PR #7717 (merged 2025-09-22) adds root `AGENTS.md`, with `AGENT.md`/`CLAUDE.md` fallback; current source loads it, the rules docs do not state it | Not confirmed in first-party docs | Not confirmed in first-party docs | Not confirmed | Unknown; spike first |
| Windsurf | The Windsurf `AGENTS.md` page redirects to Devin Desktop Cascade docs, which document `AGENTS.md` for Devin Local and call `.windsurf/rules/*.md` legacy; current Windsurf behavior is unconfirmed | Not confirmed for Windsurf | Not confirmed for Windsurf | Not confirmed | Unknown; spike first |

Sources checked on 2026-11-14:

- Pi: [Skills](https://docs.pi.dev/latest/skills),
  [configuration](https://docs.pi.dev/latest/configuration),
  [extensions](https://docs.pi.dev/latest/extensions) and
  [CLI](https://docs.pi.dev/latest/cli). The `pi.dev/docs/latest/*` paths
  redirect to `docs.pi.dev`.
- Cursor: [rules](https://cursor.com/docs/context/rules),
  [skills](https://cursor.com/docs/context/skills),
  [hooks](https://cursor.com/docs/agent/hooks) and
  [CLI headless mode](https://cursor.com/docs/cli/headless). Current docs use
  the `agent` binary name.
- Cline: [rules](https://docs.cline.bot/customization/cline-rules),
  [skills](https://docs.cline.bot/customization/skills),
  [hooks](https://github.com/cline/cline/blob/main/.clinerules/hooks/README.md)
  and [CLI reference](https://docs.cline.bot/cli/cli-reference).
- Amp: [AGENTS.md](https://ampcode.com/docs/customize/agents-md),
  [skills](https://ampcode.com/docs/customize/skills),
  [plugin API](https://ampcode.com/docs/plugin-api) and
  [execute mode](https://ampcode.com/docs/cli/execute-mode).
- Gemini CLI: [skills](https://geminicli.com/docs/cli/skills/),
  [GEMINI.md](https://geminicli.com/docs/cli/gemini-md/),
  [hooks](https://geminicli.com/docs/hooks/reference/),
  [settings](https://geminicli.com/docs/cli/settings/) and
  [headless mode](https://geminicli.com/docs/cli/headless/).
- Aider: [conventions](https://aider.chat/docs/usage/conventions.html) and
  [scripting](https://aider.chat/docs/scripting.html).
- Continue: [rules](https://docs.continue.dev/customize/deep-dives/rules) and
  [PR #7717](https://github.com/continuedev/continue/pull/7717). Issue #6716
  was closed as completed by that PR, so the earlier request is no longer
  evidence of missing support; the documentation gap remains.
- Windsurf: [AGENTS.md](https://docs.windsurf.com/windsurf/cascade/agents-md)
  redirects to the Devin Desktop Cascade page.

### Follow-up implementation proposals

None of the candidates above changes the support matrix by itself. Proposed
separate implementation Issues:

1. Gemini CLI adapter (priority, #916). Manage the guidance entry only: write a stable
   managed `GEMINI.md`, or record `context.fileName` with `AGENTS.md` without
   overwriting user configuration. Skills need no adapter because
   `.agents/skills/` is native. Optional `SessionStart` context and `BeforeTool`
   hooks only after live qualification, keeping the zero-integration fallback.
2. Aider guidance-only adapter (#917). Manage `.aider.conf.yml` `read:` with
   `AGENTS.md`, or a managed `CONVENTIONS.md` pointer, preserving existing
   keys. No Skill or hook surface exists; verify with
   `aider -m "..." --yes`.
3. Optional hooks enhancement for Cursor, Pi, Cline and Amp. Each documents a
   project hook surface; add context purposes only after a live qualification,
   and never carry business rules in hooks.
4. Research spike for Continue and Windsurf before deciding either way. Verify
   documented guidance, Skill discovery, hooks and non-interactive entry points
   in current releases. For Continue, resolve the gap between the rules
   documentation and merged PR #7717.

Per the host-neutral principle, any adapter lands in setup adapters and the
installation catalog; distributed Skills and guidance text stay host-neutral.

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
