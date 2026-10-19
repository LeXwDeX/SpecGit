# Provider Architecture

The Rust library and native CLI separate IssueWrite, RequestWrite and read-only observation. The core, watch and hooks cannot merge, close Issues, delete branches or administer settings. Authorized Agent gh/glab actions are external steps.

Observations are dated native snapshots. GitHub reads bounded workflow-run identities and requires Actions read access. When a workflow has no visible check runs, its own state remains evidence: queued or in-progress is pending, and completed with a successful conclusion can pass. SpecGit does not expand jobs/DAGs or compute merge eligibility.

Issue creation is serialized across linked worktrees sharing one common Git
directory, with its lock in that project's Git metadata. Independent clones do
not share the lock. Project assets, receipts and checkpoints are worktree-local;
linked worktrees may share Git hook directories and their consumer records. Use
linked worktrees for concurrent work on the same WHY. Native search can lag
writes; compare duplicate WHYs and adopt an exact native ID.

[Runtime architecture](https://github.com/LeXwDeX/SpecGit/blob/main/runtime/README.md) and [public contract](https://github.com/LeXwDeX/SpecGit/blob/main/runtime/REFERENCE.md). The v1 TypeScript provider is retired.
