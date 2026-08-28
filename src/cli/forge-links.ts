/**
 * #361: forge-side link and command derivation for success hand-offs.
 *
 * Pure functions over an origin URL and the resolved `RepoRef.platform`:
 * web URLs for issues/PRs and the platform-dialect commands (ready,
 * merge). Commands are the machine contract (verbatim); callers own any
 * localized prose around them.
 */

import type { RepoRef } from '../gitfacts/origin.js';

/**
 * `https://<host>/<project-path>` from an https, ssh, or scp-like origin
 * URL; null when unparseable. The project path keeps its full depth
 * (GitLab nested groups, #120); ports and userinfo never reach the web
 * base; plain `http` never becomes an insecure web link.
 */
const WEB_BASE_PATTERNS = [
  /^https:\/\/[^/@:]+@([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i,
  /^https:\/\/([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i,
  /^ssh:\/\/[^/@:]+@([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i,
  /^git@([^:/]+):(.+?)(?:\.git)?\/?$/i,
];
const PROJECT_PATH = /^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)+$/;

export function forgeWebBase(originUrl: string | null): string | null {
  if (originUrl === null) {
    return null;
  }
  for (const pattern of WEB_BASE_PATTERNS) {
    const match = pattern.exec(originUrl.trim());
    if (!match) continue;
    const segments = match[2].split('/');
    const pathOk =
      PROJECT_PATH.test(match[2]) && segments.every((segment) => segment !== '.' && segment !== '..');
    if (pathOk) {
      return `https://${match[1].toLowerCase()}/${match[2]}`;
    }
  }
  return null;
}

export function forgeIssueUrl(base: string, platform: RepoRef['platform'], issue: number): string {
  return platform === 'gitlab' ? `${base}/-/issues/${issue}` : `${base}/issues/${issue}`;
}

export function forgePrUrl(
  base: string,
  platform: RepoRef['platform'],
  pr: number | string
): string {
  return platform === 'gitlab'
    ? `${base}/-/merge_requests/${pr}`
    : `${base}/pull/${pr}`;
}

export function forgeReadyCommand(platform: RepoRef['platform'], pr: number | string): string {
  return platform === 'gitlab' ? `glab mr update ${pr} --ready` : `gh pr ready ${pr}`;
}

export function forgeMergeCommand(platform: RepoRef['platform'], pr: number | string): string {
  return platform === 'gitlab' ? `glab mr merge ${pr}` : `gh pr merge ${pr} --auto --merge`;
}
