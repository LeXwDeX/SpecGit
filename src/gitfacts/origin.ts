import { fail, ok, type Evidence } from '../kernel/evidence.js';

export interface RepoRef {
  owner: string;
  repo: string;
}

/**
 * Bounded structural facts for a git origin URL (#83).
 *
 * Single pass, no regex: every step is an indexOf/slice/charCodeAt scan,
 * so no input can trigger polynomial backtracking. Inputs are capped
 * (URL ≤ MAX_ORIGIN_URL_LENGTH, host ≤ MAX_ORIGIN_HOST_LENGTH) and
 * anything malformed — including caps exceeded — fails closed to null.
 * Only the host component is ever returned; userinfo (credentials),
 * path, query, and fragment are structurally excluded, so a token such
 * as "github.com" reachable only through them can never pose as a host.
 */
export interface OriginUrlParts {
  /** Lowercased scheme without "://" (e.g. "https"), or null for the scp-like form. */
  scheme: string | null;
  /** Lowercased host component, charset-validated ([a-z0-9.-]). */
  host: string;
  /** Explicit port digits for scheme URLs, null when absent (scp has no port). */
  port: string | null;
}

const MAX_ORIGIN_HOST_LENGTH = 255;
const MAX_PORT_LENGTH = 5;

export function extractOriginHost(originUrl: string): OriginUrlParts | null {
  const url = originUrl.trim().toLowerCase();
  if (url.length === 0 || url.length > MAX_ORIGIN_URL_LENGTH) return null;

  const schemeEnd = url.indexOf('://');
  if (schemeEnd === 0) return null;

  let scheme: string | null;
  let rest: string;
  if (schemeEnd > 0) {
    scheme = url.slice(0, schemeEnd);
    if (!isValidScheme(scheme)) return null;
    rest = url.slice(schemeEnd + 3);
  } else {
    scheme = null;
    rest = url;
  }

  // The authority ends at the first path/query/fragment delimiter. For
  // the scp-like form the same scan stops before the path, leaving
  // "host:path" (with optional userinfo) to be split on its colon below.
  let authorityEnd = rest.length;
  for (const delimiter of ['/', '?', '#']) {
    const idx = rest.indexOf(delimiter);
    if (idx >= 0 && idx < authorityEnd) authorityEnd = idx;
  }
  const authority = rest.slice(0, authorityEnd);
  if (authority.length === 0) return null;

  // Userinfo is everything before the last '@' — credentials, never host.
  const at = authority.lastIndexOf('@');
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority;

  let host: string;
  let port: string | null = null;
  const colon = hostPort.indexOf(':');
  if (scheme === null) {
    if (colon < 0) return null; // schemeless without "host:" is not an origin
    host = hostPort.slice(0, colon);
  } else if (colon >= 0) {
    host = hostPort.slice(0, colon);
    port = hostPort.slice(colon + 1);
    if (port.length === 0 || port.length > MAX_PORT_LENGTH || !isAllDigits(port)) return null;
  } else {
    host = hostPort;
  }

  if (!isValidHost(host)) return null;
  return { scheme, host, port };
}

function isValidScheme(scheme: string): boolean {
  const first = scheme.charCodeAt(0);
  if (first < 97 /* a */ || first > 122 /* z */) return false;
  for (let i = 1; i < scheme.length; i++) {
    const c = scheme.charCodeAt(i);
    const ok =
      (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 /* + */ || c === 45 /* - */ || c === 46; /* . */
    if (!ok) return false;
  }
  return true;
}

function isValidHost(host: string): boolean {
  if (host.length === 0 || host.length > MAX_ORIGIN_HOST_LENGTH) return false;
  for (let i = 0; i < host.length; i++) {
    const c = host.charCodeAt(i);
    const ok = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 46 /* . */ || c === 45; /* - */
    if (!ok) return false;
  }
  return true;
}

function isAllDigits(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 48 /* 0 */ || c > 57 /* 9 */) return false;
  }
  return true;
}

