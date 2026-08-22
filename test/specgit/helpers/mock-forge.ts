/**
 * The platform-neutral forge test double (#169 naming, #219 rename).
 *
 * Implements `ForgeProvider` — the port both the gh and the glab
 * adapters realize — so the same fixture-driven double can stand in for
 * either delegate (see routing-provider.test.ts, where it plays both
 * sides of the platform routing seam). The class name names the seam,
 * not one platform.
 */

import { fail, ok, type Evidence } from '../../../src/kernel/evidence.js';
import type { RepoRef } from '../../../src/gitfacts/origin.js';
import type {
  BranchProtectionFact,
  CheckRunInfo,
  ForgeProvider,
  IssueCommentCreation,
  IssueCreation,
  IssueFact,
  OpenIssueFact,
  PrCreation,
  PrFact,
  PrSummary,
  PreflightFact,
  RepoAutomergeFact,
} from '../../../src/github/port.js';

export interface MockForgeFixtures {
  preflight?: Evidence<PreflightFact>;
  issues?: Record<number, Evidence<IssueFact>>;
  defaultIssue?: (n: number) => Evidence<IssueFact>;
  pr?: Evidence<PrFact>;
  checkRuns?: Evidence<CheckRunInfo[]>;
  createIssue?: (title: string) => Evidence<IssueCreation>;
  createDraftPr?: (head: string) => Evidence<PrCreation>;
  listOpenPrsByHead?: Evidence<PrSummary[]>;
  addIssueComment?: (issue: number, body: string) => Evidence<IssueCommentCreation>;
  branchProtection?: Evidence<BranchProtectionFact>;
  enableBranchProtection?: Evidence<BranchProtectionFact>;
  repoAutomerge?: Evidence<RepoAutomergeFact>;
  enableRepoAutomerge?: Evidence<RepoAutomergeFact>;
  openIssueNumbers?: Evidence<number[]>;
  openIssues?: Evidence<OpenIssueFact[]>;
}

function formatRepo(repo: RepoRef): string {
  return `${repo.owner}/${repo.repo}`;
}

export class MockForgeProvider implements ForgeProvider {
  readonly calls: string[] = [];

  constructor(private readonly fixtures: MockForgeFixtures = {}) {}

  async preflight(): Promise<Evidence<PreflightFact>> {
    this.calls.push('preflight');
    return this.fixtures.preflight ?? ok({ authenticated: true });
  }

  async getIssue(repo: RepoRef, n: number): Promise<Evidence<IssueFact>> {
    this.calls.push(`getIssue:${formatRepo(repo)}#${n}`);
    return (
      this.fixtures.issues?.[n] ??
      this.fixtures.defaultIssue?.(n) ??
      ok({ number: n, state: 'open', pullRequest: false })
    );
  }

  async getOpenIssueNumbers(repo: RepoRef): Promise<Evidence<number[]>> {
    this.calls.push(`getOpenIssueNumbers:${formatRepo(repo)}`);
    return this.fixtures.openIssueNumbers ?? ok([]);
  }

  async getOpenIssues(repo: RepoRef): Promise<Evidence<OpenIssueFact[]>> {
    this.calls.push(`getOpenIssues:${formatRepo(repo)}`);
    return this.fixtures.openIssues ?? ok([]);
  }

  async getPr(repo: RepoRef, pr: number | string): Promise<Evidence<PrFact>> {
    this.calls.push(`getPr:${formatRepo(repo)}#${pr}`);
    return this.fixtures.pr ?? fail('pr_not_found', `PR ${pr} not found (mock default)`);
  }

  async getCheckRuns(repo: RepoRef, sha: string): Promise<Evidence<CheckRunInfo[]>> {
    this.calls.push(`getCheckRuns:${formatRepo(repo)}@${sha}`);
    return this.fixtures.checkRuns ?? ok([]);
  }

  async createIssue(repo: RepoRef, title: string): Promise<Evidence<IssueCreation>> {
    this.calls.push(`createIssue:${formatRepo(repo)}:${title}`);
    return (
      this.fixtures.createIssue?.(title) ??
      fail('gh_transport', 'createIssue not configured in mock')
    );
  }

  async createDraftPr(repo: RepoRef, head: string): Promise<Evidence<PrCreation>> {
    this.calls.push(`createDraftPr:${formatRepo(repo)}:${head}`);
    return (
      this.fixtures.createDraftPr?.(head) ??
      fail('gh_transport', 'createDraftPr not configured in mock')
    );
  }

  async listOpenPrsByHead(repo: RepoRef, head: string): Promise<Evidence<PrSummary[]>> {
    this.calls.push(`listOpenPrsByHead:${formatRepo(repo)}:${head}`);
    return this.fixtures.listOpenPrsByHead ?? fail('gh_transport', 'listOpenPrsByHead not configured in mock');
  }

  async addIssueComment(
    repo: RepoRef,
    issue: number,
    body: string
  ): Promise<Evidence<IssueCommentCreation>> {
    this.calls.push(`addIssueComment:${formatRepo(repo)}:${issue}`);
    return (
      this.fixtures.addIssueComment?.(issue, body) ??
      fail('gh_transport', 'addIssueComment not configured in mock')
    );
  }

  async getBranchProtection(repo: RepoRef, branch: string): Promise<Evidence<BranchProtectionFact>> {
    this.calls.push(`getBranchProtection:${formatRepo(repo)}:${branch}`);
    return this.fixtures.branchProtection ?? ok({ protected: false, requiredChecks: [] });
  }

  async enableBranchProtection(
    repo: RepoRef,
    branch: string,
    requiredCheck: string
  ): Promise<Evidence<BranchProtectionFact>> {
    this.calls.push(`enableBranchProtection:${formatRepo(repo)}:${branch}:${requiredCheck}`);
    return (
      this.fixtures.enableBranchProtection ??
      ok({ protected: true, requiredChecks: [requiredCheck] })
    );
  }

  async getRepoAutomerge(repo: RepoRef): Promise<Evidence<RepoAutomergeFact>> {
    this.calls.push(`getRepoAutomerge:${formatRepo(repo)}`);
    return this.fixtures.repoAutomerge ?? ok({ enabled: false });
  }

  async enableRepoAutomerge(repo: RepoRef): Promise<Evidence<RepoAutomergeFact>> {
    this.calls.push(`enableRepoAutomerge:${formatRepo(repo)}`);
    return this.fixtures.enableRepoAutomerge ?? ok({ enabled: true });
  }
}

export function makePrFact(overrides: Partial<PrFact> = {}): PrFact {
  return {
    number: 42,
    state: 'open',
    headBranch: 'feat/123-login',
    headSha: 'a'.repeat(40),
    baseBranch: 'main',
    body: 'Closes #123',
    mergeCommitSha: null,
    draft: false,
    ...overrides,
  };
}

export function makeIssueFact(overrides: Partial<IssueFact> & { number: number }): IssueFact {
  return { state: 'open', pullRequest: false, ...overrides };
}

export function makeCheckRun(name: string, overrides: Partial<CheckRunInfo> = {}): CheckRunInfo {
  return { name, status: 'completed', conclusion: 'success', id: 0, startedAt: null, ...overrides };
}
