# Provider Ports and Compatibility Policy

SpecGit derives acceptance from two TypeScript seams, both behind the
product contract that forge evidence flows exclusively through the
authenticated platform CLIs — `gh` on GitHub origins, `glab` on an explicitly
declared GitLab origin (including GitLab.com) — and git facts exclusively from local git
([AGENTS.md](../AGENTS.md), [Reference — the provider
seam](reference.md#forge-provider-seam)):

```text
  specgit init / setup      initialize once; rerun after upgrades
        |                   harness + agent entry points
        v
  specgit issue "..."       per delivery: issues + branch +
        |                   draft PR/MR (Closes #n) + record,
        |                   committed and pushed (idempotent resume)
        v
  work, commit, push -----> CI/CD on the request head
        |                   (the platform acceptance job runs
        |                    specgit finish --json)
        v
  mark PR/MR ready          a draft request always fails the verdict
        |
        v
  specgit finish            the verdict: eleven gates, fail-closed
        |-- exit 0 --> accepted → merge → confirmed issue closure: completed
        |-- exit 1 --> fix what the gates named (evidence complete)
        '-- exit 3 --> follow errors[].fix; use doctor for its probes
```

- **`GitPort`** (`src/gitfacts/port.ts`) — local git facts and the
  delivery-bootstrap write operations, implemented for production by
  `LocalGitAdapter` (`src/gitfacts/local.ts`).
- **`ForgeProvider`** (`src/github/port.ts`) — platform-neutral forge
  evidence and mutations (#169; the pre-#169 name `GitHubProvider` stays
  importable as a compatibility type alias). Since #412, callers select
  from three capabilities: `ForgeEvidencePort` for reads,
  `ForgeDeliveryWritePort` for delivery mutations, and `ForgeAdminWritePort`
  for repository configuration mutations. The full provider is implemented for
  production by `GhCliGitHubProvider`
  (`src/providers/github/gh-cli.ts`, the per-platform adapter home since
  #113; `src/github/gh-cli.ts` remains a deprecated alias module) and by
  `GlabProvider` (`src/providers/gitlab/glab-cli.ts`, #114 — the
  [GitLab (glab) adapter](gitlab-support.md)).

The full port vocabulary is exported from the public API
(`src/index.ts`), including the stable port names `GitPort` and
`ForgeProvider` plus the three #412 capabilities. The two #180 surfaces
`ForgeReadPort` / `ForgeAdminPort` remain exported as deprecated compatibility
compositions with exactly their original members (the pre-#169 name
`GitHubProvider` stays exported as a
`@deprecated` compatibility alias), their auxiliary types (`GitWritePort`,
`BranchCheckout`, `BranchProtectionFact`, `RepoAutomergeFact`), and the
member inventories `GIT_PORT_MEMBERS` / `FORGE_PROVIDER_MEMBERS` with the
surface inventories `FORGE_READ_PORT_MEMBERS` / `FORGE_ADMIN_PORT_MEMBERS`
(`GITHUB_PROVIDER_MEMBERS` remains as the deprecated alias of
`FORGE_PROVIDER_MEMBERS`).
This document is the compatibility policy for how those ports evolve (#80).

Initialization resolves that routing decision before it mutates the repository.
Only `github.com` selects the GitHub adapter automatically. A non-GitHub
endpoint may be explicitly declared, or confirmed interactively, only as
GitLab; GitHub Enterprise has no v1 route. Missing/invalid platform evidence
fails closed. Persisting a new GitLab declaration is also an evidence boundary:
`providers_write_failed` exits `3`, restores the exact pre-run provider state,
and prevents later policy or harness writes.

## Selecting capabilities

| Capability | Members and effect |
| --- | --- |
| `ForgeEvidencePort` | All forge reads, including `getBranchProtection`, `getRepoAutomerge` and `listRepoLabels`. No mutation methods. |
| `ForgeDeliveryWritePort` | `mergePr`, `closeIssue`, `createIssue`, `createDraftPr`, `addIssueComment` and `addIssueLabels`. |
| `ForgeAdminWritePort` | `enableBranchProtection`, `enableRepoAutomerge` and `ensureRepoLabels`. |

Callers use `Pick` to request only the members their decision consumes.
`EvaluateInput.gh` selects its seven evidence methods from `ForgeEvidencePort`.
The repair-issue flow combines just six methods: `getPr`, `getOpenIssues`,
`createIssue`, `addIssueLabels`, `addIssueComment` and `ensureRepoLabels`.
Its caller can supply those methods without implementing merge, protection
or auto-merge configuration. These type boundaries do not grant runtime
authorization; every platform operation still uses authenticated `gh` or
`glab` and returns the same fail-closed `Evidence` contract.

The deprecated `ForgeReadPort` retains delivery reads and writes;
`ForgeAdminPort` retains the three administration reads and three writes.
Their frozen inventories retain the original members and order, and
`GITHUB_PROVIDER_MEMBERS` remains the same object as `FORGE_PROVIDER_MEMBERS`.
No member or method signature was removed by the capability split.

## Port inventory

Both inventories live beside their interfaces as
`GIT_PORT_MEMBERS` / `FORGE_PROVIDER_MEMBERS`, compile-checked with
`satisfies Record<keyof <Port>, true>` so port and inventory cannot
drift apart silently. The contract test
(`test/specgit/provider-port-contract.test.ts`) pins this page's tables
to those lists member-for-member: change a port, change this page.

### GitPort (src/gitfacts/port.ts)

| Member | Kind | Evidence role |
| --- | --- | --- |
| `facts` | required | Read side: repo, toplevel, branch, HEAD sha, dirty state, worktree layout, origin URL, upstream drift, git availability. Feeds the context and drift gates. |
| `headContains` | required | Ancestor-or-equal containment of a full hex object id (40 or 64 hex chars) in local HEAD history; proves merged-delivery lineage (G4). A non-hex anchor (empty, padded, ref-like, abbreviated) fails closed as `merged_lineage_unavailable` without invoking git (#76); containment behavior is unchanged for valid anchors. |
| `readFileAtRemoteRef` | required | Resolve the current remote branch SHA, then read its file from local Git objects. Proven absence is distinct from unavailable objects; this read never fetches or changes refs. Supplies approved target policy. |
| `readFileBeforeMerge` | required | Recover the pre-merge policy only from a locally contained two-parent merge whose second parent is the proven PR head. Ambiguous squash/rebase/fast-forward history remains unknown. |
| `trackedFiles` | required | Which of the given repo-relative paths the index tracks (`git ls-files --`); read-only intersection. Feeds the merged-delivery lifecycle warnings (#298): a tracked record/policy that gets deleted or rewritten warns instead of leaving silent working-tree residue. Fails closed as `tracked_probe_failed`; callers treat a failed probe as advisory. |
| `checkoutOrCreateBranch` | required | Bootstrap write: check out the delivery branch, creating it from HEAD when absent. |
| `commitFile` | required | Bootstrap write: force-staged (`git add -f`), pathspec-limited commit of the authoritative delivery files (#292 — past the tool-installed local-asset ignore); unchanged paths are a successful no-op (idempotent bootstrap). |
| `pushBranch` | required | Bootstrap write: push the delivery branch with upstream (`git push -u`). |
| `remoteDefaultBranch` | required | Read the remote default branch. Callers may request strict evidence; initialization always does so before workflow generation or protection and exits `3` when `origin/HEAD` cannot prove the branch. It never guesses `main`, and an automation merge target is not a substitute for the trusted default-branch identity. |
| `hooksPath` | required | The hooks directory git will actually use (linked-worktree and `core.hooksPath` aware) for guard installation. |

### ForgeReadPort (src/github/port.ts)

Deprecated compatibility composition → select `ForgeEvidencePort` and
`ForgeDeliveryWritePort` members for new callers. Its inventory is preserved.

| Member | Kind | Evidence role |
| --- | --- | --- |
| `preflight` | required | Matching platform CLI present and authenticated (G6): `gh` for GitHub or `glab` for declared GitLab. |
| `getCiConfigPath` | required | Configured platform CI entry path, or null for the platform default. GitHub has its fixed workflow discovery convention; GitLab reads and validates the project's configured entry path before installing an automation wrapper. |
| `getIssue` | required | Issue fact: state and `pullRequest` classification, plus real title, body and label evidence for enabled project rules. |
| `getOpenIssueNumbers` | required | Open-issue numbers for the ordered-issues sequencing gate, derived from the complete `getOpenIssues` scan. |
| `getOpenIssues` | required | Title-carrying open-issue facts for the bootstrap adoption probe (#77): one paginated scan (complete to exhaustion, #120 I3b) replaces the per-issue lookup fan-out, so probe cost is bounded by pages. Same-title collisions are disambiguated by the scaffold body, never silently adopted (`issue_title_ambiguous`). |
| `searchIssueHistory` | required | Paginated relevant open and closed issue facts for history review; incomplete coverage fails closed. Similarity is advisory, never semantic proof of the same WHY. |
| `listIssuePullRequests` | required | Related PR/MR facts refreshed from the platform; scoped closing references establish active issue occupancy. |
| `getPr` | required | PR fact: state, head/base, body, `mergeCommitSha`, plus real title evidence for enabled project rules. |
| `getCheckRuns` | required | Check runs at the head SHA, with optional PR/MR number. Acceptance supplies the number; GitLab verifies the MR head pipeline and its SHA before reading jobs. Omitting the number retains commit-scoped library lookup. |
| `getPrChecks` | required | Complete CI/CD evidence tied to the current PR/MR head for automation. GitHub includes check runs, classic statuses and workflow runs (including approval waits with no jobs); GitLab includes authoritative pipeline status, jobs and downstream pipelines. Superseded attempts cannot replace current evidence. When multiple GitHub attempts share an identity and their start times cannot be ordered, the adapter returns unknown evidence rather than choosing an older green result. |
| `mergePr` | required | Merge with a server-enforced expected head SHA and report whether the platform confirmed merging. Never bypasses protection or closes an unmerged request as a substitute. |
| `closeIssue` | required | Idempotently close a bound issue and confirm its remote state; already closed issues need no write. The command calls it only after confirmed merge and successful CI/CD. |
| `getEvidenceAnchor` | required | Check-freshness anchor (#315): the platform instant the delivery last became reviewable. `anchoredAt: null` is a legal answer (no boundary set — e.g. glab); a failed envelope fails closed. |
| `createIssue` | required | Bootstrap create for new WHYs. |
| `createDraftPr` | required | Bootstrap draft PR/MR containing a closing reference for every bound issue. |
| `listOpenPrsByHead` | required | Remotely discoverable idempotency marker for PR repair (`specgit pr`). |
| `addIssueComment` | required | Ensure an exact-body traceability comment exists. Complete remote evidence reconciles retries before posting and returns the existing URL. Read failures and truncation fail closed; independent concurrent writers are not serialized. |
| `addIssueLabels` | required | Tag apply (#330): union-semantics label addition for every bound issue after the selection resolves. Idempotent; the response must confirm every requested slug or the call fails closed. |

### ForgeAdminPort (src/github/port.ts)

Deprecated compatibility composition → select `ForgeEvidencePort` and
`ForgeAdminWritePort` members for new callers. Its inventory is preserved.

| Member | Kind | Evidence role |
| --- | --- | --- |
| `getBranchProtection` | required | Protected-branch evidence. GitHub also returns its required status checks; GitLab returns the policy-job intersection as pipeline evidence, never as a GitHub protection primitive. |
| `enableBranchProtection` | required | Enable the provider-selected protected-merge gate while preserving existing settings: add the acceptance check on GitHub, or protect the branch and keep successful pipelines required on GitLab. Confirm the server response. |
| `getRepoAutomerge` | required | Compatibility-shaped capability fact: GitHub repository auto-merge, or GitLab's project-wide `only_allow_merge_if_pipeline_succeeds` gate. |
| `enableRepoAutomerge` | required | Enable that platform capability: repository auto-merge on GitHub, or required successful pipelines on GitLab. |
| `listRepoLabels` | required | The repository's label pool (#330), the universe the tag selection runs against. Paginated to exhaustion (#120 I3b); truncation fails closed. |
| `ensureRepoLabels` | required | Idempotent seed (#330): create declared-but-missing tag specs, confirm every requested slug (created or already present); an unconfirmed slug fails closed. GitLab CE labels need a Planner-or-above role since 17.7 — permission failures are evidence, not verdict inputs. |

### ForgeProvider (src/github/port.ts)

`ForgeProvider` retains the composition `ForgeReadPort & ForgeAdminPort`
(#180), structurally equivalent to
`ForgeEvidencePort & ForgeDeliveryWritePort & ForgeAdminWritePort` (#412). Every full in-tree adapter implements the
composed port, and every member is **required**. There are no
optional port members: each method feeds a gate or bootstrap decision
that cannot proceed without an answer, and each returns an `Evidence`
envelope so a runtime failure is classified evidence that fails closed —
never a silent skip. Narrow callers can accept a selection of capabilities;
both shipped platform adapters (gh and glab) retain the full public shape.

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
| `IssueFact.title` (optional) | With `validation.titles` enabled, absence or an empty value gives `title_evidence_missing` (exit 3). Title-based resume also needs a current nonempty title; without it resume is unknown. Numeric/no-argument resume can avoid the identity comparison, but cannot bypass enabled title validation. Otherwise no title-language gate runs. |
| `IssueFact.labels` (optional) | With `validation.labels` enabled, absence gives `issue_labels_unavailable` (exit 3). An empty array is complete evidence of no labels and rejects the enabled rule. With validation off, the field adds no acceptance requirement. |
| `IssueFact.body` (optional) | With `validation.bodies` or issue-template `required_sections` enabled, absence gives `body_evidence_missing` (exit 3). An empty or incomplete body is gathered evidence and rejects the enabled rule. Otherwise no issue-body gate runs. |
| `PrFact.title` (optional) | With `validation.titles` enabled, absence or an empty value gives `title_evidence_missing` (exit 3); otherwise it adds no acceptance requirement. |
| `OpenIssueFact.title` (optional) | The issue is excluded from title-match adoption: `specgit issue` cannot adopt a previously created but unrecorded issue by exact open-title match and creates a new issue instead (`src/cli/commands/issue.ts`). Numeric reuse and record-based resume are unaffected. |
| `OpenIssueFact.body` (optional) | The issue cannot win same-title scaffold disambiguation (#77): if a title collision has no sole scaffold-body match, adoption refuses with the `issue_title_ambiguous` usage diagnostic (exit 2) instead of binding an issue that could be unrelated. |
| `CheckRunInfo.source` (optional) | Acceptance retains its check-name truth-attempt selection. GitHub automation requires an app identity for check runs and returns unknown evidence if it is absent; classic statuses, workflow runs and GitLab jobs use their own adapter-local identities without this field. |
| `CheckRunInfo.allowFailure` (optional) | Absence is false: a failed required check rejects acceptance. GitLab acceptance honors an explicit true for failure only; merge automation still rejects every executed failure regardless of this field. |
| `MergeChecksFact.pipelineStatus` (optional) | GitHub has no overall pipeline state and relies on its complete check/status/workflow evidence. On GitLab, absence blocks automation with `automation_pipeline_unavailable` (exit 3); a successful pipeline state is required in addition to successful executed checks. |

The production `gh` and `glab` adapters collect titles and complete issue-label
sets from the real issue/PR/MR responses. They omit unavailable or malformed
fields instead of inventing empty values. Optional fields preserve compatibility
for alternate providers and test doubles; enabling a rule requires those
providers to supply its evidence. GitLab issue creation sends its scaffold via
the API's `description` parameter.

Required-but-nullable is a different, already-covered case:
`PrFact.mergeCommitSha` is required `string \| null`; adapters normalize the
platform-proven target-branch result (merge, squash, or fast-forward). `null`
(the platform supplies no usable anchor) routes the merged-lineage gate to fail-closed
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
  (`src/gitfacts/local.ts`), `MockForgeProvider`
  (`test/specgit/helpers/mock-forge.ts`), and the recording doubles
  `makeGhProvider` / `makeGitPort`
  (`test/specgit-cli/helpers.ts`). The contract test holds all of them
  to the port shape at every run — the canonical adapter home and its
  deprecated `src/github` alias modules (#170) are pinned to the same
  class by the same test (#113), and the shared CLI transport both adapters spawn
  through lives at `src/providers/cli-spawn.ts` (#114).
- **Alternate providers (glab).** Landed (#114):
  `GlabProvider` satisfies `FORGE_PROVIDER_MEMBERS`, extends the
  contract test as an in-tree implementer, and mirrors the gh adapter's
  failure taxonomy per platform (`glab_missing`, `glab_unauthenticated`,
  `glab_transport` — timeout included — plus the advisory
  `gitlab_version_unverified` warning for a self-managed version outside
  the verified window (#241)); explicitly declared GitLab.com is capability-probed
  rather than version-pinned. The glab method map stays
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
