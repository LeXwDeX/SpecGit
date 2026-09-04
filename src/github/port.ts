import type { Evidence } from '../kernel/evidence.js';
import type { RepoRef } from '../gitfacts/origin.js';
import type { TagSpec } from '../tags/catalog.js';

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
  /** Complete remote body, used only when project content rules are enabled. */
  body?: string;
  /** Complete issue label names; absent when the provider did not supply valid label evidence. */
  labels?: string[];
}

export interface PrFact {
  number: number;
  /** The live request title; absent when title evidence was not supplied. */
  title?: string;
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
   * A platform-proven result commit on the target branch after merge.
   * Adapters normalize merge, squash and fast-forward strategies here;
   * acceptance still proves this anchor is contained by local HEAD.
   * Values for unmerged requests are never lineage evidence. Null means
   * the platform has not supplied a usable result anchor.
   */
  mergeCommitSha: string | null;
}

export interface CheckRunInfo {
  name: string;
  /** Provider identity disambiguates identically named checks from different apps. */
  source?: string;
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

/** Complete, current PR/MR checks for guarded automation, including classic statuses. */
export interface MergeChecksFact {
  headSha: string;
  checks: CheckRunInfo[];
  /** GitLab's authoritative head pipeline state; absent on GitHub. */
  pipelineStatus?: string;
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

/** A related historical issue; search matches are candidates, never a reuse decision. */
export interface IssueHistoryFact {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  url: string;
}

/** A newly created draft pull request: its number and canonical URL. */
export interface PrCreation {
  number: number;
  url: string;
}

/** A posted or reconciled issue comment: its canonical URL. */
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
 * The delivery's evidence anchor (#315): the ISO-8601 instant the
 * delivery last became reviewable on the platform, or null when the
 * provider sets no boundary. Acceptance for a required check counts
 * only truth runs started at or after this instant — a run that
 * finished before the anchor is not evidence the reviewable delivery
 * was verified. Null is a legal provider answer (a platform without
 * such a transition concept); it leaves the verdict exactly as it
 * stood, without claiming the two facts are equivalent.
 */
export interface EvidenceAnchorFact {
  anchoredAt: string | null;
}

/**
 * Preflight facts (#247): platform-neutral so the port contract never
 * names a forge. `versionUnverified` is advisory (#241) — an adapter may
 * set it when its instance reports a version outside its verified window
 * (only the glab adapter does today); the evaluator relays it as a
 * warning and never blocks the verdict on it.
 */
export interface PreflightFact {
  authenticated: boolean;
  versionUnverified?: boolean;
}

/**
 * The label pool of a repository (#330): every label title the forge
 * reports, as bare names. Selection classifies them through the tag
 * grammar — form-valid names become candidates, off-form ones are
 * reported (`tag_pool_dirty`) and never rewritten.
 */
export interface RepoLabelsFact {
  names: string[];
}

/**
 * Labels confirmed present after an idempotent ensure or apply (#330):
 * exactly the slugs the call named, each either created or already
 * carried by the repository / issue. Never a broader echo — a name the
 * forge refused to confirm is absent from this list.
 */
export interface LabelsAppliedFact {
  names: string[];
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
  preflight(): Promise<Evidence<PreflightFact>>;
  /** The platform's configured CI entry path, or null for its default entry point. */
  getCiConfigPath(repo: RepoRef): Promise<Evidence<string | null>>;
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
  /** Complete results for a bounded keyword query across open and closed issues; truncation fails closed. */
  searchIssueHistory(repo: RepoRef, query: string): Promise<Evidence<IssueHistoryFact[]>>;
  /** Complete same-project requests referenced by this issue, refreshed from current PR/MR facts. */
  listIssuePullRequests(repo: RepoRef, issue: number): Promise<Evidence<PrFact[]>>;
  getPr(repo: RepoRef, pr: number | string): Promise<Evidence<PrFact>>;
  /**
   * Check runs reported for a commit and optional pull/merge request.
   * Acceptance always supplies `pr`: GitLab uses its head pipeline,
   * preventing older or unrelated same-SHA pipelines from filling gaps.
   * Omitting it retains the commit-scoped library lookup.
   * Completeness contract (#120, I3b):
   * `ok` means the list was gathered to exhaustion — a provider that
   * cannot prove exhaustion must fail (`evidence_truncated`), never
   * return a silently partial list.
   */
  getCheckRuns(repo: RepoRef, sha: string, pr?: number): Promise<Evidence<CheckRunInfo[]>>;
  getPrChecks(repo: RepoRef, pr: number): Promise<Evidence<MergeChecksFact>>;
  /** Merge with a server-enforced expected head; never bypass platform protection. */
  mergePr(repo: RepoRef, pr: number, expectedHeadSha: string): Promise<Evidence<{ merged: boolean }>>;
  /** Idempotently close one bound issue and confirm its remote state. */
  closeIssue(repo: RepoRef, issue: number): Promise<Evidence<{ closed: boolean }>>;
  /**
   * The evidence anchor (#315): the platform instant the delivery
   * last became reviewable — the boundary a required check's truth
   * run must start at or after to count as acceptance evidence.
   * `anchoredAt` is null when the provider sets no boundary (a legal
   * answer, judged exactly as before); a failed Evidence is the
   * fail-closed path — no verdict is possible. The transition source
   * is an adapter concern; this surface stays provider-neutral.
   */
  getEvidenceAnchor(repo: RepoRef, pr: number | string): Promise<Evidence<EvidenceAnchorFact>>;
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
   * Ensure an exact-body comment exists and return its canonical URL.
   * A complete remote read reconciles retries after partial bootstrap or
   * a lost POST response. Read failures fail closed. Concurrent writers
   * are not serialized by this interface; it promises retry convergence,
   * not transactional exactly-once delivery across independent processes.
   */
  addIssueComment(
    repo: RepoRef,
    issue: number,
    body: string
  ): Promise<Evidence<IssueCommentCreation>>;
  /**
   * Add labels to an issue (#330), union semantics — already-present
   * names stay, requested names join. Idempotent: re-running with the
   * same slugs converges. The delivery traceability layer's tag apply:
   * called for every bound issue after the selection resolves.
   */
  addIssueLabels(
    repo: RepoRef,
    issue: number,
    slugs: string[]
  ): Promise<Evidence<LabelsAppliedFact>>;
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
  /** Every label title the repository carries (#330) — the pool tags are selected from. */
  listRepoLabels(repo: RepoRef): Promise<Evidence<RepoLabelsFact>>;
  /**
   * Create the named specs that are missing (#330), leave existing ones
   * untouched, and confirm each — created or already present — in the
   * returned fact. Idempotent by contract; a spec the forge refused to
   * confirm fails the call (fail-closed).
   */
  ensureRepoLabels(repo: RepoRef, specs: TagSpec[]): Promise<Evidence<LabelsAppliedFact>>;
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
  getCiConfigPath: true,
  getIssue: true,
  getOpenIssueNumbers: true,
  getOpenIssues: true,
  searchIssueHistory: true,
  listIssuePullRequests: true,
  getPr: true,
  getCheckRuns: true,
  getPrChecks: true,
  mergePr: true,
  closeIssue: true,
  getEvidenceAnchor: true,
  createIssue: true,
  createDraftPr: true,
  listOpenPrsByHead: true,
  addIssueComment: true,
  addIssueLabels: true,
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
  listRepoLabels: true,
  ensureRepoLabels: true,
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
