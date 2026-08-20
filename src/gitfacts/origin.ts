import { fail, ok, type Evidence } from '../kernel/evidence.js';

export interface RepoRef {
  owner: string;
  repo: string;
  /**
   * Present (value `'gitlab'`) when the ref resolved through a GitLab
   * declaration in `spec_git/providers.yaml` (#112) — the only source of
   * GitLab acceptance: the `*gitlab*` host heuristic never resolves a
   * ref, so no substring match can grant capability. Absent means the
   * default github platform.
   */
  platform?: 'gitlab';
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
    // Mirror WHATWG URL normalization ("022" is port 22) so every
    // consumer of the seam answers the same port question the same way.
    port = port.replace(/^0+(?=\d)/, '');
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

// #78: the only explicit ports that classify are (a) the scheme default
// (443 https, 22 ssh) on any accepted host, and (b) a non-default port
// that the GitLab declaration itself names (host:port). Every other
// explicit port keeps the fail-closed rejection.
const DEFAULT_PORTS: Record<'https' | 'ssh', string> = { https: '443', ssh: '22' };

/** A declared self-hosted GitLab endpoint: bare host, optional port. */
interface DeclaredGitLab {
  host: string;
  port: string | null;
}

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

  const declared = normalizeDeclaredGitLab(options.gitlabHost);
  const shape = parseOriginShape(url);
  const repo = shape ? parseOwnerRepo(shape.path, shape.kind === 'url') : null;

  if (shape && repo && isGitHubOrigin(shape)) {
    return ok(repo);
  }

