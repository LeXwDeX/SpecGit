# Supported coding agents

SpecGit 2 provides a native CLI and managed agent integrations. `specgit setup`
supports Codex, Claude Code, and OpenCode; other agents can use the CLI and the
project guidance directly. Follow the [installation guide](agent-install.md) for
the matching host registration option and verification steps.

Use the installed executable's `specgit --help` and `specgit --schema` as the
command contract. The maintained command, configuration, and JSON reference is
the [native runtime reference](../runtime/REFERENCE.md). The installed
[SpecGit skill](../runtime/assets/SKILL.md) describes the agent workflow.

## Delivery flow

Read-only inspection and `--dry-run` previews do not authorize writes. Select
complete relevant Issues before tracked product edits, then implement, verify,
commit, and push the actual changes. Create or adopt a draft PR/MR with
`specgit pr`, preserving every closing reference.

When review preparation is complete, `specgit pr --ready --request <id>` marks
the request ready within existing user authorization. Review and merge happen
on GitHub or GitLab; `specgit watch` only observes current evidence. After the
platform reports a merge, use `specgit pr --status --request <id>` to read back
the native request and associated Issue state. Exit zero means that operation
succeeded; it does not by itself prove merge or completed delivery.

For v1 projects, use the [v1 to v2 migration guide](migration-v2.md). The old
`finish`, `accept`, `bind`, and `unbind` commands belong to SpecGit v1 and are
not commands in the native v2 CLI.
