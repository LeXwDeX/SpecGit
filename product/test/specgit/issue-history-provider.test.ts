import { describe, expect, it } from 'vitest';
import { GhCliGitHubProvider } from '../../src/providers/github/gh-cli.js';
import { GlabProvider } from '../../src/providers/gitlab/glab-cli.js';
import type { SpawnFn } from '../../src/kernel/spawn.js';
import type { RepoRef } from '../../src/gitfacts/origin.js';

const github: RepoRef = { owner: 'acme', repo: 'app', platform: 'github' };
const gitlab: RepoRef = { owner: 'group/sub', repo: 'app', platform: 'gitlab' };
const ghIssue = (number: number, state = 'open') => ({ number, state, title: 'retry delivery', body: 'Specific WHY', html_url: `https://github.com/acme/app/issues/${number}` });
const glIssue = (iid: number, state = 'opened') => ({ iid, state, title: 'retry delivery', description: 'Specific WHY', web_url: `https://git.example.com/group/sub/app/-/issues/${iid}` });
const ghPr = (number: number) => ({ number, state: 'open', draft: true, head: { ref: 'other', sha: 'a'.repeat(40) }, base: { ref: 'main' }, body: 'Closes #7' });
const glPr = (iid: number) => ({ iid, state: 'opened', draft: true, source_branch: 'other', target_branch: 'main', sha: 'a'.repeat(40), description: 'Closes #7' });

function setup(platform: 'github' | 'gitlab', reply: (endpoint: string, call: number) => unknown) {
  const calls: string[][] = [];
  const spawnImpl: SpawnFn = async (_command, args) => {
    calls.push(args);
    const payload = reply(args.at(-1)!, calls.length);
    return { stdout: JSON.stringify(payload), stderr: '' };
  };
  return { calls, provider: platform === 'github'
    ? new GhCliGitHubProvider({ spawnImpl })
    : new GlabProvider({ spawnImpl, hostname: 'git.example.com' }), repo: platform === 'github' ? github : gitlab };
}

describe('provider issue history and related request evidence', () => {
  it.each(['github', 'gitlab'] as const)('%s searches open and closed history by scoped keywords and paginates', async (platform) => {
    const { provider, repo, calls } = setup(platform, (_endpoint, call) => {
      const items = call === 1 ? Array.from({ length: 100 }, (_, i) => platform === 'github' ? ghIssue(i + 1) : glIssue(i + 1))
        : [platform === 'github' ? ghIssue(101, 'closed') : glIssue(101, 'closed')];
      return platform === 'github' ? { incomplete_results: false, items } : items;
    });
    const result = await provider.searchIssueHistory(repo, 'retry delivery');
    expect(result.ok && result.value).toHaveLength(101);
    expect(result.ok && result.value.at(-1)?.state).toBe('closed');
    expect(calls).toHaveLength(2);
    expect(calls[0].at(-1)).toContain('retry%20delivery');
    expect(calls[0].at(-1)).not.toContain('is:open');
    if (platform === 'gitlab') expect(calls[0]).toContain('git.example.com');
  });

  it.each(['github', 'gitlab'] as const)('%s refuses a full history page at the cap and malformed facts', async (platform) => {
    const capped = setup(platform, () => {
      const items = Array.from({ length: 100 }, (_, i) => platform === 'github' ? ghIssue(i + 1) : glIssue(i + 1));
      return platform === 'github' ? { incomplete_results: false, items } : items;
    });
    expect(await capped.provider.searchIssueHistory(capped.repo, 'retry')).toMatchObject({ ok: false, code: 'evidence_truncated' });
    const malformed = setup(platform, () => platform === 'github' ? { incomplete_results: false, items: [{}] } : [{}]);
    expect(await malformed.provider.searchIssueHistory(malformed.repo, 'retry')).toMatchObject({ ok: false });
  });

  it('GitHub rejects explicitly incomplete search results', async () => {
    const { provider, repo } = setup('github', () => ({ incomplete_results: true, items: [] }));
    expect(await provider.searchIssueHistory(repo, 'retry')).toMatchObject({ ok: false, code: 'evidence_truncated' });
  });

  it('GitHub follows related request identities then refreshes their live bodies and state', async () => {
    const { provider, repo, calls } = setup('github', (endpoint) => endpoint.includes('/timeline?') ? [
      { event: 'cross-referenced', source: { issue: { number: 9, repository_url: 'https://api.github.com/repos/acme/app', pull_request: { url: 'https://api.github.com/repos/acme/app/pulls/9' } } } },
      { event: 'cross-referenced', source: { issue: { number: 10, repository_url: 'https://api.github.com/repos/acme/app' } } },
    ] : ghPr(9));
    expect(await provider.listIssuePullRequests(repo, 7)).toMatchObject({ ok: true, value: [{ number: 9, state: 'open', draft: true, body: 'Closes #7' }] });
    expect(calls.map((call) => call.at(-1))).toEqual(['repos/acme/app/issues/7/timeline?per_page=100&page=1', 'repos/acme/app/pulls/9']);
  });

  it('GitLab reads only the issue-related MR window and refreshes local request facts', async () => {
    const { provider, repo, calls } = setup('gitlab', (endpoint) => endpoint.includes('/related_merge_requests?') ? [
      { iid: 9, web_url: 'https://git.example.com/group/sub/app/-/merge_requests/9' },
    ] : glPr(9));
    expect(await provider.listIssuePullRequests(repo, 7)).toMatchObject({ ok: true, value: [{ number: 9, state: 'open', draft: true, body: 'Closes #7' }] });
    expect(calls.map((call) => call.at(-1))).toEqual(['projects/group%2Fsub%2Fapp/issues/7/related_merge_requests?per_page=100&page=1', 'projects/group%2Fsub%2Fapp/merge_requests/9']);
  });

  it.each(['github', 'gitlab'] as const)('%s never reports no occupancy from malformed or incomplete related-request pages', async (platform) => {
    const malformed = setup(platform, () => [{}]);
    expect(await malformed.provider.listIssuePullRequests(malformed.repo, 7)).toMatchObject({ ok: false });
    const capped = setup(platform, () => Array.from({ length: 100 }, () => platform === 'github' ? { event: 'commented' } : { iid: 9, web_url: 'https://git.example.com/group/sub/app/-/merge_requests/9' }));
    expect(await capped.provider.listIssuePullRequests(capped.repo, 7)).toMatchObject({ ok: false, code: 'evidence_truncated' });
  });

  it.each(['github', 'gitlab'] as const)('%s refuses unknown current request bodies rather than treating them as no closing references', async (platform) => {
    const { provider, repo } = setup(platform, (endpoint) => {
      if (endpoint.includes('/timeline?')) return [{ event: 'cross-referenced', source: { issue: { number: 9, repository_url: 'https://api.github.com/repos/acme/app', pull_request: { url: 'https://api.github.com/repos/acme/app/pulls/9' } } } }];
      if (endpoint.includes('/related_merge_requests?')) return [{ iid: 9, web_url: 'https://git.example.com/group/sub/app/-/merge_requests/9' }];
      return platform === 'github' ? { ...ghPr(9), body: undefined } : { ...glPr(9), description: undefined };
    });
    expect(await provider.listIssuePullRequests(repo, 7)).toMatchObject({ ok: false });
  });
});
