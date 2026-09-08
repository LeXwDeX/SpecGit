import { describe, expect, it, vi } from 'vitest';
import { assessScope } from '../../src/scope/assess.js';
import type { HistoricalDependencies } from '../../src/scope/historical-delivery.js';
import { ok, fail } from '../../src/kernel/evidence.js';
import { makePrFact } from './helpers/mock-forge.js';
import type { PrFact } from '../../src/github/port.js';

const HEAD = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
const declaration = { version: 1 as const, name: 'programme', parent: 1, required: [{ issue: 10, target: 'preview' }, { issue: 11, target: 'dev' }] };

function fixture(platform: 'github' | 'gitlab' = 'github') {
  const requests = new Map<number, PrFact>([
    [20, makePrFact({ number: 20, state: 'merged', draft: false, headSha: HEAD, mergeCommitSha: MERGE, baseBranch: 'preview', headBranch: 'feature/one', body: 'Closes #10' })],
    [21, makePrFact({ number: 21, state: 'merged', draft: false, headSha: 'c'.repeat(40), mergeCommitSha: 'd'.repeat(40), baseBranch: 'dev', headBranch: 'feature/two', body: 'Closes #11' })],
  ]);
  const open = new Set<number>();
  const check = { name: 'test', status: 'completed', conclusion: 'success', id: 1, startedAt: '2026-01-02T00:00:00Z' };
  const deps = {
    root: '/repo', repo: { platform, owner: 'o', repo: 'r' },
    git: {
      readFileAtCommit: vi.fn(async (_root: string, sha: string) => {
        const request = [...requests.values()].find((pr) => pr.headSha === sha)!;
        return ok({ sha, content: JSON.stringify({ version: 1, delivery: 'work', context: { kind: 'branch', branch: request.headBranch }, pr: request.number, issues: [request.number - 10] }) });
      }),
      readFileBeforeMerge: vi.fn(async () => ok({ sha: 'e'.repeat(40), content: 'version: 1\nrequired_checks: [test]' })),
      isAncestor: vi.fn(async () => ok({ contained: true })),
    },
    forge: {
      getIssue: vi.fn(async (_repo: unknown, issue: number) => ok({ number: issue, state: open.has(issue) ? 'open' as const : 'closed' as const, pullRequest: false })),
      getPr: vi.fn(async (_repo: unknown, number: number | string) => ok(requests.get(Number(number))!)),
      listIssuePullRequests: vi.fn(async (_repo: unknown, issue: number) => ok([requests.get(issue + 10)!].filter(Boolean))),
      getPrChecks: vi.fn(async (_repo: unknown, number: number) => ok({ headSha: requests.get(number)!.headSha, checks: [check], pipelineStatus: 'success' })),
      getCheckRuns: vi.fn(async () => ok([check])),
      getEvidenceAnchor: vi.fn(async () => ok({ anchoredAt: '2026-01-01T00:00:00Z' })),
      getRequestDeclarations: vi.fn(async () => ok([])),
    },
  } satisfies HistoricalDependencies;
  return { deps, requests, open };
}