// Origin classification is structural, never substring-based over the raw
// URL: the host is extracted per shape (https/ssh URL, or scp-like
// `user@host:path`) and only then compared, so `github.com` can never match
// in userinfo, path, query, or an attacker-controlled host suffix. All
// parsing is linear-time and front-loaded with hard length caps, so no
// input can trigger pathological backtracking.
const MAX_ORIGIN_URL_LENGTH = 4096;
const MAX_HOST_LENGTH = 253;

const SCHEME_PREFIX = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const HOSTNAME_CHARS = /^[a-z0-9.-]+$/;

type UrlShape = {
  kind: 'url';
  scheme: 'https' | 'ssh';
  host: string;
  port: string;
  username: string;
  password: string;
  path: string;
};

type ScpShape = {
  kind: 'scp';
  user: string;
  host: string;
  path: string;
};

type OriginShape = UrlShape | ScpShape;

export function parseRepoRef(
  originUrl: string,
  options: { gitlabHost?: string } = {}
): Evidence<RepoRef> {
  const url = originUrl.trim();
  if (!url) {
    return fail(
      'origin_unresolvable',
      'The origin remote has an empty URL.',
      'Point origin at a github.com repository.'
    );
  }
  if (url.length > MAX_ORIGIN_URL_LENGTH) {
    return fail(
      'origin_unresolvable',
      `Origin "${truncateUrl(url)}" is longer than ${MAX_ORIGIN_URL_LENGTH} characters and is rejected without classification.`,
      'Shorten or fix the origin remote URL; real GitHub and GitLab origins are far below this limit.'
    );
  }

  const declaredHost = normalizeDeclaredHost(options.gitlabHost);
  const shape = parseOriginShape(url);
  const repo = shape ? parseOwnerRepo(shape.path, shape.kind === 'url') : null;

  if (shape && repo) {
    if (isGitHubOrigin(shape)) {
      return ok(repo);
    }
    // A GitLab origin is a recognized-but-unsupported platform, not an
    // unresolvable URL: the diagnostic names the actual gap. The
    // "gitlab" heuristic is contained to the structurally extracted host
    // (fail-closed diagnostic either way); any other self-hosted host
    // counts only when the user declared it (providers.yaml).
    if (isGitLabHeuristic(shape) || isDeclaredGitLab(shape, declaredHost)) {
      return fail(
        'gitlab_unsupported',
        `Origin "${truncateUrl(url)}" points at a GitLab repository; GitLab evidence (issues, MRs, pipelines) requires glab support, which is not implemented yet.`,
        'Declare the platform with "specgit init --gitlab-host <hostname>" and see docs/gitlab-support.md for the glab roadmap.'
      );
    }
  }

  return fail(
    'origin_unresolvable',
    `Origin "${truncateUrl(url)}" does not point at a github.com repository.`,
    'Point origin at a github.com repository (https or ssh), or declare a GitLab host via "specgit init --gitlab-host <hostname>".'
  );
}

function parseOriginShape(url: string): OriginShape | null {
  const scheme = SCHEME_PREFIX.exec(url)?.[1]?.toLowerCase();
  if (scheme === 'https' || scheme === 'ssh') {
    return parseUrlShape(url, scheme);
  }
  return parseScpShape(url);
}

function parseUrlShape(url: string, scheme: 'https' | 'ssh'): UrlShape | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // Query and fragment are attacker-controlled surfaces that never carry
  // origin identity; their presence makes the URL unclassifiable.
  if (parsed.search !== '' || parsed.hash !== '') {
    return null;
  }
  // Non-special schemes (ssh) keep their original host casing; normalize
  // so host comparison is exact and case-insensitive.
  const host = parsed.hostname.toLowerCase();
  if (!isPlausibleHostname(host)) {
    return null;
  }
  return {
    kind: 'url',
    scheme,
    host,
    port: parsed.port,
    username: parsed.username,
    password: parsed.password,
    path: parsed.pathname,
  };
}

