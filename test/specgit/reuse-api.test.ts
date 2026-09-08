import { describe, expect, it } from 'vitest';
import { reuseApi } from '../../src/providers/reuse-api.js';

describe('native reuse evidence transport', () => {
  it('permits the GitLab current-job identity endpoint through the authenticated CLI', async () => {
    const calls: string[][] = [];
    const api = reuseApi('gitlab', 'gitlab.example.com', async (command, args) => {
      calls.push([command, ...args]); return { stdout: '{"id":7}', stderr: '' };
    });
    expect(await api('job')).toEqual({ ok: true, value: { id: 7 } });
    expect(calls).toEqual([['glab', 'api', '--hostname', 'gitlab.example.com', 'job']]);
  });

  it('preserves exact immutable file bytes even when the file itself is valid JSON', async () => {
    const content = '{ "name": "runtime" }\n';
    const api = reuseApi('gitlab', 'gitlab.example.com', async () => ({ stdout: content, stderr: '' }));
    expect(await api('projects/group%2Fproject/repository/files/lock.json/raw?ref=abc', 'text'))
      .toEqual({ ok: true, value: content });
  });

  it('rejects a foreign evidence host and does not expose provider error output', async () => {
    let calls = 0;
    const api = reuseApi('gitlab', 'gitlab.example.com', async () => { calls++; throw new Error('private diagnostic'); });
    expect((await api('https://other.example.com/data')).ok).toBe(false);
    expect(calls).toBe(0);
    const failure = await api('job');
    expect(failure.ok).toBe(false);
    expect(JSON.stringify(failure)).not.toContain('private diagnostic');
  });
});
