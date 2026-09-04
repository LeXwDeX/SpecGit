import { fail, ok, type Evidence } from '../kernel/evidence.js';
import type { ForgeReadPort, PrFact } from './port.js';
import type { RepoRef } from '../gitfacts/origin.js';
import { parseClosingRefs } from './closing-refs.js';

/** No mutations: unknown evidence remains unknown, and a draft still occupies its bound issues. */
export async function findIssueOccupancy(
  provider: Pick<ForgeReadPort, 'listIssuePullRequests'>,
  repo: RepoRef,
  issues: readonly number[],
  current: { pr?: number; host?: string } = {}
): Promise<Evidence<Array<{ issue: number; pullRequests: PrFact[] }>>> {
  const occupied: Array<{ issue: number; pullRequests: PrFact[] }> = [];
  for (const issue of new Set(issues)) {
    if (!Number.isSafeInteger(issue) || issue <= 0) return fail('issue_occupancy_unknown', 'Issue occupancy needs a positive issue number.');
    const listed = await provider.listIssuePullRequests(repo, issue);
    if (!listed.ok) return listed;
    const others: PrFact[] = [];
    for (const pr of listed.value) {
      if (pr.state !== 'open') continue;
      if (!pr.headBranch || !Number.isSafeInteger(pr.number) || pr.number <= 0 || typeof pr.body !== 'string') {
        return fail('issue_occupancy_unknown', `Issue #${issue} has incomplete active request evidence.`);
      }
      if (pr.number === current.pr) continue;
      const host = current.host ?? (repo.platform === 'github' ? 'github.com' : undefined);
      const closes = parseClosingRefs(pr.body, repo.platform, { projectPath: `${repo.owner}/${repo.repo}`, host }).has(issue);
      if (!closes && host === undefined && /https?:\/\//.test(pr.body) && parseClosingRefs(pr.body, repo.platform).has(issue)) {
        return fail('issue_occupancy_unknown', `The declared GitLab host is required to verify URL references for issue #${issue}.`);
      }
      if (closes) others.push(pr);
    }
    if (others.length > 0) occupied.push({ issue, pullRequests: others });
  }
  return ok(occupied);
}
