import { describe, expect, it, vi } from 'vitest';
import { findIssueHistory, findIssueOccupancy } from '../../src/cli/issue-history.js';
import { fail, ok } from '../../src/kernel/evidence.js';
import { makePrFact } from '../specgit/helpers/mock-forge.js';

const repo = { owner: 'acme', repo: 'app', platform: 'github' } as const;
const history = (number: number, state: 'open' | 'closed') => ({ number, state, title: 'fix: retry delivery', body: 'The specific WHY.', url: `https://github.com/acme/app/issues/${number}` });

describe('issue history and active delivery occupancy', () => {
  it('returns open candidates and closed history without deciding to reuse either', async () => {
    const provider = { searchIssueHistory: vi.fn(async () => ok([history(1, 'open'), history(2, 'closed')])) };
    const result = await findIssueHistory(provider, repo, ['fix: retry delivery']);
    expect(result).toEqual(ok([{ title: 'fix: retry delivery', query: 'retry delivery', openCandidates: [history(1, 'open')], closedHistory: [history(2, 'closed')] }]));
    expect(provider.searchIssueHistory).toHaveBeenCalledOnce();
  });

  it('does not replace failed or truncated search evidence with an empty candidate list', async () => {
    const evidence = fail<never>('evidence_truncated', 'History search exceeds its complete query window.');
    expect(await findIssueHistory({ searchIssueHistory: async () => evidence }, repo, ['fix: retry'])).toEqual(evidence);
  });

  it('searches the explicit delivery name when a valid title has no searchable words', async () => {
    const provider = { searchIssueHistory: vi.fn(async () => ok([])) };
    expect(await findIssueHistory(provider, repo, ['feat: !!!'], 'bang-path')).toEqual(ok([
      { title: 'feat: !!!', query: 'bang path', openCandidates: [], closedHistory: [] },
    ]));
    expect(provider.searchIssueHistory).toHaveBeenCalledWith(repo, 'bang path');
  });

  it('checks each unique issue and excludes only this PR, closed PRs and ordinary mentions', async () => {
    const provider = { listIssuePullRequests: vi.fn(async () => ok([
      makePrFact({ number: 10, body: 'Closes #1', headBranch: 'current' }),
      makePrFact({ number: 11, body: 'Closes #1', headBranch: 'resumed' }),
      makePrFact({ number: 12, body: 'Closes #1', state: 'closed' }),
      makePrFact({ number: 13, body: 'Related to #1', headBranch: 'mention' }),
      makePrFact({ number: 14, body: 'Closes #1', headBranch: 'other', draft: true }),
    ])) };
    const result = await findIssueOccupancy(provider, repo, [1, 1], { pr: 10 });
    expect(result.ok && result.value.map((entry) => [entry.issue, entry.pullRequests.map((pr) => pr.number)])).toEqual([[1, [11, 14]]]);
    expect(provider.listIssuePullRequests).toHaveBeenCalledOnce();
  });

  it('preserves unknown occupancy evidence and rejects malformed live identity', async () => {
    const missing = fail<never>('gh_transport', 'Unable to read related requests.');
    expect(await findIssueOccupancy({ listIssuePullRequests: async () => missing }, repo, [1])).toEqual(missing);
    expect(await findIssueOccupancy({ listIssuePullRequests: async () => ok([makePrFact({ headBranch: '', body: 'Closes #1' })]) }, repo, [1])).toMatchObject({ ok: false, code: 'issue_occupancy_unknown' });
  });

  it('uses scoped GitLab closing grammar and never mistakes another project issue for this issue', async () => {
    const provider = { listIssuePullRequests: async () => ok([
      makePrFact({ number: 3, body: 'Implements acme/app#1', headBranch: 'other' }),
      makePrFact({ number: 4, body: 'Closes different/app#1', headBranch: 'different' }),
    ]) };
    const result = await findIssueOccupancy(provider, { ...repo, platform: 'gitlab' }, [1]);
    expect(result.ok && result.value[0].pullRequests.map((pr) => pr.number)).toEqual([3]);
  });

  it('recognizes full issue URLs only within the verified forge host', async () => {
    const provider = { listIssuePullRequests: async () => ok([makePrFact({ body: 'Closes https://github.com/acme/app/issues/1', headBranch: 'other' })]) };
    const github = await findIssueOccupancy(provider, repo, [1]);
    expect(github.ok && github.value).toHaveLength(1);
    const glab = { listIssuePullRequests: async () => ok([makePrFact({ body: 'Closes https://git.example.com/acme/app/-/issues/1', headBranch: 'other' })]) };
    expect(await findIssueOccupancy(glab, { ...repo, platform: 'gitlab' }, [1])).toMatchObject({ ok: false, code: 'issue_occupancy_unknown' });
    const gitlab = await findIssueOccupancy(glab, { ...repo, platform: 'gitlab' }, [1], { host: 'git.example.com' });
    expect(gitlab.ok && gitlab.value).toHaveLength(1);
  });
});
