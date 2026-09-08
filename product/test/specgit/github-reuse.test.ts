import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ok, fail, type Evidence } from '../../src/kernel/evidence.js';
import { GitHubReuseExecutions } from '../../src/providers/github/reuse.js';
import { originalJobName } from '../../src/verification/reuse-producer.js';
import { decideVerificationReuse, type ReuseContext } from '../../src/verification/reuse-decision.js';

const sourceSha = 'a'.repeat(40);
const inputDigest = 'b'.repeat(64);
const repository = 'github.com/owner/project';
const ref = { repository, run: '20', attempt: 1, job: '30' };
const entry = '.github/workflows/reuse.yml';
const producer = { profile: 'linux', entry, files: [{ path: entry, sha256: createHash('sha256').update('approved').digest('hex') }] };
const run = { id: 20, run_attempt: 1, head_sha: sourceSha, path: entry, created_at: '2026-09-06T00:00:00Z',
  status: 'completed', conclusion: 'success', event: 'pull_request',
  repository: { full_name: 'owner/project' }, head_repository: { full_name: 'owner/project' } };
const job = { id: 30, run_id: 20, run_attempt: 1, head_sha: sourceSha,
  name: originalJobName('linux', inputDigest), status: 'completed', conclusion: 'success',
  completed_at: '2026-09-08T00:00:00Z' };

function fixture(change: { run?: object; job?: object; total?: number; runs?: typeof run[];
  jobTotal?: number; content?: string; missing?: string } = {}) {
  const paths: string[] = [];
  const api = async (endpoint: string): Promise<Evidence<unknown>> => {
    paths.push(endpoint);
    if (change.missing && endpoint.includes(change.missing)) return fail('not_found', 'Missing');
    if (endpoint.includes('/contents/')) return ok({ type: 'file', encoding: 'base64', content: Buffer.from(change.content ?? 'approved').toString('base64') });
    if (endpoint.includes('/workflows/')) {
      const created = new URL(endpoint, 'https://api.github.com/').searchParams.get('created');
      const runs = (change.runs ?? [{ ...run, ...change.run }])
        .filter((candidate) => !created || Date.parse(candidate.created_at) >= Date.parse(created.slice(2)));
      return ok({ total_count: change.total ?? runs.length, workflow_runs: runs });
    }
    if (endpoint.includes('/jobs?')) {
      const runId = Number(endpoint.match(/\/runs\/(\d+)\//)?.[1]);
      return ok({ total_count: change.jobTotal ?? 1, jobs: [{ ...job, id: runId + 10, run_id: runId, ...change.job }] });
    }
    if (endpoint.includes('/jobs/')) return ok({ ...job, ...change.job });
    return ok({ ...run, ...change.run });
  };
  return { paths, port: new GitHubReuseExecutions({ repository: 'owner/project', producer, currentRun: '21', api }) };
}

describe('GitHub original execution provenance', () => {
  it('discovers native originals and verifies their attempt, source, producer and terminal success', async () => {
    const { port, paths } = fixture();
    expect(await port.candidates(repository, 'linux')).toEqual(ok([ref]));
    const result = await port.original(ref);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected original');
    expect(result.value).toMatchObject({ ref, profile: 'linux', sourceSha, inputDigest, completedAt: job.completed_at });
    expect(paths.some((value) => value.includes(`/attempts/1/jobs?`))).toBe(true);
    expect(paths.some((value) => value.endsWith(`?ref=${sourceSha}`))).toBe(true);
  });

  it.each([
    { run: { head_repository: { full_name: 'fork/project' } } },
    { run: { path: '.github/workflows/other.yml' } },
    { run: { run_attempt: 2 } },
    { run: { status: 'in_progress', conclusion: null } },
    { job: { run_id: 99 } },
    { job: { head_sha: 'c'.repeat(40) } },
    { job: { conclusion: 'failure' } },
    { job: { status: 'in_progress', conclusion: null } },
    { job: { name: 'SpecGit reuse / linux / ' + inputDigest } },
    { content: 'unapproved workflow' },
    { missing: '/contents/' },
    { missing: '/jobs/' },
  ])('does not turn mismatched, reused, failed or missing evidence into an original', async (change) => {
    expect((await fixture(change).port.original(ref)).ok).toBe(false);
  });

  it('preserves failed original references so decision-making cannot silently select older green evidence', async () => {
    const { port } = fixture({ job: { conclusion: 'failure' } });
    expect(await port.candidates(repository, 'linux')).toEqual(ok([ref]));
    expect((await port.original(ref)).ok).toBe(false);
  });

  it('rejects truncated inventory and repository substitution', async () => {
    expect((await fixture({ total: 21 }).port.candidates(repository, 'linux')).ok).toBe(false);
    expect((await fixture().port.candidates('github.com/other/project', 'linux')).ok).toBe(false);
    expect((await fixture().port.original({ ...ref, repository: 'github.com/other/project' })).ok).toBe(false);
  });

  it('never treats a successful current reuse gate as an original execution', async () => {
    expect(await fixture({ job: { name: 'Test (linux)' } }).port.candidates(repository, 'linux')).toEqual(ok([]));
  });

  it('reuses a long-running original by completion time and never renews its age', async () => {
    const { port } = fixture();
    const original = await port.original(ref);
    if (!original.ok) throw new Error('Expected verified original');
    const context: ReuseContext = { repository, profile: { id: 'linux', maxAgeSeconds: 60 },
      inputs: { sourceSha, checkoutSha: sourceSha, baseSha: sourceSha, policySha: sourceSha,
        digest: inputDigest, sourceTreeDigest: inputDigest, checkoutTreeDigest: inputDigest,
        recipeDigest: original.value.recipeDigest, environmentDigest: inputDigest } };
    const current = async () => ok(context);
    const completed = Date.parse(job.completed_at);
    expect(await decideVerificationReuse({ current, executions: port, now: completed + 1_000 }))
      .toEqual({ mode: 'reuse', original: ref, completedAt: job.completed_at, inputDigest });
    expect((await decideVerificationReuse({ current, executions: port, now: completed + 60_000 })).mode).toBe('execute');
  });

  it('inspects the complete latest run window even when workflow history exceeds 20 runs', async () => {
    const runs = Array.from({ length: 20 }, (_, index) => ({ ...run, id: 40 - index }));
    const { port, paths } = fixture({ total: 200, runs });
    const result = await port.candidates(repository, 'linux');
    expect(result).toEqual(ok(runs.filter((candidate) => candidate.id !== 21)
      .map((candidate) => ({ repository, run: String(candidate.id), attempt: 1, job: String(candidate.id + 10) }))));
    expect(paths[0]).toContain('per_page=20&page=1');
    expect(paths.some((path) => path.includes('created='))).toBe(false);
    expect(paths.filter((path) => path.includes('/jobs?'))).toHaveLength(19);
  });

  it.each([
    [{ ...run, id: 19 }, run],
    [run, run],
    Array.from({ length: 21 }, (_, index) => ({ ...run, id: 50 - index })),
  ])('rejects unordered, duplicate or oversized run windows', async (...runs) => {
    expect((await fixture({ runs }).port.candidates(repository, 'linux')).ok).toBe(false);
  });

  it('rejects incomplete native jobs within the selected run window', async () => {
    expect((await fixture({ jobTotal: 2 }).port.candidates(repository, 'linux')).ok).toBe(false);
  });
});