  // #112: a DECLARED host resolves through the GitLab origin grammar —
  // group[/subgroup…]/project at depth 2–5, URL-encoded `%2F`
  // separators included (the same grammar the projects API addresses a
  // full path with). Acceptance flows only from the user-owned
  // declaration; the `*gitlab*` heuristic never resolves a ref. A
  // well-formed but deeper path fails closed under gitlab_unsupported
  // naming the accepted bound; malformed paths fall through to the
  // unresolvable tail.
  if (shape && isDeclaredGitLab(shape, declared)) {
    const gitlabRef = parseGitLabPathRef(shape);
    if (gitlabRef === 'too-deep') {
      return fail(
        'gitlab_unsupported',
        `Origin "${truncateUrl(url)}" points at a GitLab repository whose project path exceeds the accepted depth (${GITLAB_PATH_MIN_SEGMENTS}–${GITLAB_PATH_MAX_SEGMENTS} path segments).`,
        'Move or re-clone the repository under a shallower group path; see docs/gitlab-support.md for the accepted origin grammar.'
      );
    }
    if (gitlabRef !== null) {
      return ok(gitlabRef.ref);
    }
  } else if (shape && isGitLabHeuristic(shape)) {
    // A GitLab origin is a recognized-but-unsupported platform, not an
    // unresolvable URL: the diagnostic names the actual gap. The
    // "gitlab" heuristic is contained to the structurally extracted host
    // (fail-closed diagnostic either way); without a declaration it
    // never resolves a ref — declaring the platform (providers.yaml) is
    // the only route to GitLab acceptance (#112).
    if (repo) {
      return fail(
        'gitlab_unsupported',
        `Origin "${truncateUrl(url)}" points at a GitLab repository; GitLab evidence (issues, MRs, pipelines) requires glab support, which is not implemented yet.`,
        'Declare the platform with "specgit init --gitlab-host <hostname>" and see docs/gitlab-support.md for the glab roadmap.'
      );
    }
    // #95: a path naming a nested group (or %2F-encoded separators,
    // #112) is still a recognized GitLab origin — never a misdiagnosed
    // "unresolvable" URL with GitHub-pointing repair advice.
    const gitlabRef = parseGitLabPathRef(shape);
    if (gitlabRef !== null) {
      return fail(
        'gitlab_unsupported',
        `Origin "${truncateUrl(url)}" points at a nested-group GitLab repository (group/subgroup/project); nested groups are recognized, but GitLab evidence (issues, MRs, pipelines) requires glab support, which is not implemented yet.`,
        'Nested-group GitLab origins are recognized but unsupported until the glab provider lands; declare the platform with "specgit init --gitlab-host <hostname>" and see docs/gitlab-support.md for the roadmap.'
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

/**
 * Non-empty path segments of an origin shape, or null when the path is
 * malformed for its track (missing/extra leading slash, empty segment).
 * The url track carries a leading "/" (and may trail one); the scp track
 * carries neither.
 */
function parsePathSegments(path: string, urlTrack: boolean): string[] | null {
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
  return segments.includes('') ? null : segments;
}

function parseOwnerRepo(path: string, urlTrack: boolean): RepoRef | null {
  const segments = parsePathSegments(path, urlTrack);
  if (segments === null || segments.length !== 2) {
    return null;
  }
  const owner = segments[0];
  let repo = segments[1];
  if (repo.length > 4 && repo.endsWith('.git')) {
    repo = repo.slice(0, -4);
  }
  return { owner, repo };
}

// #112: the GitLab origin grammar accepted on declared hosts —
// group[/subgroup…]/project. Depth is bounded (2–5 segments after
// decoding) so hostile deep paths fail closed instead of classifying.
const GITLAB_PATH_MIN_SEGMENTS = 2;
const GITLAB_PATH_MAX_SEGMENTS = 5;

type GitLabPathRef = { ref: RepoRef } | 'too-deep' | null;

/**
 * Parse a full GitLab project path off an origin shape: segments split
 * per track, `%2F` separators decoded (any other percent-escape stays
 * undecodable and fails closed), one `.git` suffix stripped from the
 * project segment. Returns the platform-marked ref, `'too-deep'` for a
 * well-formed path beyond the accepted depth, or null for every
 * malformed shape — including the scp port-intent form (first path
 * segment all digits), which never classifies (#95).
 */
function parseGitLabPathRef(shape: OriginShape): GitLabPathRef {
  const segments = parsePathSegments(shape.path, shape.kind === 'url');
  if (segments === null) {
    return null;
  }
  if (shape.kind === 'scp' && isAllDigits(segments[0])) {
    return null;
  }
  const decoded: string[] = [];
  for (const segment of segments) {
    const expanded = decodePercent2f(segment);
    if (expanded === null) {
      return null;
    }
    decoded.push(...expanded.split('/'));
  }
  if (decoded.some((segment) => segment.length === 0)) {
    return null;
  }
  if (decoded.length < GITLAB_PATH_MIN_SEGMENTS) {
    return null;
  }
  const project = decoded[decoded.length - 1];
  const stripped = project.length > 4 && project.endsWith('.git') ? project.slice(0, -4) : project;
  const ref: RepoRef = {
    owner: decoded.slice(0, -1).join('/'),
    repo: stripped,
    platform: 'gitlab',
  };
  return decoded.length > GITLAB_PATH_MAX_SEGMENTS ? 'too-deep' : { ref };
}

/**
 * Decode `%2F`/`%2f` inside one path segment into a `/` separator — the
 * URL-encoded form GitLab's projects API also uses to address a full
 * group path. Any other percent-escape (or a truncated `%`) is not
 * decodable under this grammar and returns null (fail closed).
 */
function decodePercent2f(segment: string): string | null {
  let out = '';
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (c !== '%') {
      out += c;
      continue;
    }
    if (i + 2 >= segment.length) {
      return null;
    }
    const hex = segment.slice(i + 1, i + 3);
    if (hex !== '2F' && hex !== '2f') {
      return null;
    }
    out += '/';
    i += 2;
  }
  return out;
}

// GitHub requires an exact structural host match. On the https track any
// userinfo disqualifies; on the ssh track the user must be `git` with no
// password (matching git's own convention); the scp track requires the
// exact `git` user. Ports (#78): only the scheme default classifies —
// github.com never accepts a declared non-default port.
function isGitHubOrigin(shape: OriginShape): boolean {
  if (shape.kind === 'scp') {
    return shape.user === 'git' && shape.host === 'github.com';
  }
  return shape.host === 'github.com' && urlPortAccepted(shape, null) && urlUserAllowed(shape);
}

function isGitLabHeuristic(shape: OriginShape): boolean {
  if (shape.kind === 'scp') {
    return shape.user === 'git' && shape.host.includes('gitlab');
  }
  return shape.host.includes('gitlab') && urlPortAccepted(shape, null) && urlUserAllowed(shape);
}

function isDeclaredGitLab(shape: OriginShape, declared: DeclaredGitLab | undefined): boolean {
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
function normalizeDeclaredGitLab(value: string | undefined): DeclaredGitLab | undefined {
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