describe.each(['github', 'gitlab'] as const)('scope evidence on %s', (platform) => {
  it('requires both deliveries and reports each immutable result on its own configured target', async () => {
    const f = fixture(platform);
    expect(await assessScope(declaration, f.deps)).toMatchObject({ state: 'completed', members: [
      { issue: 10, state: 'completed', delivery: { request: 20, target: 'preview', headSha: HEAD } },
      { issue: 11, state: 'completed', delivery: { request: 21, target: 'dev' } },
    ] });
  });

  it('does not report completion after only the first delivery', async () => {
    const f = fixture(platform);
    f.open.add(11);
    f.requests.set(21, { ...f.requests.get(21)!, state: 'open', mergeCommitSha: null });
    expect(await assessScope(declaration, f.deps)).toMatchObject({ state: 'incomplete', members: [{ state: 'completed' }, { state: 'open' }] });
  });

  it('does not treat manual issue closure as delivery evidence', async () => {
    const f = fixture(platform);
    f.requests.delete(21);
    expect(await assessScope(declaration, f.deps)).toMatchObject({ state: 'incomplete', members: [{ state: 'completed' }, { state: 'closed_without_delivery' }] });
  });

  it('keeps an open programme parent separate from completed members', async () => {
    const f = fixture(platform);
    f.open.add(1);
    expect(await assessScope(declaration, f.deps)).toMatchObject({ state: 'ready_to_close', parent: { issue: 1, state: 'open' } });
  });

  it('fails closed for missing retained source evidence', async () => {
    const f = fixture(platform);
    f.deps.git.readFileAtCommit.mockImplementation(async () => fail('git_file_unavailable', 'missing object'));
    expect(await assessScope(declaration, f.deps)).toMatchObject({ state: 'unknown', members: [{ state: 'unknown' }, { state: 'unknown' }] });
  });

  it('rejects a different target even when the issue is closed', async () => {
    const f = fixture(platform);
    f.requests.set(20, { ...f.requests.get(20)!, baseBranch: 'main' });
    expect((await assessScope(declaration, f.deps)).members[0].state).toBe('closed_without_delivery');
  });

  it('distinguishes unbound open work', async () => {
    const f = fixture(platform);
    f.open.add(10); f.requests.delete(20);
    expect((await assessScope(declaration, f.deps)).members[0].state).toBe('unbound');
  });

  it('does not accept stale required checks or CI for a different head', async () => {
    const f = fixture(platform);
    f.deps.forge.getEvidenceAnchor.mockResolvedValue(ok({ anchoredAt: '2026-02-01T00:00:00Z' }));
    expect((await assessScope(declaration, f.deps)).state).toBe('incomplete');
    f.deps.forge.getEvidenceAnchor.mockResolvedValue(ok({ anchoredAt: '2026-01-01T00:00:00Z' }));
    f.deps.forge.getPrChecks.mockImplementation(async () => ok({ headSha: 'f'.repeat(40), checks: [], pipelineStatus: 'success' }));
    expect((await assessScope(declaration, f.deps)).state).toBe('unknown');
  });

  it('fails closed when a bound companion issue remains open', async () => {
    const f = fixture(platform);
    const original = f.deps.git.readFileAtCommit.getMockImplementation()!;
    f.open.add(99);
    for (const [number, request] of f.requests) f.requests.set(number, { ...request, body: `${request.body}\nCloses #99` });
    f.deps.git.readFileAtCommit.mockImplementation(async (root, sha) => {
      const file = await original(root, sha);
      if (!file.ok) return file;
      const binding = JSON.parse(file.value.content);
      binding.issues.push(99);
      return ok({ sha, content: JSON.stringify(binding) });
    });
    expect((await assessScope(declaration, f.deps)).members[0]).toMatchObject({ state: 'incomplete', diagnostics: [expect.objectContaining({ code: 'scope_closure_pending' })] });
  });

  it('reports known CI failure as incomplete and transport failure as unknown', async () => {
    const f = fixture(platform);
    f.deps.forge.getPrChecks.mockImplementation(async (_repo, number) => ok({ headSha: f.requests.get(number)!.headSha,
      checks: [{ name: 'extra-check', status: 'completed', conclusion: 'failure', id: 2, startedAt: '2026-01-02T00:00:00Z' }], pipelineStatus: 'success' }));
    expect((await assessScope(declaration, f.deps)).state).toBe('incomplete');
    f.deps.forge.getPrChecks.mockImplementation(async () => fail('gh_transport', 'Unavailable CI read'));
    expect((await assessScope(declaration, f.deps)).state).toBe('unknown');
  });

  it('requires an explicit selection for competing proven requests', async () => {
    const f = fixture(platform);
    const duplicate = { ...f.requests.get(20)!, number: 22, headSha: 'f'.repeat(40) };
    f.requests.set(22, duplicate);
    const original = f.deps.git.readFileAtCommit.getMockImplementation()!;
    f.deps.git.readFileAtCommit.mockImplementation(async (root, sha) => {
      const file = await original(root, sha);
      if (!file.ok || sha !== duplicate.headSha) return file;
      return ok({ sha, content: file.value.content.replace('[12]', '[10]') });
    });
    f.deps.forge.listIssuePullRequests.mockImplementation(async (_repo, issue) => ok(issue === 10 ? [f.requests.get(20)!, duplicate] : [f.requests.get(21)!]));
    expect((await assessScope(declaration, f.deps)).members[0].state).toBe('ambiguous');
    const selected = { ...declaration, required: [{ issue: 10, target: 'preview', request: 20 }] };
    expect((await assessScope(selected, f.deps)).state).toBe('completed');
  });
});
