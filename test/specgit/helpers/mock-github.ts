import { fail, ok, type Evidence } from '../../../src/kernel/evidence.js';
import type { RepoRef } from '../../../src/gitfacts/origin.js';
import type { CheckRunInfo, GitHubProvider, IssueFact, PrFact } from '../../../src/github/port.js';

export interface MockGitHubFixtures {
  preflight?: Evidence<{ authenticated: boolean }>;
  issues?: Record<number, Evidence<IssueFact>>;
  defaultIssue?: (n: number) => Evidence<IssueFact>;
  pr?: Evidence<PrFact>;
  checkRuns?: Evidence<CheckRunInfo[]>;
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
