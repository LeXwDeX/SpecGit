---
"specgit": patch
---

### Provider port-compatibility contract committed: policy, inventories, contract tests, full port vocabulary

Keeps the provider ports compatible as the seams evolve (#80). The two TS
seams behind the provider contract — `GitPort` (`src/gitfacts/port.ts`) and
`GitHubProvider` (`src/github/port.ts`) — now carry a written compatibility
policy (`docs/providers.md`): required-versus-optional member rules (ports
have only required members; optional members exist only on evidence facts
and must define their fallback — `IssueFact.title`'s adoption fallback is
pinned), a three-step deprecation path, and tracking obligations for the
future glab adapter and every test double.

- **Member inventories live beside the ports** (`GIT_PORT_MEMBERS`,
  `GITHUB_PROVIDER_MEMBERS`) and are compile-checked with
  `satisfies Record<keyof <Port>, true>`: port and inventory cannot drift
  in either direction under `tsc`.
- **Contract tests** (`test/specgit/provider-port-contract.test.ts`) hold
  every in-tree implementation to the same port shape —
  `GhCliGitHubProvider`, `LocalGitAdapter`, `MockGitHubProvider`,
  `makeGhProvider`, `makeGitPort` — one assertion per implementer for full
  red attribution, plus a doc-sync test pinning `docs/providers.md`'s
  inventory tables to the exported lists member-for-member.
- **Deliberate proof (recorded in PR #129)**: temporarily adding the
  required member `__contractProbe()` to both ports went red everywhere it
  must — `tsc` at every src implementer and both inventory checks (6
  errors); after propagating the probe into the inventories, the contract
  test went red naming all five implementers plus its own fixture and the
  doc-sync (7/9). Reverted; all green.
- **Real drift found and fixed on first run**: `makeGhProvider`
  (`test/specgit-cli/helpers.ts`) was missing `getOpenIssueNumbers` —
  invisible until now because no gate typechecks `test/`. The double now
  implements it (scriptable via `openIssueNumbers`, default `ok([])`,
  matching `MockGitHubProvider`).
- **Export completion**: the public API (`src/index.ts`) now carries the
  full port vocabulary — the stable port names `GitPort`/`GitHubProvider`
  plus `GitWritePort`, `BranchCheckout`, `BranchProtectionFact`,
  `RepoAutomergeFact`, and both member inventories — so an alternate
  provider can be written against the public API alone.
