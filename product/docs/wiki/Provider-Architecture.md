# Provider Architecture

SpecGit separates local git facts from forge evidence and authorized mutations.
The design keeps acceptance independent of the commands that change delivery state.

| Boundary | Responsibility |
| --- | --- |
| Local Git | Repository identity, branch/worktree, commits, refs, and ancestry |
| Forge evidence | Issues, PRs/MRs, checks, and platform facts needed for a verdict |
| Delivery operations | Issue/request creation, binding, merge, and issue closure |
| Repository administration | Explicitly authorized protection and integration setup |

GitHub evidence and operations flow through `gh`; declared GitLab hosts use
`glab`. Authentication comes from the user's CLI session, without SpecGit token
storage. A platform name alone is not evidence of a valid repository or capability.

## Evidence discipline

The evaluator consumes facts rather than a saved "done" flag. Proven negative
facts can reject acceptance; missing authentication, transport errors, malformed
responses, or incomplete pagination make evidence unavailable. Providers must
preserve their platform's semantics rather than invent equivalent-looking green
checks.

Merge automation has a separate authority boundary. It verifies the approved
target and current request head, collects fresh acceptance and CI evidence, and
submits the expected head when merging. Issue closure starts after confirmed
merge; incomplete closure remains recoverable.

## Detailed interfaces

Interface member inventories, adapter implementation details, and compatibility
rules live in the [provider reference](https://github.com/LeXwDeX/SpecGit/blob/main/docs/providers.md).
Keeping those details in one reference avoids a second stale interface list in
the Wiki. See [GitLab Support](GitLab-Support) for platform setup and limits.

[Concepts](Concepts) · [中文](Provider-Architecture-zh)
