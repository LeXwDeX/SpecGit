import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { reuseApi } from '../../src/providers/reuse-api.js';

describe('native reuse evidence transport', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('permits the GitLab current-job identity endpoint through the authenticated CLI', async () => {
    vi.stubEnv('GITLAB_CI', 'true');
    const calls: string[][] = [];
    const api = reuseApi('gitlab', 'gitlab.example.com', async (command, args) => {
      calls.push([command, ...args]); return { stdout: '{"id":7}', stderr: '' };
    });
    expect(await api('job')).toEqual({ ok: true, value: { id: 7 } });
    expect(calls).toEqual([['glab', 'api', '--hostname', 'gitlab.example.com', 'job']]);
  });

  it('keeps user authentication out of native job identity while retaining it for other evidence', async () => {
    vi.stubEnv('GITLAB_CI', 'true');
    vi.stubEnv('CI_JOB_TOKEN', 'synthetic-job-session');
    for (const key of ['GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN', 'OAUTH_TOKEN']) vi.stubEnv(key, 'synthetic-user-session');
    vi.stubEnv('GLAB_CONFIG_DIR', '/synthetic-user-config');
    let directory = '';
    const api = reuseApi('gitlab', 'gitlab.example.com', async (_command, args, options) => {
      if (args.at(-1) === 'job') {
        directory = options.cwd!;
        expect(options.env?.GLAB_CONFIG_DIR).toBe(directory);
        expect(readFileSync(path.join(directory, 'config.yml'), 'utf8')).toBe('hosts: {}\n');
        for (const key of ['GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN', 'OAUTH_TOKEN']) expect(options.env).not.toHaveProperty(key);
        expect(options.env?.CI_JOB_TOKEN).toBe('synthetic-job-session');
        expect(options.env?.GLAB_ENABLE_CI_AUTOLOGIN).toBe('true');
      } else {
        expect(options.env).toBeUndefined();
        expect(options.cwd).toBeUndefined();
      }
      return { stdout: '{}', stderr: '' };
    });
    expect((await api('job')).ok).toBe(true);
    expect(existsSync(directory)).toBe(false);
    expect((await api('projects/group%2Fproject/pipelines/100')).ok).toBe(true);
    expect(process.env.GITLAB_TOKEN).toBe('synthetic-user-session');
    expect(process.env.GLAB_CONFIG_DIR).toBe('/synthetic-user-config');
  });

  it('resolves a relative configured executable before isolating native job identity', async () => {
    vi.stubEnv('GITLAB_CI', 'true');
    vi.stubEnv('SPECGIT_GLAB', './tools/glab');
    const calls: Array<{ command: string; cwd?: string }> = [];
    const api = reuseApi('gitlab', 'gitlab.example.com', async (command, _args, options) => {
      calls.push({ command, cwd: options.cwd });
      return { stdout: '{}', stderr: '' };
    });
    expect((await api('job')).ok).toBe(true);
    expect(calls[0].command).toBe(path.resolve('tools/glab'));
    expect(calls[0].cwd).not.toBe(process.cwd());
    expect((await api('projects/group%2Fproject/pipelines/100')).ok).toBe(true);
    expect(calls[1]).toEqual({ command: './tools/glab', cwd: undefined });
  });

  it('refuses non-CI job identity and cleans isolated configuration after transport failure', async () => {
    vi.stubEnv('GITLAB_CI', 'false');
    let directory = '';
    const api = reuseApi('gitlab', 'gitlab.example.com', async (_command, _args, options) => {
      directory = options.cwd!; throw new Error('private transport detail');
    });
    expect((await api('job')).ok).toBe(false);
    expect(directory).toBe('');
    vi.stubEnv('GITLAB_CI', 'true');
    expect((await api('job')).ok).toBe(false);
    expect(directory).not.toBe('');
    expect(existsSync(directory)).toBe(false);
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