function parseScpShape(url: string): ScpShape | null {
  const colon = url.indexOf(':');
  if (colon <= 0) {
    return null;
  }
  const authority = url.slice(0, colon);
  const path = url.slice(colon + 1);
  // Everything after the last `@` is the host; earlier `@` signs belong to
  // the user part, so `git@github.com@evil.com:o/r` resolves to host
  // evil.com and cannot smuggle github.com.
  const at = authority.lastIndexOf('@');
  const user = at === -1 ? '' : authority.slice(0, at);
  const host = (at === -1 ? authority : authority.slice(at + 1)).toLowerCase();
  if (!isPlausibleHostname(host)) {
    return null;
  }
  return { kind: 'scp', user, host, path };
}

function isPlausibleHostname(host: string): boolean {
  return host.length >= 1 && host.length <= MAX_HOST_LENGTH && HOSTNAME_CHARS.test(host);
}

function parseOwnerRepo(path: string, urlTrack: boolean): RepoRef | null {
  let work = path;
  if (urlTrack) {
    if (!work.startsWith('/')) {
      return null;
    }
    work = work.slice(1);
    if (work.endsWith('/')) {
      work = work.slice(0, -1);
    }
  } else if (work.startsWith('/') || work.endsWith('/')) {
    return null;
  }
  const segments = work.split('/');
  if (segments.length !== 2 || segments[0] === '' || segments[1] === '') {
    return null;
  }
  const owner = segments[0];
  let repo = segments[1];
  if (repo.length > 4 && repo.endsWith('.git')) {
    repo = repo.slice(0, -4);
  }
  return { owner, repo };
}

// GitHub requires an exact structural host match. On the https track any
// userinfo disqualifies; on the ssh track the user must be `git` with no
// password (matching git's own convention); the scp track requires the
// exact `git` user.
function isGitHubOrigin(shape: OriginShape): boolean {
  if (shape.kind === 'scp') {
    return shape.user === 'git' && shape.host === 'github.com';
  }
  return shape.host === 'github.com' && shape.port === '' && urlUserAllowed(shape);
}

function isGitLabHeuristic(shape: OriginShape): boolean {
  if (shape.kind === 'scp') {
    return shape.user === 'git' && shape.host.includes('gitlab');
  }
  return shape.host.includes('gitlab') && shape.port === '' && urlUserAllowed(shape);
}

function isDeclaredGitLab(shape: OriginShape, declaredHost: string | undefined): boolean {
  if (declaredHost === undefined || shape.host !== declaredHost) {
    return false;
  }
  if (shape.kind === 'scp') {
    return shape.user === '' || shape.user.toLowerCase() === 'git';
  }
  return shape.port === '' && urlUserAllowed(shape);
}

function urlUserAllowed(shape: UrlShape): boolean {
  if (shape.password !== '') {
    return false;
  }
  return shape.scheme === 'https' ? shape.username === '' : shape.username.toLowerCase() === 'git';
}

function normalizeDeclaredHost(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

export function formatRepoRef(repo: RepoRef): string {
  return `${repo.owner}/${repo.repo}`;
}

export function sameRepoRef(a: RepoRef, b: RepoRef): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
}

export function parsePrUrl(url: string): Evidence<{ repo: RepoRef; pr: number }> {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/i.exec(url.trim());
  if (!match) {
    return fail(
      'pr_not_found',
      `"${truncateUrl(url)}" is not a github.com pull request URL.`,
      'Bind the PR by number or a full https://github.com/<owner>/<repo>/pull/<n> URL.'
    );
  }
  return ok({ repo: { owner: match[1], repo: match[2] }, pr: Number(match[3]) });
}

function truncateUrl(value: string): string {
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
}
