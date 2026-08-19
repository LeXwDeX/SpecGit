import { fail, ok, type Evidence } from '../kernel/evidence.js';

export interface RepoRef {
  owner: string;
  repo: string;
}

export function parseRepoRef(originUrl: string): Evidence<RepoRef> {
  const url = originUrl.trim();
  if (!url) {
    return fail(
      'origin_unresolvable',
      'The origin remote has an empty URL.',
      'Point origin at a github.com repository.'
    );
  }

  const https = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
  const scp = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  const ssh = /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
  const match = https ?? scp ?? ssh;

  if (!match) {
    // A GitLab origin is a recognized-but-unsupported platform, not an
    // unresolvable URL: the diagnostic names the actual gap.
    const gitlabHttps = /^https:\/\/(?:[a-z0-9.-]*gitlab[a-z0-9.-]*)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
    const gitlabScp = /^git@(?:[a-z0-9.-]*gitlab[a-z0-9.-]*):([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(url);
    const gitlabSsh = /^ssh:\/\/git@([a-z0-9.-]*gitlab[a-z0-9.-]*)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
    if (gitlabHttps ?? gitlabScp ?? gitlabSsh) {
      return fail(
        'gitlab_unsupported',
        `Origin "${truncateUrl(url)}" points at a GitLab repository; GitLab evidence (issues, MRs, pipelines) requires glab support, which is not implemented yet.`,
        'Point origin at a github.com repository (https or ssh), or track the GitLab/glab support roadmap in docs/gitlab-support.md.'
      );
    }
    return fail(
      'origin_unresolvable',
      `Origin "${truncateUrl(url)}" does not point at a github.com repository.`,
      'Point origin at a github.com repository (https or ssh).'
    );
  }

  return ok({ owner: match[1], repo: match[2] });
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
