import type { RepoRef } from '../../gitfacts/origin.js';
import { isAutomationTargetBranch } from '../../record/policy.js';

/** Resolve commit data only; the completion verifier separately proves the triggering pipeline. */
export function resolveGitlabMergeSignal(
  repo: RepoRef, mergeSha: string, target: string, read: (path: string) => unknown,
): { pr: number; headSha: string } | undefined {
  if (repo.platform !== 'gitlab' || !/^[a-f0-9]{40}$/i.test(mergeSha) || !isAutomationTargetBranch(target)) {
    throw new Error('Invalid GitLab merge signal.');
  }
  const project = `projects/${encodeURIComponent(`${repo.owner}/${repo.repo}`)}`;
  const candidates = new Set<number>();
  let exhausted = false;
  for (let page = 1; page <= 10; page++) {
    const entries = read(`${project}/repository/commits/${mergeSha}/merge_requests?per_page=100&page=${page}`);
    if (!Array.isArray(entries) || entries.length > 100) throw new Error('Invalid commit request page.');
    for (const entry of entries) {
      if (!entry || !Number.isSafeInteger(entry.iid) || entry.iid <= 0) throw new Error('Invalid commit request identity.');
      if (entry.state === 'merged' && entry.target_branch === target) candidates.add(entry.iid);
    }
    if (entries.length < 100) { exhausted = true; break; }
  }
  if (!exhausted) throw new Error('Commit request pagination is incomplete.');
  const matches: { pr: number; headSha: string }[] = [];
  for (const pr of candidates) {
    const value = read(`${project}/merge_requests/${pr}`);
    if (!value || typeof value !== 'object') throw new Error('Missing merged request evidence.');
    const mr = value as Record<string, unknown>;
    if (mr.iid !== pr || mr.state !== 'merged' || mr.target_branch !== target) throw new Error('Merged request identity changed.');
    if (![mr.merge_commit_sha, mr.squash_commit_sha, mr.sha].includes(mergeSha)) continue;
    if (typeof mr.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(mr.sha)) throw new Error('Missing request head SHA.');
    matches.push({ pr, headSha: mr.sha });
  }
  if (matches.length > 1) throw new Error('The merge signal identifies multiple requests; recover each bound request explicitly.');
  return matches[0];
}
