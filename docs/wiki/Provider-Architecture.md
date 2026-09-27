# Provider Architecture

The Rust library and native CLI separate IssueWrite, RequestWrite and read-only observation. The core, watch and hooks cannot merge, close Issues, delete branches or administer settings. Authorized Agent gh/glab actions are external steps.

All observations are dated native snapshots. GitHub observation in 2.2 reads bounded workflow-run identities and requires Actions read access. Independent same-named suites remain separate; a replacement run without visible checks stays unknown. It does not expand jobs/DAGs or compute merge eligibility.

Issue creation serialization covers one OS user, host and shared data root. Other hosts and native search-index lag can still yield duplicates; compare WHYs and adopt an exact native ID.

[Runtime architecture](https://github.com/LeXwDeX/SpecGit/blob/main/runtime/README.md) and [public contract](https://github.com/LeXwDeX/SpecGit/blob/main/runtime/REFERENCE.md). The v1 TypeScript provider is retired.
