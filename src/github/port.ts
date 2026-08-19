import type { Evidence } from '../kernel/evidence.js';
import type { RepoRef } from '../gitfacts/origin.js';

export interface IssueFact {
  number: number;
  state: 'open' | 'closed';
  pullRequest: boolean;
}

export interface PrFact {
  number: number;
  state: 'open' | 'closed' | 'merged';
  headBranch: string;
  headSha: string;
  baseBranch: string;
  body: string;
}

export interface CheckRunInfo {
  name: string;
  status: string;
  conclusion: string | null;
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
  /** Numbers of all open issues (for the ordered_issues sequencing gate). */
  getOpenIssueNumbers(repo: RepoRef): Promise<Evidence<number[]>>;
  getPr(repo: RepoRef, pr: number | string): Promise<Evidence<PrFact>>;
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
