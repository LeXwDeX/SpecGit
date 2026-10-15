# Core Concepts

One Issue represents one independently verifiable WHY with Why, Scope, Approach and Acceptance. Multiple Issues can share a native PR/MR while retaining exact native IDs and closing references.

`.specgit.yaml` records local preferences. A checkpoint under Git stores the current branch/worktree selection and recovery intent; it is neither a v1 authoritative binding nor remote completion evidence. Switching branches does not reset it. Use a separate worktree for independent work.

Pending, failed, unknown, merged and completed are separate states. The forge owns protection. Declarations, previews and notices alone do not expand task scope. Installation/enablement delegates the current task workflow without repeated step approvals. Read-only audits and ordinary edits need no checkpoint; select complete Issues before commit/push. Use a Milestone for larger goals and split Issues by outcome and dependency. TDD and PR CI follow-up are recommended; project/platform-required checks remain required.

[Full glossary](https://github.com/LeXwDeX/SpecGit/blob/main/CONTEXT.md).
