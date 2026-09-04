import { describe, expect, it, vi } from 'vitest';
import { GlabProvider } from '../../src/providers/gitlab/glab-cli.js';

const repo = { platform: 'gitlab' as const, owner: 'group/subgroup', repo: 'project' };

describe('GitLab CI configuration source evidence', () => {
  it.each([null, '.gitlab-ci.yml', 'custom/pipeline.yml'])('reports an explicit platform path %s through authenticated glab', async (path) => {
    const spawnImpl = vi.fn(async () => ({ stdout: JSON.stringify({ path_with_namespace: 'group/subgroup/project', ci_config_path: path }), stderr: '' }));
    const provider = new GlabProvider({ spawnImpl, glabCommand: 'glab' });
    expect(await provider.getCiConfigPath(repo)).toEqual({ ok: true, value: path });
    expect(spawnImpl.mock.calls[0]).toBeDefined();
  });
  it.each([{ path_with_namespace: 'other/project', ci_config_path: null }, { path_with_namespace: 'group/subgroup/project' }])('rejects mismatched or missing configuration evidence', async (payload) => {
    const provider = new GlabProvider({ glabCommand: 'glab', spawnImpl: async () => ({ stdout: JSON.stringify(payload), stderr: '' }) });
    expect(await provider.getCiConfigPath(repo)).toMatchObject({ ok: false, code: 'glab_transport' });
  });
});
