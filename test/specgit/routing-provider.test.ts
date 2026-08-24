import { describe, expect, it } from 'vitest';

import type { RepoRef } from '../../src/gitfacts/origin.js';
import { PlatformRoutingProvider } from '../../src/providers/routing.js';
import { MockForgeProvider } from './helpers/mock-forge.js';

// #117 (platform routing): the production context hands commands ONE
// provider. The routing provider dispatches per call — a ref resolved
// through the GitLab declaration (the platform marker) goes to the glab
// delegate, everything else to the github delegate — so the #112
// invariant ("no gh call ever sees a group/subgroup ref") is preserved
// by construction while GitLab deliveries route to glab.

const githubRef: RepoRef = { owner: 'acme', repo: 'app', platform: 'github' };
const gitlabRef: RepoRef = { owner: 'group/subgroup', repo: 'app', platform: 'gitlab' };

function makeRouter(originPlatform: 'github' | 'gitlab' | 'undecided') {
  const github = new MockForgeProvider();
  const gitlab = new MockForgeProvider();
  let constructions = 0;
  const router = new PlatformRoutingProvider({
    github,
    gitlab: async () => {
      constructions += 1;
      return gitlab;
    },
    originPlatform: async () => originPlatform,
  });
  return { github, gitlab, router, constructions: () => constructions };
}

describe('PlatformRoutingProvider (#117)', () => {
  it('routes every repo-carrying call by the ref platform marker', async () => {
    const { github, gitlab, router } = makeRouter('github');

    await router.getIssue(gitlabRef, 7);
    await router.getOpenIssues(gitlabRef);
    await router.getOpenIssueNumbers(gitlabRef);
    await router.getPr(gitlabRef, 9);
    await router.getCheckRuns(gitlabRef, 'a'.repeat(40));
    await router.getEvidenceAnchor(gitlabRef, 9);
    await router.createIssue(gitlabRef, 't', 'b');
    await router.createDraftPr(gitlabRef, 'head', 'main', 't', 'b');
    await router.listOpenPrsByHead(gitlabRef, 'head');
    await router.getBranchProtection(gitlabRef, 'main');
    await router.enableBranchProtection(gitlabRef, 'main', 'check');
    await router.getRepoAutomerge(gitlabRef);
    await router.enableRepoAutomerge(gitlabRef);

    // Every GitLab call reached the glab delegate…
    expect(gitlab.calls.length).toBe(13);
    // …and NO group/subgroup ref ever reached the github delegate (#112).
    expect(github.calls).toEqual([]);
  });

  it('routes github refs to the github delegate only', async () => {
    const { github, gitlab, router } = makeRouter('gitlab');

    await router.getIssue(githubRef, 7);
    await router.getPr(githubRef, 9);
    await router.getCheckRuns(githubRef, 'a'.repeat(40));

    expect(github.calls.length).toBe(3);
    expect(gitlab.calls).toEqual([]);
  });

  it('preflight follows the resolved origin platform', async () => {
    const gitlabOrigin = makeRouter('gitlab');
    await gitlabOrigin.router.preflight();
    expect(gitlabOrigin.gitlab.calls).toEqual(['preflight']);
    expect(gitlabOrigin.github.calls).toEqual([]);

    const githubOrigin = makeRouter('github');
    await githubOrigin.router.preflight();
    expect(githubOrigin.github.calls).toEqual(['preflight']);
    expect(githubOrigin.gitlab.calls).toEqual([]);
  });

  it('an undecided origin preflights the github provider (today\'s behavior)', async () => {
    const { github, gitlab, router } = makeRouter('undecided');
    await router.preflight();
    expect(github.calls).toEqual(['preflight']);
    expect(gitlab.calls).toEqual([]);
  });

  it('delegates results and failures unchanged', async () => {
    const { router } = makeRouter('gitlab');
    const issue = await router.getIssue(gitlabRef, 7);
    expect(issue).toEqual({
      ok: true,
      value: { number: 7, state: 'open', pullRequest: false },
    });
  });

  it('routes getEvidenceAnchor per platform and delegates its evidence unchanged (#315)', async () => {
    // GitHub-shaped delegate enforces a boundary; GitLab-shaped delegate
    // sets none — both flow through the dispatch untouched.
    const github = new MockForgeProvider({
      evidenceAnchor: { ok: true, value: { anchoredAt: '2026-08-23T10:52:06Z' } },
    });
    const gitlab = new MockForgeProvider();
    const router = new PlatformRoutingProvider({
      github,
      gitlab: async () => gitlab,
      originPlatform: async () => 'github',
    });

    const ghAnchor = await router.getEvidenceAnchor(githubRef, 317);
    expect(ghAnchor).toEqual({ ok: true, value: { anchoredAt: '2026-08-23T10:52:06Z' } });

    const glAnchor = await router.getEvidenceAnchor(gitlabRef, 9);
    expect(glAnchor).toEqual({ ok: true, value: { anchoredAt: null } });

    expect(github.calls).toEqual(['getEvidenceAnchor:acme/app#317']);
    expect(gitlab.calls).toEqual(['getEvidenceAnchor:group/subgroup/app#9']);

    // A failed anchor Evidence fails closed through the dispatch with
    // the delegate's own code — never flattened, never swallowed.
    const failing = new MockForgeProvider({
      evidenceAnchor: { ok: false, code: 'gh_transport', message: 'down' },
    });
    const failingRouter = new PlatformRoutingProvider({
      github: failing,
      gitlab: async () => failing,
      originPlatform: async () => 'github',
    });
    const failed = await failingRouter.getEvidenceAnchor(githubRef, 317);
    expect(failed).toEqual({ ok: false, code: 'gh_transport', message: 'down' });
  });

  it('resolves the origin platform once across repo-less calls', async () => {
    let resolutions = 0;
    const github = new MockForgeProvider();
    const router = new PlatformRoutingProvider({
      github,
      gitlab: async () => new MockForgeProvider(),
      originPlatform: async () => {
        resolutions += 1;
        return 'github';
      },
    });
    await router.preflight();
    await router.preflight();
    expect(resolutions).toBe(1);
  });

  it('constructs the glab delegate lazily, at most once', async () => {
    const { gitlab, router, constructions } = makeRouter('gitlab');
    expect(constructions()).toBe(0);
    await router.getIssue(gitlabRef, 7);
    await router.getPr(gitlabRef, 9);
    expect(constructions()).toBe(1);
    expect(gitlab.calls.length).toBe(2);
  });
});
