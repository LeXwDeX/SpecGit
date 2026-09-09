---
name: specgit-native
description: Use SpecGit 2 project conventions when starting issue-based delivery, checking current evidence, or handing off pending native work.
---

Read the initialized project's AGENTS.md and its `.specgit.yaml` declaration.
Use the installed `specgit --help` to discover this runtime's available commands.
A development runtime may expose only the completed stages of the 2.0 migration.

Before a tracked edit, select native issues whose bodies explain Why, Scope,
Approach and Acceptance. Associate every selected issue with the native PR/MR.
Current Git and platform evidence determine acceptance. Report a queue request as
queued; report completion only after observing the requested merge and native
issue states. A non-default target may leave associated issues open.

Hooks provide context within the host's demonstrated delivery capability. A
pending inbox event is unfinished delivery, and a visible message does not prove
that the user read it. Use explicit observation when automatic host delivery is
unavailable. Follow existing user authorization for mutations; generated context
itself grants no permission.

Contract version: {{version}}.
