---
"specgit": minor
---

## Agent harness & delivery experience

- `specgit setup` installs 5 entry points per tool (issue, finish, doctor, pr, status) with new skills for doctor/pr/status diagnostics (#164, #165)
- Doctor output now includes actionable fix guidance for each diagnostic code (#166)
- `specgit issue` posts a traceability comment on each bound issue (#160, #161)
- Issue help and skill list all 14 conventional title types (#174)
- Managed AGENTS/CLAUDE block now includes agent contract essentials and draft→ready guidance (#163, #176, #183)

## JSON envelope

- All `--json` envelopes carry a top-level `exit` field matching the process exit code (#167)
- `specgit setup --json` reports `assets` (installed entry points) (#168)

## Behavioral changes

- `specgit status` without a record now exits 0 with `state: "unbound"` instead of exit 3 (#175). Scripts should branch on the `state` field or `gates.record` failure rather than exit code alone.
- GitLab: more than 10 pipelines on the same head SHA causes `finish` to fail-closed with `evidence_truncated` (exit 3) instead of fetching unbounded pages (#187)

## TypeScript API

- `ForgeProvider` is the canonical port name; `GitHubProvider` remains as a deprecated alias (#169)
- `ForgeReadPort` / `ForgeAdminPort` split for capability-scoped consumers (#180)
- `RepoRef.platform` is now a required `'github' | 'gitlab'` union (#186)
- Custom `ForgeProvider` implementations must include `addIssueComment` (#160)
- `CommandOutcome` union types split per command for narrower narrowing (#179)
- Unified kernel `SpawnContract` replaces per-module duplicates (#185)

## Internal quality

- init.ts decomposed into 5 focused sub-modules (849→173 lines orchestrator) (#171)
- ESLint `no-explicit-any` restored to warn, `no-unused-vars` to error (#172)
- Gate identifiers renamed from g1-g9 to semantic names (#173)
- Test doubles renamed to platform-neutral MockForgeProvider (#219)
- Evidence-cast sweep guard + human anti-drift byte locks + init unit tests added (#213, #214, #220)
