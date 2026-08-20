import type { RepoRef } from '../gitfacts/origin.js';
import type { GitHubProvider } from '../github/port.js';

/**
 * #117 (provider routing): the production composition hands commands one
 * provider; this one dispatches per call. A ref resolved through the
 * GitLab declaration carries the `platform: 'gitlab'` marker (#112 —
 * reachable only via providers.yaml, never the substring heuristic) and
 * every repo-carrying call on it flows to the glab delegate; every other
 * ref flows to the github delegate. The #112 invariant — no gh call ever
 * sees a group/subgroup ref — holds by construction: the github delegate
 * is behind the dispatch, not beside it.
 *
 * `preflight` carries no ref, so it follows the delivery origin: the
 * injected resolver classifies the origin once (cached for the process
 * lifetime, which for the CLI is one command). An undecided origin keeps
 * today's behavior — the github provider — because an undeclared origin
 * has no GitLab evidence route to probe.
 */

export interface PlatformRoutingDeps {
  github: GitHubProvider;
  /**
   * The glab delegate, constructed on first use: its inputs (the declared
   * hostname, the policy's required checks) resolve asynchronously per
   * command, so the composition root hands over an async factory, not an
   * instance. Called at most once and memoized.
   */
  gitlab: () => Promise<GitHubProvider>;
  /** Classifies the delivery origin's platform; resolved once, lazily. */
  originPlatform: () => Promise<'github' | 'gitlab' | 'undecided'>;
}

export class PlatformRoutingProvider implements GitHubProvider {
  private readonly github: GitHubProvider;
  private readonly createGitlab: () => Promise<GitHubProvider>;
  private readonly resolveOriginPlatform: PlatformRoutingDeps['originPlatform'];
  private gitlabPromise: Promise<GitHubProvider> | undefined;
  private originPlatformPromise: Promise<'github' | 'gitlab' | 'undecided'> | undefined;

  constructor(deps: PlatformRoutingDeps) {
    this.github = deps.github;
    this.createGitlab = deps.gitlab;
    this.resolveOriginPlatform = deps.originPlatform;
  }

  private forRepo(repo: RepoRef): Promise<GitHubProvider> {
    return repo.platform === 'gitlab'
      ? (this.gitlabPromise ??= this.createGitlab())
      : Promise.resolve(this.github);
  }

  private async forOrigin(): Promise<GitHubProvider> {
    this.originPlatformPromise ??= this.resolveOriginPlatform();
    if ((await this.originPlatformPromise) === 'gitlab') {
      return (this.gitlabPromise ??= this.createGitlab());
    }
    return this.github;
  }

  private async delegate(repo: RepoRef | undefined): Promise<GitHubProvider> {
    return repo === undefined ? this.forOrigin() : this.forRepo(repo);
  }

  async preflight(): ReturnType<GitHubProvider['preflight']> {
    return (await this.forOrigin()).preflight();
  }

  async getIssue(repo: RepoRef, n: number): ReturnType<GitHubProvider['getIssue']> {
    return (await this.forRepo(repo)).getIssue(repo, n);
  }

  async getOpenIssueNumbers(
    repo: RepoRef
  ): ReturnType<GitHubProvider['getOpenIssueNumbers']> {
    return (await this.forRepo(repo)).getOpenIssueNumbers(repo);
  }

  async getOpenIssues(repo: RepoRef): ReturnType<GitHubProvider['getOpenIssues']> {
    return (await this.forRepo(repo)).getOpenIssues(repo);
  }

  async getPr(repo: RepoRef, pr: number | string): ReturnType<GitHubProvider['getPr']> {
    return (await this.forRepo(repo)).getPr(repo, pr);
  }

  async getCheckRuns(
    repo: RepoRef,
    sha: string
  ): ReturnType<GitHubProvider['getCheckRuns']> {
    return (await this.forRepo(repo)).getCheckRuns(repo, sha);
  }

  async createIssue(
    repo: RepoRef,
    title: string,
    body: string
  ): ReturnType<GitHubProvider['createIssue']> {
    return (await this.forRepo(repo)).createIssue(repo, title, body);
  }

  async createDraftPr(
    repo: RepoRef,
    head: string,
    base: string,
    title: string,
    body: string
  ): ReturnType<GitHubProvider['createDraftPr']> {
    return (await this.forRepo(repo)).createDraftPr(repo, head, base, title, body);
  }

  async listOpenPrsByHead(
    repo: RepoRef,
    head: string
  ): ReturnType<GitHubProvider['listOpenPrsByHead']> {
    return (await this.forRepo(repo)).listOpenPrsByHead(repo, head);
  }

  async getBranchProtection(
    repo: RepoRef,
    branch: string
  ): ReturnType<GitHubProvider['getBranchProtection']> {
    return (await this.forRepo(repo)).getBranchProtection(repo, branch);
  }

  async enableBranchProtection(
    repo: RepoRef,
    branch: string,
    requiredCheck: string
  ): ReturnType<GitHubProvider['enableBranchProtection']> {
    return (await this.forRepo(repo)).enableBranchProtection(repo, branch, requiredCheck);
  }

  async getRepoAutomerge(repo: RepoRef): ReturnType<GitHubProvider['getRepoAutomerge']> {
    return (await this.forRepo(repo)).getRepoAutomerge(repo);
  }

  async enableRepoAutomerge(
    repo: RepoRef
  ): ReturnType<GitHubProvider['enableRepoAutomerge']> {
    return (await this.forRepo(repo)).enableRepoAutomerge(repo);
  }
}
