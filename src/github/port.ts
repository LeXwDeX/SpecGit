import type { Evidence } from '../kernel/evidence.js';
import type { RepoRef } from '../gitfacts/origin.js';

export interface IssueFact {
  number: number;
  state: 'open' | 'closed';
  pullRequest: boolean;
  /**
   * Issue title when the provider surfaces it. An exact open-issue title
   * match is the remotely discoverable idempotency marker that lets
   * `specgit issue` adopt an issue a previous run created but failed to
   * record, instead of duplicating the WHY.
   */
  title?: string;
}

export interface PrFact {
  number: number;
  state: 'open' | 'closed' | 'merged';
  headBranch: string;
  headSha: string;
  baseBranch: string;
  body: string;
  /**
   * Whether the pull request is a draft. A draft is a platform-level
   * unmergeable state that never auto-transitions, so it is a verdict
   * dimension: the PR gate fails a draft with `pr_draft` even when every
   * other gate is green. Never true for merged or closed pull requests.
   */
  draft: boolean;
  /**
   * GitHub's merge_commit_sha. Once a PR is merged this is a commit on
   * the base branch under every merge method — the merge commit, the
   * squashed commit, or the commit the base was updated to by a rebase —
   * which makes it the strategy-invariant anchor for proving the merged
   * delivery is contained by a local HEAD. Before a merge it is
   * GitHub's throwaway test-merge commit, which no branch contains.
   * Null when GitHub reports no value.
   */
  mergeCommitSha: string | null;
}

export interface CheckRunInfo {
  name: string;
  status: string;
  conclusion: string | null;
  /**
   * GitLab `allow_failure: true` (#116, ledger row 17): the job fact
   * keeps its truthful `conclusion: 'failure'`, and the checks gate
   * passes the run per pipeline semantics — a failed `allow_failure`
   * job keeps the pipeline green. Only failure is affected; every
   * other conclusion still fails. The GitHub adapter never sets it.
   */
  allowFailure?: boolean;
  /**
   * Check-run id. Re-runs keep every same-name run in the Checks API
   * (#119); ties on started_at break by the higher id (the newer run).
   */
  id: number;
  /** ISO-8601 started_at; null when GitHub reports no value (treated as oldest). */
  startedAt: string | null;
}

/** A newly created GitHub issue: its number and canonical html URL. */
export interface IssueCreation {
  number: number;
  url: string;
}

/**
 * One open issue as surfaced by the title-carrying open-issue scan. The
 * title is the remotely discoverable idempotency marker for `specgit
 * issue` adoption (#77); the body, when the provider surfaces it, is the
 * boundary that disambiguates a same-title collision — an issue this
 * tool created carries the deterministic scaffold body.
 */
export interface OpenIssueFact {
  number: number;
  /** Non-empty when the provider surfaces it; absent titles never match. */
  title?: string;
  /** Issue body when the provider surfaces it; absent bodies never win scaffold disambiguation. */
  body?: string;
}

/** A newly created draft pull request: its number and canonical URL. */
export interface PrCreation {
  number: number;
  url: string;
}

/** A newly posted issue comment: its canonical URL. */
export interface IssueCommentCreation {
  url: string;
}

/** An open pull request as listed for one head branch. */
export interface PrSummary {
  number: number;
  title: string;
  url: string;
}

/** Branch protection state: whether the branch is protected and by which checks. */
export interface BranchProtectionFact {
  protected: boolean;
  requiredChecks: string[];
}

/** Repository-level auto-merge setting. */
export interface RepoAutomergeFact {
  enabled: boolean;
}

/**
 * The read surface of the forge port (#180): evidence collection plus the
 * delivery-lifecycle mutations (issues, pull requests, check runs,
 * comments). This is the surface a platform needs to participate in
 * evidence gathering and delivery bootstrap — repository administration
 * lives on {@link ForgeAdminPort}, so a future platform whose gate paths
 * never consume admin evidence can implement this surface alone.
 */
export interface ForgeReadPort {
  preflight(): Promise<Evidence<{ authenticated: boolean }>>;
  getIssue(repo: RepoRef, n: number): Promise<Evidence<IssueFact>>;
  /**
   * Numbers of all open issues (for the ordered_issues sequencing gate and
   * title-based adoption). Completeness contract (#120, I3b): `ok` means
   * the list was gathered to exhaustion — a provider that cannot prove
   * exhaustion must fail (`evidence_truncated`), never return a silently
   * partial list.
   */
  getOpenIssueNumbers(repo: RepoRef): Promise<Evidence<number[]>>;
  /**
   * Every open issue as a title-carrying fact (#77): the one probe the
   * bootstrap adoption path reads — a single paginated search replaces
   * the former per-issue `getIssue` fan-out, so probe cost is bounded by
   * pages, not by open-issue count. Same completeness contract as
   * `getOpenIssueNumbers` (#120, I3b): `ok` means exhausted, truncation
   * fails (`evidence_truncated`).
   */
  getOpenIssues(repo: RepoRef): Promise<Evidence<OpenIssueFact[]>>;
  getPr(repo: RepoRef, pr: number | string): Promise<Evidence<PrFact>>;
  /**
   * Check runs reported for a commit. Completeness contract (#120, I3b):
   * `ok` means the list was gathered to exhaustion — a provider that
   * cannot prove exhaustion must fail (`evidence_truncated`), never
   * return a silently partial list.
   */
  getCheckRuns(repo: RepoRef, sha: string): Promise<Evidence<CheckRunInfo[]>>;
  createIssue(repo: RepoRef, title: string, body: string): Promise<Evidence<IssueCreation>>;
  createDraftPr(
    repo: RepoRef,
    head: string,
    base: string,
    title: string,
    body: string
  ): Promise<Evidence<PrCreation>>;
  listOpenPrsByHead(repo: RepoRef, head: string): Promise<Evidence<PrSummary[]>>;
  /**
   * Post a comment on an issue. The traceability edge issue→branch: the
   * bootstrap writes the delivery branch and pull request on every bound
   * issue the moment the PR binding is first established, so the triple
   * branch↔issue↔PR is navigable from every node. Called at most once per
   * binding — `record.pr` in `.specgit.yaml` is the persisted marker that
   * the comment was posted, which keeps re-runs exactly-once.
   */
  addIssueComment(
    repo: RepoRef,
    issue: number,
    body: string
  ): Promise<Evidence<IssueCommentCreation>>;
}

