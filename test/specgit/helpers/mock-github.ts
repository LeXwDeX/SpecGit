import { fail, ok, type Evidence } from '../../../src/kernel/evidence.js';
import type { RepoRef } from '../../../src/gitfacts/origin.js';
import type {
  CheckRunInfo,
  GitHubProvider,
  IssueCreation,
  IssueFact,
  PrCreation,
  PrFact,
  PrSummary,
} from '../../../src/github/port.js';

export interface MockGitHubFixtures {
  preflight?: Evidence<{ authenticated: boolean }>;
  issues?: Record<number, Evidence<IssueFact>>;
  defaultIssue?: (n: number) => Evidence<IssueFact>;
  pr?: Evidence<PrFact>;
  checkRuns?: Evidence<CheckRunInfo[]>;
  createIssue?: (title: string) => Evidence<IssueCreation>;
  createDraftPr?: (head: string) => Evidence<PrCreation>;
  listOpenPrsByHead?: Evidence<PrSummary[]>;
}

function formatRepo(repo: RepoRef): string {
  return `${repo.owner}/${repo.repo}`;
}

export class MockGitHubProvider implements GitHubProvider {
  readonly calls: string[] = [];

  constructor(private readonly fixtures: MockGitHubFixtures = {}) {}

  async preflight(): Promise<Evidence<{ authenticated: boolean }>> {
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
}

export function makePrFact(overrides: Partial<PrFact> = {}): PrFact {
  return {
    number: 42,
    state: 'open',
    headBranch: 'feat/123-login',
    headSha: 'a'.repeat(40),
    baseBranch: 'main',
    body: 'Closes #123',
    ...overrides,
  };
}

export function makeIssueFact(overrides: Partial<IssueFact> & { number: number }): IssueFact {
  return { state: 'open', pullRequest: false, ...overrides };
}

export function makeCheckRun(name: string, overrides: Partial<CheckRunInfo> = {}): CheckRunInfo {
  return { name, status: 'completed', conclusion: 'success', ...overrides };
}
