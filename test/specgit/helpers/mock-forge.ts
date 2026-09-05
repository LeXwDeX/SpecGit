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
  EvidenceAnchorFact,
  ForgeProvider,
  IssueCommentCreation,
  IssueCreation,
  IssueFact,
  IssueHistoryFact,
  LabelsAppliedFact,
  OpenIssueFact,
  PrCreation,
  PrFact,
  PrSummary,
  PreflightFact,
  RepoAutomergeFact,
  RepoLabelsFact,
} from '../../../src/github/port.js';
import type { TagSpec } from '../../../src/tags/catalog.js';

export interface MockForgeFixtures {
  preflight?: Evidence<PreflightFact>;
  ciConfigPath?: Evidence<string | null>;
  issues?: Record<number, Evidence<IssueFact>>;
  defaultIssue?: (n: number) => Evidence<IssueFact>;
  pr?: Evidence<PrFact>;
  checkRuns?: Evidence<CheckRunInfo[]>;
  prChecks?: Evidence<{ headSha: string; checks: CheckRunInfo[]; pipelineStatus?: string }>;
  mergePr?: (pr: number | string, expectedHeadSha: string) => Evidence<{ merged: boolean }>;
  closeIssue?: (issue: number) => Evidence<{ closed: boolean }>;
  /**
   * Check-freshness anchor (#315). The default is the no-boundary fact
   * (`anchoredAt: null`) so every fixture that predates #315 keeps its
   * byte-identical verdict; gate tests inject a string to enforce the
   * boundary or a failure to exercise the fail-closed path.
   */
  evidenceAnchor?: Evidence<EvidenceAnchorFact>;
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
  issueHistory?: (query: string) => Evidence<IssueHistoryFact[]>;
  issuePullRequests?: (issue: number) => Evidence<PrFact[]>;
  /** #330: the repository's label pool as names. */
  repoLabels?: (repo: RepoRef) => Evidence<RepoLabelsFact>;
  /** #330: seed specs the ensure call receives; result echoes them. */
  ensureRepoLabels?: (specs: TagSpec[]) => Evidence<LabelsAppliedFact>;
  /** #330: per-issue label applies. */
  addIssueLabels?: (issue: number, slugs: string[]) => Evidence<LabelsAppliedFact>;
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

  async getCiConfigPath(repo: RepoRef): Promise<Evidence<string | null>> {
    this.calls.push(`getCiConfigPath:${formatRepo(repo)}`);
    return this.fixtures.ciConfigPath ?? ok(null);
  }

  async getOpenIssueNumbers(repo: RepoRef): Promise<Evidence<number[]>> {
    this.calls.push(`getOpenIssueNumbers:${formatRepo(repo)}`);
    return this.fixtures.openIssueNumbers ?? ok([]);
  }

  async getOpenIssues(repo: RepoRef): Promise<Evidence<OpenIssueFact[]>> {
    this.calls.push(`getOpenIssues:${formatRepo(repo)}`);
    return this.fixtures.openIssues ?? ok([]);
  }

  async searchIssueHistory(repo: RepoRef, query: string): Promise<Evidence<IssueHistoryFact[]>> {
    this.calls.push(`searchIssueHistory:${formatRepo(repo)}:${query}`);
    return this.fixtures.issueHistory?.(query) ?? ok([]);
  }

  async listIssuePullRequests(repo: RepoRef, issue: number): Promise<Evidence<PrFact[]>> {
    this.calls.push(`listIssuePullRequests:${formatRepo(repo)}#${issue}`);
    return this.fixtures.issuePullRequests?.(issue) ?? ok([]);
  }

  async getPr(repo: RepoRef, pr: number | string): Promise<Evidence<PrFact>> {
    this.calls.push(`getPr:${formatRepo(repo)}#${pr}`);
    return this.fixtures.pr ?? fail('pr_not_found', `PR ${pr} not found (mock default)`);
  }

  async getCheckRuns(repo: RepoRef, sha: string): Promise<Evidence<CheckRunInfo[]>> {
    this.calls.push(`getCheckRuns:${formatRepo(repo)}@${sha}`);
    return this.fixtures.checkRuns ?? ok([]);
  }

  async getPrChecks(repo: RepoRef, pr: number | string): Promise<Evidence<{ headSha: string; checks: CheckRunInfo[]; pipelineStatus?: string }>> {
    this.calls.push(`getPrChecks:${formatRepo(repo)}#${pr}`);
    return this.fixtures.prChecks ?? fail('gh_transport', 'getPrChecks not configured in mock');
  }

  async mergePr(repo: RepoRef, pr: number | string, expectedHeadSha: string): Promise<Evidence<{ merged: boolean }>> {
    this.calls.push(`mergePr:${formatRepo(repo)}#${pr}@${expectedHeadSha}`);
    return this.fixtures.mergePr?.(pr, expectedHeadSha) ?? fail('gh_transport', 'mergePr not configured in mock');
  }

  async closeIssue(repo: RepoRef, issue: number): Promise<Evidence<{ closed: boolean }>> {
    this.calls.push(`closeIssue:${formatRepo(repo)}#${issue}`);
    return this.fixtures.closeIssue?.(issue) ?? fail('gh_transport', 'closeIssue not configured in mock');
  }

  async getEvidenceAnchor(
    repo: RepoRef,
    pr: number | string
  ): Promise<Evidence<EvidenceAnchorFact>> {
    this.calls.push(`getEvidenceAnchor:${formatRepo(repo)}#${pr}`);
    return this.fixtures.evidenceAnchor ?? ok({ anchoredAt: null });
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
    requiredGate: string
  ): Promise<Evidence<BranchProtectionFact>> {
    this.calls.push(`enableBranchProtection:${formatRepo(repo)}:${branch}:${requiredGate}`);
    return (
      this.fixtures.enableBranchProtection ??
      ok({
        protected: true,
        requiredChecks: repo.platform === 'github' ? [requiredGate] : [],
      })
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

  async listRepoLabels(repo: RepoRef): Promise<Evidence<RepoLabelsFact>> {
    this.calls.push(`listRepoLabels:${formatRepo(repo)}`);
    return this.fixtures.repoLabels?.(repo) ?? ok({ names: [] });
  }

  async ensureRepoLabels(repo: RepoRef, specs: TagSpec[]): Promise<Evidence<LabelsAppliedFact>> {
    this.calls.push(`ensureRepoLabels:${formatRepo(repo)}:${specs.map((s) => s.name).join('|')}`);
    return this.fixtures.ensureRepoLabels?.(specs) ?? ok({ names: specs.map((spec) => spec.name) });
  }

  async addIssueLabels(
    repo: RepoRef,
    issue: number,
    slugs: string[]
  ): Promise<Evidence<LabelsAppliedFact>> {
    this.calls.push(`addIssueLabels:${formatRepo(repo)}#${issue}:${slugs.join('|')}`);
    return (
      this.fixtures.addIssueLabels?.(issue, slugs) ?? ok({ names: slugs })
    );
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
