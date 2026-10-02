# Supported coding agents

SpecGit 2 provides a native CLI and managed agent integrations. One shared
user-level `specgit` executable serves every repository and worktree.
`specgit setup` writes integration assets only for explicitly selected
agents (`--agent generic|claude|codex|opencode`, repeatable) in an explicit
scope: `--scope global` (the default) writes versioned assets under the
selected user-level setup root, and `--scope project` writes documented
checkout assets with a worktree-private receipt. `specgit init` remains
project-scoped and unchanged; agent integration stays optional and separate.
Written registration is not proof of host import or notification delivery.
Follow the [installation guide](agent-install.md) for the matching host
registration option and verification steps.

## Integration scopes and agents

| Agent | Global scope (default) | Project scope (`--scope project`) |
| --- | --- | --- |
| `generic` | Skill only at `~/.agents/skills/specgit-native/`; no guidance block, no hooks | `.agents/skills/specgit-native/` plus root `AGENTS.md` guidance; no hooks |
| `claude` | Skill beside the settings file plus hook entries in `~/.claude/settings.json` (custom `--claude-settings`) | `.claude/skills/specgit-native/` copy, root `CLAUDE.md` guidance, `.claude/settings.json` hooks |
| `codex` | Skill, managed `AGENTS.md` (or existing nonempty `AGENTS.override.md`) block and `hooks.json` entries under `~/.codex` (`CODEX_HOME` / `--codex-root`) | Root `AGENTS.md` (or existing nonempty `AGENTS.override.md`) guidance plus `.codex/hooks.json` |
| `opencode` | Skill and `AGENTS.md` guidance under `~/.config/opencode` (`XDG_CONFIG_HOME` / `--opencode-root`); no hooks | `.agents` skill and root `AGENTS.md` guidance only; no hooks |

Global scope remains the existing default and can run before any project
exists. Every project agent selection writes the canonical
`.agents/skills/specgit-native/SKILL.md`; Claude additionally receives its native
skill copy. Project scope resolves the Git checkout and the private absolute Git
directory, records its receipt and journal under
`<git_dir>/specgit-v2/agent-assets/`, and therefore integrates each linked
worktree independently. Project scope never installs a runtime binary in the
checkout and never edits global agent settings; Claude and Codex project
hooks invoke the shared verified executable under the global setup root, so
global setup must succeed first and be refreshed after CLI upgrades.
Selection is additive on refresh, a new project integration requires an
explicit `--agent`, and project `--uninstall` (without `--agent`) removes
exactly the recorded project assets of that worktree.

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
automates that trust. OpenCode has no hook registration in this integration;
it receives the skill and guidance only. In every case setup reports
registration as `written_not_verified` with host delivery facts
(`imported_event`, `context_injection`, `visible_message`, `next_turn`) as
`not_checked`; a reload, trust review or later turn may be needed before the
host actually consumes the assets.

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
