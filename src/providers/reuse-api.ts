import { fail, ok, type Evidence } from '../kernel/evidence.js';
import { defaultSpawn, type SpawnFn } from './cli-spawn.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type ReuseApi = (endpoint: string, format?: 'json' | 'text') => Promise<Evidence<unknown>>;

/** Read-only evidence through the configured CLI session; errors never include credential-bearing output. */
export function reuseApi(platform: 'github' | 'gitlab', host: string, spawn: SpawnFn = defaultSpawn): ReuseApi {
  return async (endpoint, format = 'json') => {
    let jobConfig: string | undefined;
    try {
      if (!/^[a-z0-9.-]+(?::[0-9]+)?$/i.test(host) || host.startsWith('-') ||
          (endpoint.startsWith('https://') && new URL(endpoint).host !== host) ||
          (!endpoint.startsWith('https://') && !/^(?:repos|projects)\//.test(endpoint) && !(platform === 'gitlab' && endpoint === 'job'))) throw new Error('Invalid evidence location');
      const command = platform === 'github' ? process.env.SPECGIT_GH ?? 'gh' : process.env.SPECGIT_GLAB ?? 'glab';
      let env: NodeJS.ProcessEnv | undefined;
      if (platform === 'gitlab' && endpoint === 'job') {
        if (process.env.GITLAB_CI !== 'true') throw new Error('Native job identity requires GitLab CI');
        // /job authenticates the executing job, not the user running finish.
        // Keep the inherited CI session; glab selects its native job token.
        // An empty, isolated config prevents stored user credentials winning.
        jobConfig = await mkdtemp(path.join(os.tmpdir(), 'specgit-job-identity-'));
        await writeFile(path.join(jobConfig, 'config.yml'), 'hosts: {}\n', { mode: 0o600 });
        env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
          !['GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN', 'OAUTH_TOKEN', 'GLAB_CONFIG_DIR',
            'GLAB_ENABLE_CI_AUTOLOGIN'].includes(key.toUpperCase())));
        env.GLAB_CONFIG_DIR = jobConfig;
        env.GLAB_ENABLE_CI_AUTOLOGIN = 'true';
      }
      const result = await spawn(command, ['api', '--hostname', host, endpoint], {
        timeoutMs: 15_000, maxBuffer: 2 * 1024 * 1024,
        ...(jobConfig ? { env, cwd: jobConfig } : {}),
      });
      return ok(format === 'text' ? result.stdout : JSON.parse(result.stdout));
    } catch {
      return fail('verification_reuse_transport_unavailable', 'Original execution evidence is unavailable through the authenticated provider CLI.');
    } finally {
      if (jobConfig) await rm(jobConfig, { recursive: true, force: true });
    }
  };
}
