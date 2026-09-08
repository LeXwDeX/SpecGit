/**
 * Per-platform project path reading (#279): one reason to change lives
 * here — a platform's path grammar. GitHub reads exactly owner/repo;
 * GitLab reads group[/subgroup…]/project with `%2F` separators (#95,
 * #112). Both consume an already-parsed shape; neither classifies.
 */

import type { RepoRef } from './origin.js';
import { isAllDigits, parsePathSegments, type OriginShape } from './origin-shape.js';

/**
 * The GitHub reader: exactly two segments, one `.git` suffix stripped,
 * platform-marked. Anything else is null (never a guess).
 */
export function parseOwnerRepo(path: string, urlTrack: boolean): RepoRef | null {
  const segments = parsePathSegments(path, urlTrack);
  if (segments === null || segments.length !== 2) {
    return null;
  }
  const owner = segments[0];
  let repo = segments[1];
  if (repo.length > 4 && repo.endsWith('.git')) {
    repo = repo.slice(0, -4);
  }
  return { owner, repo, platform: 'github' };
}

// #112: the GitLab origin grammar accepted on declared hosts —
// group[/subgroup…]/project. Depth is bounded (2–5 segments after
// decoding) so hostile deep paths fail closed instead of classifying.
export const GITLAB_PATH_MIN_SEGMENTS = 2;
export const GITLAB_PATH_MAX_SEGMENTS = 5;

export type GitLabPathRef = { ref: RepoRef } | 'too-deep' | null;

/**
 * Parse a full GitLab project path off an origin shape: segments split
 * per track, `%2F` separators decoded (any other percent-escape stays
 * undecodable and fails closed), one `.git` suffix stripped from the
 * project segment. Returns the platform-marked ref, `'too-deep'` for a
 * well-formed path beyond the accepted depth, or null for every
 * malformed shape — including the scp port-intent form (first path
 * segment all digits), which never classifies (#95).
 */
export function parseGitLabPathRef(shape: OriginShape): GitLabPathRef {
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
export function decodePercent2f(segment: string): string | null {
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
