import { describe, expect, it } from 'vitest';
import { GhCliGitHubProvider } from '../../src/providers/github/gh-cli.js';
import { GlabProvider } from '../../src/providers/gitlab/glab-cli.js';
import type { SpawnFn } from '../../src/kernel/spawn.js';

const githubRepo = { owner: 'owner', repo: 'project', platform: 'github' } as const;
const gitlabRepo = { owner: 'group/nested', repo: 'project', platform: 'gitlab' } as const;
const spawnFor = (payload: unknown): SpawnFn => async () => ({ stdout: JSON.stringify(payload), stderr: '' });

describe('forge title and label evidence (#407)', () => {
  it.each(['github', 'gitlab'] as const)('returns actual %s issue metadata', async (platform) => {
    const labels = ['kind::fix', 'area::delivery'];
    const payload = platform === 'github'
      ? { number: 7, state: 'open', title: 'fix: repair evidence', labels: labels.map((name) => ({ name })) }
      : { iid: 7, state: 'opened', title: 'fix: repair evidence', labels };
    const provider = platform === 'github'
      ? new GhCliGitHubProvider({ spawnImpl: spawnFor(payload) })
      : new GlabProvider({ spawnImpl: spawnFor(payload) });
    expect(await provider.getIssue(platform === 'github' ? githubRepo : gitlabRepo, 7)).toMatchObject({
      ok: true, value: { title: 'fix: repair evidence', labels },
    });
  });

  it.each(['github', 'gitlab'] as const)('keeps absent %s labels unknown rather than an empty pool', async (platform) => {
    const payload = platform === 'github' ? { number: 7, state: 'open' } : { iid: 7, state: 'opened' };
    const provider = platform === 'github'
      ? new GhCliGitHubProvider({ spawnImpl: spawnFor(payload) })
      : new GlabProvider({ spawnImpl: spawnFor(payload) });
    const fact = await provider.getIssue(platform === 'github' ? githubRepo : gitlabRepo, 7);
    expect(fact).toMatchObject({ ok: true });
    if (fact.ok) expect(fact.value.labels).toBeUndefined();
  });

  it.each(['github', 'gitlab'] as const)('does not expose partial %s label evidence', async (platform) => {
    const payload = platform === 'github'
      ? { number: 7, state: 'open', labels: [{ name: 'kind::fix' }, null] }
      : { iid: 7, state: 'opened', labels: ['kind::fix', null] };
    const provider = platform === 'github'
      ? new GhCliGitHubProvider({ spawnImpl: spawnFor(payload) })
      : new GlabProvider({ spawnImpl: spawnFor(payload) });
    const fact = await provider.getIssue(platform === 'github' ? githubRepo : gitlabRepo, 7);
    expect(fact).toMatchObject({ ok: true });
    if (fact.ok) expect(fact.value.labels).toBeUndefined();
  });

  it.each(['github', 'gitlab'] as const)('returns the actual %s request title', async (platform) => {
    const payload = platform === 'github'
      ? { number: 7, state: 'open', draft: false, title: 'fix: repair evidence' }
      : { iid: 7, state: 'opened', draft: false, title: 'fix: repair evidence' };
    const provider = platform === 'github'
      ? new GhCliGitHubProvider({ spawnImpl: spawnFor(payload) })
      : new GlabProvider({ spawnImpl: spawnFor(payload) });
    expect(await provider.getPr(platform === 'github' ? githubRepo : gitlabRepo, 7)).toMatchObject({
      ok: true, value: { title: 'fix: repair evidence' },
    });
  });
});
