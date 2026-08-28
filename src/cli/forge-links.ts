/**
 * #361: forge-side link and command derivation for success hand-offs.
 *
 * Pure functions over an origin URL and the resolved `RepoRef.platform`:
 * web URLs for issues/PRs and the platform-dialect commands (ready,
 * merge). Commands are the machine contract (verbatim); callers own any
 * localized prose around them.
 */

import type { RepoRef } from '../gitfacts/origin.js';

/** `https://<host>/<owner>/<repo>` from an https or ssh origin URL; null when unparseable. */
export function forgeWebBase(originUrl: string | null): string | null {
  if (originUrl === null) {
    return null;
  }
  const https = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(originUrl.trim());
  if (https) {
    return `https://${https[1]}/${https[2]}/${https[3]}`;
  }
  const scpLike = /^git@([^:/]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(originUrl.trim());
  if (scpLike) {
    return `https://${scpLike[1]}/${scpLike[2]}/${scpLike[3]}`;
  }
  const sshUrl = /^ssh:\/\/git@([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(originUrl.trim());
  if (sshUrl) {
    return `https://${sshUrl[1]}/${sshUrl[2]}/${sshUrl[3]}`;
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
