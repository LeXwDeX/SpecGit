/**
 * Origin platform classification (#279): shape + declared config →
 * platform marker. One reason to change lives here: a new platform or
 * a new declaration grammar. The classifier consumes an already-parsed
 * shape — it never looks at raw URL text, so classification tests need
 * no valid URL.
 *
 * GitHub requires an exact structural host match; GitLab acceptance
 * flows only from the user-owned declaration (#112) — the `*gitlab*`
 * heuristic is diagnostic-only and never resolves a ref.
 */

import type { OriginShape, UrlShape } from './origin-shape.js';
import { isPlausibleHostname } from './origin-shape.js';

// #78: the only explicit ports that classify are (a) the scheme default
// (443 https, 22 ssh) on any accepted host, and (b) a non-default port
// that the GitLab declaration itself names (host:port). Every other
// explicit port keeps the fail-closed rejection.
const DEFAULT_PORTS: Record<'https' | 'ssh', string> = { https: '443', ssh: '22' };

/** A declared GitLab endpoint: bare host, optional port. */
export interface DeclaredGitLab {
  host: string;
  port: string | null;
}

// On the https track any userinfo disqualifies; on the ssh track the
// user must be `git` with no password (matching git's own convention);
// the scp track requires the exact `git` user. Ports (#78): only the
// scheme default classifies — github.com never accepts a declared
// non-default port.
export function isGitHubOrigin(shape: OriginShape): boolean {
  if (shape.kind === 'scp') {
    return shape.user === 'git' && shape.host === 'github.com';
  }
  return shape.host === 'github.com' && urlPortAccepted(shape, null) && urlUserAllowed(shape);
}

export function isGitLabHeuristic(shape: OriginShape): boolean {
  if (shape.kind === 'scp') {
    return shape.user === 'git' && shape.host.includes('gitlab');
  }
  return shape.host.includes('gitlab') && urlPortAccepted(shape, null) && urlUserAllowed(shape);
}

export function isDeclaredGitLab(shape: OriginShape, declared: DeclaredGitLab | undefined): boolean {
  if (declared === undefined || shape.host !== declared.host) {
    return false;
  }
  if (shape.kind === 'scp') {
    // scp carries no port slot: it implies the ssh default, so only a
    // portless (or :22) declaration matches.
    return (
      (shape.user === '' || shape.user.toLowerCase() === 'git') &&
      portMatches(effectivePort(shape), declared.port, DEFAULT_PORTS.ssh)
    );
  }
  return urlPortAccepted(shape, declared.port) && urlUserAllowed(shape);
}

/**
 * The port a shape effectively connects on: the explicit digits when
 * present, else the scheme default (WHATWG URL parsing already strips an
 * explicit scheme default and scp has no port slot — it is ssh:22).
 */
function effectivePort(shape: OriginShape): string {
  if (shape.kind === 'scp') return DEFAULT_PORTS.ssh;
  return shape.port === '' ? DEFAULT_PORTS[shape.scheme] : shape.port;
}

/** URL-track port rule: default in, non-default only when declared. */
function urlPortAccepted(shape: UrlShape, declaredPort: string | null): boolean {
  return portMatches(effectivePort(shape), declaredPort, DEFAULT_PORTS[shape.scheme]);
}

/**
 * A port classifies when it equals the declared port (an explicit
 * host:port declaration matches only that port) or, without one, the
 * scheme default.
 */
function portMatches(port: string, declaredPort: string | null, schemeDefault: string): boolean {
  return declaredPort !== null ? port === declaredPort : port === schemeDefault;
}

function urlUserAllowed(shape: UrlShape): boolean {
  if (shape.password !== '') {
    return false;
  }
  return shape.scheme === 'https' ? shape.username === '' : shape.username.toLowerCase() === 'git';
}

/**
 * Parse a declared GitLab endpoint: `host` or `host:port` (the #78
 * declaration grammar; the port names the non-default port origins may
 * use). Malformed declarations never match — classification stays
 * fail-closed rather than guessing what was meant.
 */
export function normalizeDeclaredGitLab(value: string | undefined): DeclaredGitLab | undefined {
  const raw = value?.trim().toLowerCase();
  if (!raw) return undefined;
  const colon = raw.indexOf(':');
  if (colon === -1) {
    return isPlausibleHostname(raw) ? { host: raw, port: null } : undefined;
  }
  const host = raw.slice(0, colon);
  const port = raw.slice(colon + 1);
  if (!isPlausibleHostname(host)) return undefined;
  if (!/^\d{1,5}$/.test(port)) return undefined;
  return { host, port };
}
