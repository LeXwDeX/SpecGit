# Supported Hosts

SpecGit capability lands in the shared CLI and the native Git guard first, so a
project works with zero host integration. Host hooks only supply prompts and
context; they never carry business rules. Each adaptation declares its support
status and fallback in `specgit setup --catalog --json`. The maintained details
and discovery boundaries are in
[supported coding agents](https://github.com/LeXwDeX/SpecGit/blob/main/docs/supported-tools.md#support-matrix).

## Support matrix

| Host | Guidance entry | Skill discovery | Context hooks | Read-only allowlist | Fallback |
| --- | --- | --- | --- | --- | --- |
| `generic` | `AGENTS.md` | `.agents/skills/specgit-native/SKILL.md` when the host reads `.agents` | none; declined | declined: no host permission configuration | Read guidance and the Skill directly |
| Claude Code | `CLAUDE.md` | Canonical `.agents` Skill plus `.claude/skills/specgit-native/SKILL.md` | `.claude/settings.json` SessionStart/PreToolUse | `.claude/settings.json` `permissions.allow` with `--readonly-permissions` | Re-read guidance and Skill |
| Codex | `AGENTS.md`, or an existing nonempty `AGENTS.override.md` | Canonical `.agents` Skill; Codex scans it from the working directory to the repository root and also reads `~/.agents/skills` | `.codex/hooks.json`; requires the host `/hooks` trust review | declined: experimental approval and sandbox | Re-read guidance and Skill |
| OpenCode (official) | `AGENTS.md` | `.agents` Skill; the host also reads project `.opencode/` and `.claude/` skills | none; declined | declined: default-allow, no portable allowlist | Re-read guidance and Skill; bounded `watch`/`inbox` |
| OpenCode custom fork | `AGENTS.md` | Same as official OpenCode | `.opencode/hooks.json` with `inputFormat: claude-code`; requires `--agent opencode --opencode-claude-hooks` plus an explicit hook purpose | declined | Same as official OpenCode |

`guard` is the native Git pre-commit/pre-push check, not a host callback. It
applies to every host, including generic, through `setup --hook-purpose guard`
or `specgit guard --install`. Context hooks are optional; they only prompt and
provide context, and never carry business rules.

## Quick start

Initialize the project first (`specgit init`), then inspect the offline catalog
and preview the host selection:

```sh
specgit setup --catalog --json
```

The commands below show the preview and apply pair for each host. Naming a new
host with `--agent` adds its guidance and Skill only; hooks and managed read-only
permissions are separate explicit choices.

### Generic

```sh
specgit setup --agent generic --dry-run --json
specgit setup --agent generic --json
```

The root `AGENTS.md` entry and the canonical
`.agents/skills/specgit-native/SKILL.md` are installed. Generic hosts have no
verified context callback: `--hook-purpose context` is reported as declined. The
native Git guard still applies on commit/push; install it with
`specgit setup --agent generic --hook-purpose guard` or
`specgit guard --install`. Fallback: read the guidance and Skill directly; the
CLI and guard remain available without host callbacks.

### Claude Code

```sh
specgit setup --agent claude --dry-run --json
specgit setup --agent claude --json
specgit setup --agent claude --hook-purpose context --dry-run --json
specgit setup --agent claude --hook-purpose context --json
specgit setup --agent claude --readonly-permissions --dry-run --json
specgit setup --agent claude --readonly-permissions --json
```

Claude Code gets the root `CLAUDE.md` entry, the canonical `.agents` Skill and a
`.claude/skills/specgit-native/SKILL.md` copy for host discovery. Context hooks
use `.claude/settings.json`. The optional managed allowlist appends fixed
`Bash(specgit <argv> *)` rules to `permissions.allow` and preserves user rules
and their order. It reduces prompts; it is not a sandbox or an authorization
boundary. Write commands still prompt, `pr --status`, `doctor`, `watch`, `inbox`,
`migrate` and `remove --apply` stay outside the allowlist, and written rules do
not prove that the host loaded them. Fallback: re-read `CLAUDE.md` and the Skill
directly if hooks are unavailable; the CLI and guard remain.

### Codex

```sh
specgit setup --agent codex --hook-purpose context --dry-run --json
specgit setup --agent codex --hook-purpose context --json
```

Codex gets the canonical `.agents` Skill and a guidance entry in `AGENTS.md`, or
in an existing nonempty `AGENTS.override.md`. Context hooks are written to
`.codex/hooks.json`; the project `.codex/` layer must be trusted in the host's
`/hooks` review, and setup reports `codex_trust: review_in_host_required`.
Registration is reported as `written_not_verified` until the host actually
imports it. Fallback: if the hooks cannot be trusted or are unavailable, re-read
the guidance and Skill directly; the Git guard is independent.

### OpenCode

```sh
specgit setup --agent opencode --dry-run --json
specgit setup --agent opencode --json
# Custom fork only:
specgit setup --agent opencode --opencode-claude-hooks --hook-purpose context --dry-run --json
specgit setup --agent opencode --opencode-claude-hooks --hook-purpose context --json
```

The official build receives the root `AGENTS.md` entry and the `.agents` Skill;
context hooks are declined. A custom fork that supports Claude-compatible command
hooks can opt in with `--opencode-claude-hooks` (requires `--agent opencode`) and
gets `.opencode/hooks.json` with `inputFormat: claude-code`. Qualification is
specific to the installed build. No read-only allowlist is supported. Fallback:
re-read the guidance and Skill directly and use bounded `watch`/`inbox`; the Git
guard remains independent.

## Refresh, removal and verification

Ordinary refresh keeps recorded choices; omit purposes to preserve them:

```sh
specgit setup --dry-run --json
specgit setup --json
specgit setup --agent claude --remove-hook-purpose context --dry-run --json
specgit setup --agent claude --remove-hook-purpose context --json
specgit setup --agent claude --remove-readonly-permissions --dry-run --json
specgit setup --agent claude --remove-readonly-permissions --json
specgit setup --uninstall --dry-run --json
specgit setup --uninstall --json
```

The permission removal commands apply only to a recorded Claude registration;
OpenCode, Codex and generic keep per-invocation approval.

Verify each layer separately: written files do not prove host import, import does
not prove context delivery, and neither replaces the native Git guard. Check the
real host for context and prompt behavior, and check real Git operations for the
guard. See [CLI Reference](CLI-Reference), [Getting Started](Getting-Started),
and [Upgrading Existing Projects](Upgrading-Existing-Projects) for the surrounding
workflow.