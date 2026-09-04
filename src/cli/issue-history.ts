import { fail, ok, type Evidence } from '../kernel/evidence.js';
import type { ForgeReadPort, IssueHistoryFact } from '../github/port.js';
import type { RepoRef } from '../gitfacts/origin.js';
export { findIssueOccupancy } from '../github/issue-occupancy.js';

export interface IssueHistoryMatch {
  title: string;
  query: string;
  openCandidates: IssueHistoryFact[];
  closedHistory: IssueHistoryFact[];
}

/** Related-word search is advisory: only the caller can compare the requested WHY. */
export async function findIssueHistory(
  provider: Pick<ForgeReadPort, 'searchIssueHistory'>,
  repo: RepoRef,
  titles: readonly string[],
  fallbackQuery?: string
): Promise<Evidence<IssueHistoryMatch[]>> {
  const matches: IssueHistoryMatch[] = [];
  for (const title of new Set(titles)) {
    const text = title.replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/i, '');
    const words = text.match(/[\p{L}\p{N}]+/gu) ?? fallbackQuery?.match(/[\p{L}\p{N}]+/gu) ?? [];
    const query = [...new Set(words)].slice(0, 5).join(' ').slice(0, 160);
    if (!query) return fail('issue_history_query_invalid', 'An issue title needs searchable words before history can be checked.');
    const history = await provider.searchIssueHistory(repo, query);
    if (!history.ok) return history;
    matches.push({ title, query,
      openCandidates: history.value.filter((issue) => issue.state === 'open'),
      closedHistory: history.value.filter((issue) => issue.state === 'closed'),
    });
  }
  return ok(matches);
}
