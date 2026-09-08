import { fail, ok, type Evidence } from '../kernel/evidence.js';
import { defaultSpawn, type SpawnFn } from './cli-spawn.js';

export type ReuseApi = (endpoint: string, format?: 'json' | 'text') => Promise<Evidence<unknown>>;

/** Read-only evidence through the configured CLI session; errors never include credential-bearing output. */
export function reuseApi(platform: 'github' | 'gitlab', host: string, spawn: SpawnFn = defaultSpawn): ReuseApi {
  return async (endpoint, format = 'json') => {
    try {
      if (!/^[a-z0-9.-]+(?::[0-9]+)?$/i.test(host) || host.startsWith('-') ||
          (endpoint.startsWith('https://') && new URL(endpoint).host !== host) ||
          (!endpoint.startsWith('https://') && !/^(?:repos|projects)\//.test(endpoint) && !(platform === 'gitlab' && endpoint === 'job'))) throw new Error('Invalid evidence location');
      const command = platform === 'github' ? process.env.SPECGIT_GH ?? 'gh' : process.env.SPECGIT_GLAB ?? 'glab';
      const result = await spawn(command, ['api', '--hostname', host, endpoint], {
        timeoutMs: 15_000, maxBuffer: 2 * 1024 * 1024,
      });
      return ok(format === 'text' ? result.stdout : JSON.parse(result.stdout));
    } catch {
      return fail('verification_reuse_transport_unavailable', 'Original execution evidence is unavailable through the authenticated provider CLI.');
    }
  };
}