/**
 * The admin surface of the forge port (#180): repository administration —
 * branch protection and auto-merge configuration, consumed by the
 * guarded-merge story (`specgit init` / `doctor`). These members change
 * repository settings rather than gather delivery evidence, which is why
 * they live apart from {@link ForgeReadPort}.
 */
export interface ForgeAdminPort {
  getBranchProtection(repo: RepoRef, branch: string): Promise<Evidence<BranchProtectionFact>>;
  enableBranchProtection(
    repo: RepoRef,
    branch: string,
    requiredCheck: string
  ): Promise<Evidence<BranchProtectionFact>>;
  getRepoAutomerge(repo: RepoRef): Promise<Evidence<RepoAutomergeFact>>;
  enableRepoAutomerge(repo: RepoRef): Promise<Evidence<RepoAutomergeFact>>;
}

/**
 * The platform-neutral provider port (#169): forge evidence and mutations
 * for whichever platform the origin declares — implemented today by the
 * gh adapter (`GhCliGitHubProvider`), the glab adapter (`GlabProvider`),
 * and the per-call dispatcher (`PlatformRoutingProvider`). The historical
 * name `GitHubProvider` contradicted the dual-platform reality; it stays
 * importable as the compatibility alias below.
 *
 * Since #180 the port is the composition of two surfaces: the read
 * surface ({@link ForgeReadPort}) and the admin surface
 * ({@link ForgeAdminPort}). Every member is still required on both
 * surfaces today — the split is the seam that lets a future platform
 * implement the read surface alone once no gate in its path consumes
 * admin evidence; the intersection type keeps every existing consumer
 * (`implements ForgeProvider`) compiling unchanged.
 */
export interface ForgeProvider extends ForgeReadPort, ForgeAdminPort {}

/**
 * Member inventory of `ForgeReadPort` (#180). The `satisfies
 * Record<keyof ForgeReadPort, true>` check fails compilation when the
 * read surface and this inventory drift apart in either direction.
 */
const FORGE_READ_PORT_MEMBER_FLAGS = {
  preflight: true,
  getIssue: true,
  getOpenIssueNumbers: true,
  getOpenIssues: true,
  getPr: true,
  getCheckRuns: true,
  createIssue: true,
  createDraftPr: true,
  listOpenPrsByHead: true,
  addIssueComment: true,
} as const satisfies Record<keyof ForgeReadPort, true>;

export const FORGE_READ_PORT_MEMBERS: readonly (keyof ForgeReadPort)[] = Object.freeze(
  Object.keys(FORGE_READ_PORT_MEMBER_FLAGS) as Array<keyof ForgeReadPort>
);

/**
 * Member inventory of `ForgeAdminPort` (#180). The `satisfies
 * Record<keyof ForgeAdminPort, true>` check fails compilation when the
 * admin surface and this inventory drift apart in either direction.
 */
const FORGE_ADMIN_PORT_MEMBER_FLAGS = {
  getBranchProtection: true,
  enableBranchProtection: true,
  getRepoAutomerge: true,
  enableRepoAutomerge: true,
} as const satisfies Record<keyof ForgeAdminPort, true>;

export const FORGE_ADMIN_PORT_MEMBERS: readonly (keyof ForgeAdminPort)[] = Object.freeze(
  Object.keys(FORGE_ADMIN_PORT_MEMBER_FLAGS) as Array<keyof ForgeAdminPort>
);

/**
 * Member inventory of the composed `ForgeProvider` (#180): derived from
 * the two surface inventories, never a second copy — the `satisfies
 * Record<keyof ForgeProvider, true>` check fails compilation when the
 * port and this inventory drift apart in either direction, so a required
 * member added to either surface must be reflected here, in every
 * implementation (including the glab adapter), and in the compatibility
 * policy in one delivery (#80). Docs and contract tests read this list;
 * there is no second copy.
 */
const FORGE_PROVIDER_MEMBER_FLAGS = {
  ...FORGE_READ_PORT_MEMBER_FLAGS,
  ...FORGE_ADMIN_PORT_MEMBER_FLAGS,
} as const satisfies Record<keyof ForgeProvider, true>;

export const FORGE_PROVIDER_MEMBERS: readonly (keyof ForgeProvider)[] = Object.freeze(
  Object.keys(FORGE_PROVIDER_MEMBER_FLAGS) as Array<keyof ForgeProvider>
);

/**
 * Compatibility alias of the pre-#169 port name (#169): external consumers
 * importing `GitHubProvider` keep compiling unchanged. In-tree code uses
 * `ForgeProvider`; removal follows the deprecation path in
 * docs/providers.md.
 *
 * @deprecated Use {@link ForgeProvider}.
 */
export type GitHubProvider = ForgeProvider;

/**
 * Compatibility alias of the pre-#169 inventory name (#169): the exact
 * same frozen list as {@link FORGE_PROVIDER_MEMBERS}, never a copy.
 *
 * @deprecated Use {@link FORGE_PROVIDER_MEMBERS}.
 */
export const GITHUB_PROVIDER_MEMBERS = FORGE_PROVIDER_MEMBERS;
