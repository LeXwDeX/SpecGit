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

/** A newly created draft pull request: its number and canonical URL. */
export interface PrCreation {
  number: number;
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

export interface GitHubProvider {
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
 * Member inventory of `GitHubProvider`. The `satisfies Record<keyof
 * GitHubProvider, true>` check fails compilation when the port and this
 * inventory drift apart in either direction — a required member added to
 * the port must be reflected here, in every implementation (including the
 * future glab adapter), and in the compatibility policy in one delivery
 * (#80). Docs and contract tests read this list; there is no second copy.
 */
const GITHUB_PROVIDER_MEMBER_FLAGS = {
  preflight: true,
  getIssue: true,
  getOpenIssueNumbers: true,
  getPr: true,
  getCheckRuns: true,
  createIssue: true,
  createDraftPr: true,
  listOpenPrsByHead: true,
  getBranchProtection: true,
  enableBranchProtection: true,
  getRepoAutomerge: true,
  enableRepoAutomerge: true,
} as const satisfies Record<keyof GitHubProvider, true>;

export const GITHUB_PROVIDER_MEMBERS: readonly (keyof GitHubProvider)[] = Object.freeze(
  Object.keys(GITHUB_PROVIDER_MEMBER_FLAGS) as Array<keyof GitHubProvider>
);
