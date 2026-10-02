# CLI Reference

Use `specgit --help` and offline `specgit --schema` for the installed contract, `--json` for machine output and `--input-file` for structured input. Public ZIPs contain only the executable, with its embedded schema.

| Commands | Purpose |
| --- | --- |
| `setup` / `init` | Project agent integration (project-only since 2.4; hooks use the installed executable) / project initialization; preview separately from apply |
| `issue` / `pr` | Select complete specifications / aggregate a native draft; writes require existing authorization |
| `pr --status` / `watch` | Current native facts / bounded observation; neither merges nor closes Issues |
| `status` / `doctor` | Offline local evidence / native capability diagnosis |
| `guard` / `hook` / `inbox` | Local checks, host events and notification receipts |
| `migrate` | Explicit preview/apply for proven owned v1 assets |

Exit codes: 0 operation/read success; 1 failure; 2 invalid input or required choice; 3 necessary facts unknown; 130 cancellation. A successful read can report failed CI.

In 2.2, differing existing PR/MR bodies are preview-only: `pr --update-body --body-file <file> --dry-run`. Review concurrent changes on the native platform, edit there, then refresh `pr --status`. Removing dry-run does not permit unconditional replacement.

[Full commands, configuration and diagnostics](https://github.com/LeXwDeX/SpecGit/blob/main/runtime/REFERENCE.md). v1 `finish`, `accept`, `bind` and `unbind` are retired.
