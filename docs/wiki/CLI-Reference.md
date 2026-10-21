# CLI Reference

Use the shared native CLI's `specgit --help` and offline `specgit --schema` as the installed contract, `--json` for machine output and `--input-file` for structured input. Signed GitHub Release ZIPs contain the executable and its embedded schema.

| Commands | Purpose |
| --- | --- |
| `init` | Initialize or inspect one project's declaration and local guidance; installs the native Git guard on a new project, not host hooks |
| `setup` | Install/refresh the project Skill and guidance baseline; a new `--agent` adds guidance only, and hooks need explicit `--hook-purpose guard` and/or `--hook-purpose context` |
| `update` | Check, verify or apply a signed GitHub Release to the shared executable |
| `issue` / `pr` | Select complete specifications / aggregate a native draft; writes require existing authorization |
| `pr --status` / `watch` | Current native facts / bounded observation; neither merges nor closes Issues |
| `status` / `doctor` | Offline local evidence / native capability diagnosis |
| `guard` / `hook` / `inbox` | Local checks, host events and notification receipts |
| `migrate` | Explicit preview/apply for proven owned v1 assets |

Exit codes: 0 operation/read success; 1 failure; 2 invalid input or required choice; 3 necessary facts unknown; 130 cancellation. A successful read can report failed CI.

Existing PR/MR body differences are preview-only: `pr --update-body --body-file <file> --dry-run`. Review concurrent changes on the native platform, edit there, then refresh `pr --status`. Removing dry-run does not permit unconditional replacement.

Setup is project-only and adds no Agent hooks by default. Explicit hook purposes apply to hosts named with `--agent`, or all recorded hosts when `--agent` is omitted; omitting purposes preserves existing choices, and `none` adds no hooks. `observe` is recognized but declined. Only SessionStart and PreToolUse context hooks are supported; use bounded `watch`/`inbox` instead of retired automatic observation callbacks.

[Full commands, configuration and diagnostics](https://github.com/LeXwDeX/SpecGit/blob/main/runtime/REFERENCE.md). v1 `finish`, `accept`, `bind` and `unbind` are retired.
