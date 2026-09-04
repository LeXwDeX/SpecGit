import { extractOriginHost } from '../gitfacts/origin.js';
import type { Evidence } from '../kernel/evidence.js';
import type { Providers } from '../record/providers.js';

export interface OriginEndpoint {
  host: string;
  port: string | null;
  defaultPort: string;
}

/** Structural host and port facts for adoption; this does not resolve a repository. */
export function originEndpoint(originUrl: string): OriginEndpoint | null {
  const parts = extractOriginHost(originUrl);
  if (parts === null) return null;
  if (parts.scheme !== null && parts.scheme !== 'https' && parts.scheme !== 'ssh') return null;
  return { host: parts.host, port: parts.port, defaultPort: parts.scheme === 'https' ? '443' : '22' };
}

export function endpointEffectivePort(endpoint: OriginEndpoint): string {
  return endpoint.port ?? endpoint.defaultPort;
}

export function endpointUsesDefaultPort(endpoint: OriginEndpoint): boolean {
  return endpointEffectivePort(endpoint) === endpoint.defaultPort;
}

export function declaredEndpointName(host: string, port: string | null): string {
  return port !== null ? `${host}:${port}` : host;
}

export type HarnessPlatformDecision =
  | { mode: 'providers_invalid'; message: string }
  | { mode: 'gitlab'; source: 'providers' | 'origin'; declaration: { host: string; port: string | null } }
  | { mode: 'github' }
  | { mode: 'undecided'; endpoint: OriginEndpoint | null; hasOrigin: boolean };

export type PlatformClassification = HarnessPlatformDecision['mode'];

/**
 * Shared init/status decision over already-read inputs. A GitLab origin hint
 * proposes adoption only; parseRepoRef still requires an explicit declaration
 * before it can grant GitLab capabilities. No I/O, prompts, or persistence.
 */
export function classifyHarnessPlatform(input: {
  originUrl: string | null;
  providers: Evidence<Providers>;
}): HarnessPlatformDecision {
  const { providers, originUrl } = input;
  if (!providers.ok && providers.code === 'providers_invalid') {
    return { mode: 'providers_invalid', message: providers.message };
  }
  if (providers.ok && providers.value.gitlab !== undefined) {
    const { host, port } = providers.value.gitlab;
    return { mode: 'gitlab', source: 'providers', declaration: { host, port: port ?? null } };
  }
  const endpoint = originUrl ? originEndpoint(originUrl) : null;
  if (endpoint !== null && endpointUsesDefaultPort(endpoint)) {
    if (endpoint.host === 'github.com') return { mode: 'github' };
    if (/(^|\.)gitlab/i.test(endpoint.host)) {
      return { mode: 'gitlab', source: 'origin', declaration: { host: endpoint.host, port: null } };
    }
  }
  return { mode: 'undecided', endpoint, hasOrigin: Boolean(originUrl) };
}
