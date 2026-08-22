/**
 * The origin fact (#279): `parseRepoRef` composes the three reasons an
 * origin resolution changes — URL shape (origin-shape.ts), platform
 * classification (platform.ts), and per-platform project-path reading
 * (project-path.ts). Diagnostic codes and acceptance rules live here,
 * in the composition; each module below owns exactly one reason to
 * change. Also the bounded host-extraction seam (#83) used by init and
 * check detection.
 */

import { fail, ok, type Evidence } from '../kernel/evidence.js';
import {
  isAllDigits,
  MAX_ORIGIN_URL_LENGTH,
  parseOriginShape,
} from './origin-shape.js';
import {
  isDeclaredGitLab,
  isGitHubOrigin,
  isGitLabHeuristic,
  normalizeDeclaredGitLab,
} from './platform.js';
import {
  GITLAB_PATH_MAX_SEGMENTS,
  GITLAB_PATH_MIN_SEGMENTS,
  parseGitLabPathRef,
  parseOwnerRepo,
} from './project-path.js';

export interface RepoRef {
  owner: string;
  repo: string;
  /**
   * The platform the ref resolved under (#186). `'gitlab'` only when the
   * ref resolved through a GitLab declaration in `spec_git/providers.yaml`
   * (#112) — the only source of GitLab acceptance: the `*gitlab*` host
   * heuristic never resolves a ref, so no substring match can grant
   * capability. Every other accepted ref (github.com origins) carries
   * `'github'` explicitly: the parse layer always fills the marker, so
   * consumers dispatch on a required union instead of an implied default.
   */
  platform: 'github' | 'gitlab';
}

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
    const valid =
      (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 /* + */ || c === 45 /* - */ || c === 46; /* . */
    if (!valid) return false;
  }
  return true;
}

function isValidHost(host: string): boolean {
  if (host.length === 0 || host.length > MAX_ORIGIN_HOST_LENGTH) return false;
  for (let i = 0; i < host.length; i++) {
    const c = host.charCodeAt(i);
    const valid = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 46 /* . */ || c === 45; /* - */
    if (!valid) return false;
  }
  return true;
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
  return ok({ repo: { owner: match[1], repo: match[2], platform: 'github' }, pr: Number(match[3]) });
}

function truncateUrl(value: string): string {
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
}
