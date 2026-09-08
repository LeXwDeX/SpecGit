import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GlabProvider } from '../../src/providers/gitlab/glab-cli.js';
import { createFakeGlab, readFakeGlabCalls } from './helpers/fake-glab.js';
import { makeTempDir, rmDir } from './helpers/temp-repo.js';

const repo = { owner: 'group', repo: 'project', platform: 'gitlab' } as const;

describe('GitLab catalog label colors', () => {
  let root: string;
  beforeEach(() => { root = makeTempDir('specgit-glab-label-'); });
  afterEach(() => { rmDir(root); });

  it('converts a portable six-digit color to the CSS hex value GitLab accepts', async () => {
    const fake = createFakeGlab(root, [
      { match: 'labels\\?per_page=100', stdout: '[]' },
      { match: 'POST .*labels -f name=kind::test -f color=#D4C5F9$', stdout: '{"name":"kind::test"}' },
      { match: 'POST .*labels', exit: 1, stderr: 'color must be a valid color code' },
    ]);
    const provider = new GlabProvider({ env: fake.env(), hostname: 'git.example.com' });
    expect(await provider.ensureRepoLabels(repo, [{ name: 'kind::test', color: 'D4C5F9' }])).toEqual({
      ok: true, value: { names: ['kind::test'] },
    });
    expect(readFakeGlabCalls(fake.logPath).some((call) => call.includes('color=#D4C5F9'))).toBe(true);
  });

  it('preserves an existing label instead of recreating or recoloring it on resume', async () => {
    const fake = createFakeGlab(root, [
      { match: 'labels\\?per_page=100', stdout: '[{"name":"kind::test","color":"#000000"}]' },
    ]);
    const provider = new GlabProvider({ env: fake.env(), hostname: 'git.example.com' });
    expect(await provider.ensureRepoLabels(repo, [{ name: 'kind::test', color: 'D4C5F9' }])).toEqual({
      ok: true, value: { names: ['kind::test'] },
    });
    expect(readFakeGlabCalls(fake.logPath)).toHaveLength(1);
  });
});
