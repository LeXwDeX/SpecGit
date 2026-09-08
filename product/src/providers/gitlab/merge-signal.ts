import type { RepoRef } from '../../gitfacts/origin.js';
import { fail, ok, type Evidence } from '../../kernel/evidence.js';
import { isAutomationTargetBranch } from '../../record/policy.js';
import type { GitlabCompletionReads } from './completion-context.js';

/** Resolve commit data only; the completion verifier separately proves the triggering pipeline. */
export async function resolveGitlabMergeSignal(
  repo: RepoRef, mergeSha: string, target: string, reads: GitlabCompletionReads,
): Promise<Evidence<{ pr: number; headSha: string } | undefined>> {
  const invalid = (message: string) => fail<never>('gitlab_completion_unverified', message);
  if (repo.platform !== 'gitlab' || !/^[a-f0-9]{40}$/i.test(mergeSha) || !isAutomationTargetBranch(target)) {
    return invalid('Invalid GitLab merge signal.');
  }
  const project = `projects/${encodeURIComponent(`${repo.owner}/${repo.repo}`)}`;
  const entries = await reads.list(`${project}/repository/commits/${mergeSha}/merge_requests`);
  if (!entries.ok) return entries;
  const candidates = new Set<number>();
  for (const entry of entries.value) {
    const row = entry as { iid?: unknown; state?: unknown; target_branch?: unknown } | null;
    if (!row || typeof row.iid !== 'number' || !Number.isSafeInteger(row.iid) || row.iid <= 0) return invalid('Invalid commit request identity.');
    if (row.state === 'merged' && row.target_branch === target) candidates.add(row.iid);
  }
  const matches: { pr: number; headSha: string }[] = [];
  for (const pr of candidates) {
    const result = await reads.api(`${project}/merge_requests/${pr}`);
    if (!result.ok) return result;
    const mr = result.value as Record<string, unknown> | null;
    if (!mr || mr.iid !== pr || mr.state !== 'merged' || mr.target_branch !== target) return invalid('Merged request identity changed.');
    if (![mr.merge_commit_sha, mr.squash_commit_sha, mr.sha].includes(mergeSha)) continue;
    if (typeof mr.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(mr.sha)) return invalid('Missing request head SHA.');
    matches.push({ pr, headSha: mr.sha });
  }
  if (matches.length > 1) return invalid('The merge signal identifies multiple requests; recover each bound request explicitly.');
  return ok(matches[0]);
}
