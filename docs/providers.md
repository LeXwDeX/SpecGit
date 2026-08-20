# Provider Ports and Compatibility Policy

SpecGit derives acceptance from two TypeScript seams, both behind the
product contract that GitHub evidence flows exclusively through the
authenticated `gh` CLI and git facts exclusively from local git
([AGENTS.md](../AGENTS.md), [Reference — the provider
seam](reference.md#github-provider-seam)):

- **`GitPort`** (`src/gitfacts/port.ts`) — local git facts and the
  delivery-bootstrap write operations, implemented for production by
  `LocalGitAdapter` (`src/gitfacts/local.ts`).
- **`GitHubProvider`** (`src/github/port.ts`) — GitHub evidence and
  mutations, implemented for production by `GhCliGitHubProvider`
  (`src/providers/github/gh-cli.ts`, the per-platform adapter home since
  #113; `src/github/gh-cli.ts` remains a stable alias module). The
  [GitLab (glab) roadmap](gitlab-support.md) will implement this port
  shape as a second adapter.

The full port vocabulary is exported from the public API
(`src/index.ts`), including the stable port names `GitPort` and
`GitHubProvider`, their auxiliary types (`GitWritePort`,
`BranchCheckout`, `BranchProtectionFact`, `RepoAutomergeFact`), and the
member inventories `GIT_PORT_MEMBERS` / `GITHUB_PROVIDER_MEMBERS`. This
document is the compatibility policy for how those ports evolve (#80).

## Port inventory

Both inventories live beside their interfaces as
`GIT_PORT_MEMBERS` / `GITHUB_PROVIDER_MEMBERS`, compile-checked with
`satisfies Record<keyof <Port>, true>` so port and inventory cannot
drift apart silently. The contract test
(`test/specgit/provider-port-contract.test.ts`) pins this page's tables
to those lists member-for-member: change a port, change this page.

### GitPort (src/gitfacts/port.ts)

| Member | Kind | Evidence role |
| --- | --- | --- |
| `facts` | required | Read side: repo, toplevel, branch, HEAD sha, dirty state, worktree layout, origin URL, upstream drift, git availability. Feeds the context and drift gates. |
| `headContains` | required | Ancestor-or-equal containment of a full hex object id (40 or 64 hex chars) in local HEAD history; proves merged-delivery lineage (G4). A non-hex anchor (empty, padded, ref-like, abbreviated) fails closed as `merged_lineage_unavailable` without invoking git (#76); containment behavior is unchanged for valid anchors. |
| `checkoutOrCreateBranch` | required | Bootstrap write: check out the delivery branch, creating it from HEAD when absent. |
| `commitFile` | required | Bootstrap write: pathspec-limited commit of one state file; unchanged file is a successful no-op (idempotent bootstrap). |
| `pushBranch` | required | Bootstrap write: push the delivery branch with upstream (`git push -u`). |
| `remoteDefaultBranch` | required | `origin/HEAD` for the PR base; falls back to `main`. |
| `hooksPath` | required | The hooks directory git will actually use (linked-worktree and `core.hooksPath` aware) for guard installation. |

### GitHubProvider (src/github/port.ts)

| Member | Kind | Evidence role |
| --- | --- | --- |
| `preflight` | required | gh present and authenticated (G6). |
| `getIssue` | required | Issue fact: state and `pullRequest` classification for every bound issue. |
| `getOpenIssueNumbers` | required | Open-issue numbers for the ordered-issues sequencing gate, derived from the complete `getOpenIssues` scan. |
| `getOpenIssues` | required | Title-carrying open-issue facts for the bootstrap adoption probe (#77): one paginated scan (complete to exhaustion, #120 I3b) replaces the per-issue lookup fan-out, so probe cost is bounded by pages. Same-title collisions are disambiguated by the scaffold body, never silently adopted (`issue_title_ambiguous`). |
| `getPr` | required | PR fact: state, head/base, body, `mergeCommitSha`. |
| `getCheckRuns` | required | Check runs at the head sha (G6 evidence sufficiency). |
| `createIssue` | required | Bootstrap create for new WHYs. |
| `createDraftPr` | required | Bootstrap draft PR that closes every bound issue. |
| `listOpenPrsByHead` | required | Remotely discoverable idempotency marker for PR repair (`specgit pr`). |
| `getBranchProtection` | required | Protection state and required checks for the guarded-merge story. |
| `enableBranchProtection` | required | Turn on the required-check gate on the base branch. |
| `getRepoAutomerge` | required | Repository auto-merge setting. |
| `enableRepoAutomerge` | required | Turn on repository auto-merge. |

Every port member is **required** today. There are no optional port
members: each method feeds a gate or bootstrap decision that cannot
proceed without an answer, and each returns an `Evidence` envelope so a
runtime failure is classified evidence that fails closed — never a
silent skip.

## Required-versus-optional rules

1. **A member is required only when a gate or command decision reads
   it.** Adding a member "for later" is prohibited; the port carries the
   surface acceptance actually consumes.
2. **Adding a required member is compile-breaking by design.** It lands
   only in a delivery that updates, in the same push: the port, every
   in-tree implementation (next section), both member inventories, and
   this page's table. `pnpm exec tsc --noEmit` going red at every
   implementer is the guard, not an accident.
3. **Optional members exist only on evidence facts, never on the port
   methods.** An optional member is admissible only when behavior
   degrades explicitly and the fallback is written here before the
   member ships (next section).

## Optional evidence members and their fallbacks

| Member | Fallback when absent |
| --- | --- |
| `IssueFact.title` (optional) | Informational only — gates read state and `pullRequest`; adoption matches titles on `OpenIssueFact` (via `getOpenIssues`), not here. |
| `OpenIssueFact.title` (optional) | The issue is excluded from title-match adoption: `specgit issue` cannot adopt a previously created but unrecorded issue by exact open-title match and creates a new issue instead (`src/cli/commands/issue.ts`). Numeric reuse and record-based resume are unaffected. |
| `OpenIssueFact.body` (optional) | The issue cannot win same-title scaffold disambiguation (#77): if a title collision has no sole scaffold-body match, adoption refuses with the `issue_title_ambiguous` usage diagnostic (exit 2) instead of binding an issue that could be unrelated. |

Required-but-nullable is a different, already-covered case:
`PrFact.mergeCommitSha` is required `string \| null`; `null` (GitHub
reports no value) routes the merged-lineage gate to fail-closed
`merged_lineage_unavailable`, never to an inferred verdict.

## Deprecation path

1. **Mark.** The member gets a `@deprecated` JSDoc tag naming the
   replacement, and its inventory row here is marked *deprecated →
   `<replacement>`*.
2. **One release of overlap.** The member keeps working unchanged
   through at least the next release; every implementation and test
   double keeps implementing it.
3. **Remove.** One delivery removes the member from the port, every
   in-tree implementation, both inventories, and this page together —
   the same single-push rule as adding a required member. A removal
   inside an rc stabilization wave additionally needs a red-line note
   in [docs/release-gates.md](release-gates.md).

## Tracking obligations

- **In-tree implementations today:** `GhCliGitHubProvider`
  (`src/providers/github/gh-cli.ts`), `GlabProvider`
  (`src/providers/gitlab/glab-cli.ts`, #114 — the glab mirror),
  `PlatformRoutingProvider` (`src/providers/routing.ts`, #117 — the
  production composition's single provider, dispatching per call to the
  gh or glab adapter on the ref's platform marker), `LocalGitAdapter`
  (`src/gitfacts/local.ts`), `MockGitHubProvider`
  (`test/specgit/helpers/mock-github.ts`), and the recording doubles
  `makeGhProvider` / `makeGitPort`
  (`test/specgit-cli/helpers.ts`). The contract test holds all of them
  to the port shape at every run — the canonical adapter home and its
  legacy `src/github` alias modules are pinned to the same class by the
  same test (#113), and the shared CLI transport both adapters spawn
  through lives at `src/providers/cli-spawn.ts` (#114).
- **Alternate providers (glab).** Landed (#114):
  `GlabProvider` satisfies `GITHUB_PROVIDER_MEMBERS`, extends the
  contract test as an in-tree implementer, and mirrors the gh adapter's
  failure taxonomy per platform (`glab_missing`, `glab_unauthenticated`,
  `glab_transport` — timeout included — plus `gitlab_version_unsupported`
  for the self-managed version window). The glab method map stays
  anchored cell-for-cell to this inventory and the
  [GitLab evidence ledger](evidence/gitlab-19.2.md) (row 24, all cells
  pinned). Routed since #117: the production context evaluates GitLab
  declarations through `PlatformRoutingProvider` → `GlabProvider` (the
  GitHub-only route guard `requireGithubRoute` retired with it — the
  invariant "no gh call ever sees a group/subgroup ref" now lives in the
  router's dispatch, pinned by `test/specgit/routing-provider.test.ts`).
- **Test doubles.** Every new double declares the port type
  (`implements` or a typed literal) so drift is a compile error, and is
  added to the contract test's implementer list in the same delivery.

## Proof protocol (the deliberate red)

The contract is demonstrable, not aspirational: a delivery touching a
port may temporarily add a probe member (for example
`__contractProbe(): boolean`) to the port and run the gates —
`pnpm exec tsc --noEmit` must go red at every in-tree implementation and
both inventory checks, and `pnpm test` must go red naming every test
double — then revert and land green. The recorded run belongs in the
delivery's PR evidence.
