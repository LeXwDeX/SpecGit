/**
 * Origin URL shape parsing (#279): text → host + path, no platform
 * opinion. One reason to change lives here: a new URL form (scheme,
 * scp variant, port grammar). Classification and project-path reading
 * are separate modules (platform.ts, project-path.ts); parseRepoRef in
 * origin.ts is their composition.
 *
 * All parsing is linear-time and front-loaded with hard length caps;
 * hosts are charset-validated so no input can smuggle identity through
 * userinfo, path, query, or fragment.
 */

/** The scheme-bearing track (https/ssh URLs). */
export type UrlShape = {
  kind: 'url';
  scheme: 'https' | 'ssh';
  host: string;
  port: string;
  username: string;
  password: string;
  path: string;
};

/** The scp-like track (`user@host:path`); no port slot. */
export type ScpShape = {
  kind: 'scp';
  user: string;
  host: string;
  path: string;
};

export type OriginShape = UrlShape | ScpShape;

// Hard caps front-load every parse: anything longer fails closed before
// classification. Shared with the host-extraction seam (#83).
export const MAX_ORIGIN_URL_LENGTH = 4096;
const MAX_HOST_LENGTH = 253;

const SCHEME_PREFIX = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const HOSTNAME_CHARS = /^[a-z0-9.-]+$/;

export function parseOriginShape(url: string): OriginShape | null {
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

export function isPlausibleHostname(host: string): boolean {
  return host.length >= 1 && host.length <= MAX_HOST_LENGTH && HOSTNAME_CHARS.test(host);
}

/**
 * Non-empty path segments of an origin shape, or null when the path is
 * malformed for its track (missing/extra leading slash, empty segment).
 * The url track carries a leading "/" (and may trail one); the scp track
 * carries neither.
 */
export function parsePathSegments(path: string, urlTrack: boolean): string[] | null {
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

export function isAllDigits(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 48 /* 0 */ || c > 57 /* 9 */) return false;
  }
  return true;
}
