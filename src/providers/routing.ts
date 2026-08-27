import type { RepoRef } from '../gitfacts/origin.js';
import type { ForgeProvider } from '../github/port.js';
import type { TagSpec } from '../tags/catalog.js';

/**
 * #117 (provider routing): the production composition hands commands one
 * provider; this one dispatches per call. A ref resolved through the
 * GitLab declaration carries the `platform: 'gitlab'` marker (#112 —
 * reachable only via providers.yaml, never the substring heuristic) and
 * every repo-carrying call on it flows to the glab delegate; refs marked
 * `'github'` flow to the github delegate. Since #186 the marker is a
 * required union and the dispatch is an exhaustive switch with a `never`
 * default, so a third platform is a compile error until handled here.
 * The #112 invariant — no gh call ever sees a group/subgroup ref — holds
 * by construction: the github delegate is behind the dispatch, not beside
 * it.
 *
 * `preflight` carries no ref, so it follows the delivery origin: the
 * injected resolver classifies the origin once (cached for the process
 * lifetime, which for the CLI is one command). An undecided origin keeps
 * today's behavior — the github provider — because an undeclared origin
 * has no GitLab evidence route to probe.
 *
 * Since #180 the port composes the read surface (`ForgeReadPort`) and the
 * admin surface (`ForgeAdminPort`); both delegates are full
 * `ForgeProvider`s, so every member of both surfaces routes through the
 * same per-call dispatch — the split changes no routing behavior.
 */

export interface PlatformRoutingDeps {
  github: ForgeProvider;
  /**
   * The glab delegate, constructed on first use: its inputs (the declared
   * hostname, the policy's required checks) resolve asynchronously per
   * command, so the composition root hands over an async factory, not an
   * instance. Called at most once and memoized.
   */
  gitlab: () => Promise<ForgeProvider>;
  /** Classifies the delivery origin's platform; resolved once, lazily. */
  originPlatform: () => Promise<'github' | 'gitlab' | 'undecided'>;
}

export class PlatformRoutingProvider implements ForgeProvider {
  private readonly github: ForgeProvider;
  private readonly createGitlab: () => Promise<ForgeProvider>;
  private readonly resolveOriginPlatform: PlatformRoutingDeps['originPlatform'];
  private gitlabPromise: Promise<ForgeProvider> | undefined;
  private originPlatformPromise: Promise<'github' | 'gitlab' | 'undecided'> | undefined;

  constructor(deps: PlatformRoutingDeps) {
    this.github = deps.github;
    this.createGitlab = deps.gitlab;
    this.resolveOriginPlatform = deps.originPlatform;
  }

  private forRepo(repo: RepoRef): Promise<ForgeProvider> {
    // #186: dispatch matches every member of the platform union; the
    // `never` default makes a new platform a compile error until it is
    // routed, never a silent github fallback.
    switch (repo.platform) {
      case 'gitlab':
        return (this.gitlabPromise ??= this.createGitlab());
      case 'github':
        return Promise.resolve(this.github);
      default: {
        const unhandled: never = repo.platform;
        return Promise.reject(new Error(`Unhandled platform: ${String(unhandled)}`));
      }
    }
  }

  private async forOrigin(): Promise<ForgeProvider> {
    this.originPlatformPromise ??= this.resolveOriginPlatform();
    if ((await this.originPlatformPromise) === 'gitlab') {
      return (this.gitlabPromise ??= this.createGitlab());
    }
    return this.github;
  }

  private async delegate(repo: RepoRef | undefined): Promise<ForgeProvider> {
    return repo === undefined ? this.forOrigin() : this.forRepo(repo);
  }

  async preflight(): ReturnType<ForgeProvider['preflight']> {
    return (await this.forOrigin()).preflight();
  }

  async getIssue(repo: RepoRef, n: number): ReturnType<ForgeProvider['getIssue']> {
    return (await this.forRepo(repo)).getIssue(repo, n);
  }

  async getOpenIssueNumbers(
    repo: RepoRef
  ): ReturnType<ForgeProvider['getOpenIssueNumbers']> {
    return (await this.forRepo(repo)).getOpenIssueNumbers(repo);
  }

  async getOpenIssues(repo: RepoRef): ReturnType<ForgeProvider['getOpenIssues']> {
    return (await this.forRepo(repo)).getOpenIssues(repo);
  }

  async getPr(repo: RepoRef, pr: number | string): ReturnType<ForgeProvider['getPr']> {
    return (await this.forRepo(repo)).getPr(repo, pr);
  }

  async getCheckRuns(
    repo: RepoRef,
    sha: string
  ): ReturnType<ForgeProvider['getCheckRuns']> {
    return (await this.forRepo(repo)).getCheckRuns(repo, sha);
  }

  async getEvidenceAnchor(
    repo: RepoRef,
    pr: number | string
  ): ReturnType<ForgeProvider['getEvidenceAnchor']> {
    return (await this.forRepo(repo)).getEvidenceAnchor(repo, pr);
  }

  async createIssue(
    repo: RepoRef,
    title: string,
    body: string
  ): ReturnType<ForgeProvider['createIssue']> {
    return (await this.forRepo(repo)).createIssue(repo, title, body);
  }

  async createDraftPr(
    repo: RepoRef,
    head: string,
    base: string,
    title: string,
    body: string
  ): ReturnType<ForgeProvider['createDraftPr']> {
    return (await this.forRepo(repo)).createDraftPr(repo, head, base, title, body);
  }

  async listOpenPrsByHead(
    repo: RepoRef,
    head: string
  ): ReturnType<ForgeProvider['listOpenPrsByHead']> {
    return (await this.forRepo(repo)).listOpenPrsByHead(repo, head);
  }

  async addIssueComment(
    repo: RepoRef,
    issue: number,
    body: string
  ): ReturnType<ForgeProvider['addIssueComment']> {
    return (await this.forRepo(repo)).addIssueComment(repo, issue, body);
  }

  async addIssueLabels(
    repo: RepoRef,
    issue: number,
    slugs: string[]
  ): ReturnType<ForgeProvider['addIssueLabels']> {
    return (await this.forRepo(repo)).addIssueLabels(repo, issue, slugs);
  }

  async getBranchProtection(
    repo: RepoRef,
    branch: string
  ): ReturnType<ForgeProvider['getBranchProtection']> {
    return (await this.forRepo(repo)).getBranchProtection(repo, branch);
  }

  async enableBranchProtection(
    repo: RepoRef,
    branch: string,
    requiredCheck: string
  ): ReturnType<ForgeProvider['enableBranchProtection']> {
    return (await this.forRepo(repo)).enableBranchProtection(repo, branch, requiredCheck);
  }

  async getRepoAutomerge(repo: RepoRef): ReturnType<ForgeProvider['getRepoAutomerge']> {
    return (await this.forRepo(repo)).getRepoAutomerge(repo);
  }

  async enableRepoAutomerge(
    repo: RepoRef
  ): ReturnType<ForgeProvider['enableRepoAutomerge']> {
    return (await this.forRepo(repo)).enableRepoAutomerge(repo);
  }

  async listRepoLabels(repo: RepoRef): ReturnType<ForgeProvider['listRepoLabels']> {
    return (await this.forRepo(repo)).listRepoLabels(repo);
  }

  async ensureRepoLabels(
    repo: RepoRef,
    specs: TagSpec[]
  ): ReturnType<ForgeProvider['ensureRepoLabels']> {
    return (await this.forRepo(repo)).ensureRepoLabels(repo, specs);
  }
}
