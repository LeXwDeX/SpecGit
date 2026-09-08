import { describe, expect, it, vi } from 'vitest';
import { fail, ok, type Evidence } from '../../src/kernel/evidence.js';
import { decideVerificationReuse, type OriginalExecution, type ReuseContext, type ReuseExecutionPort, type ReuseExecutionRef } from '../../src/verification/reuse-decision.js';

const sha = 'a'.repeat(40);
const digest = 'b'.repeat(64);
const context: ReuseContext = {
  repository: 'github:github.com/example/project',
  profile: { id: 'unit-tests', maxAgeSeconds: 3600 },
  inputs: { sourceSha: sha, checkoutSha: sha, baseSha: sha, policySha: sha,
    sourceTreeDigest: digest, checkoutTreeDigest: digest, recipeDigest: digest,
    environmentDigest: digest, digest },
};
const original: OriginalExecution = {
  ref: { repository: context.repository, run: '123', attempt: 1, job: '456' },
  profile: 'unit-tests', sourceSha: sha, recipeDigest: digest, inputDigest: digest,
  completedAt: '2026-09-08T01:00:00.000Z',
};
const now = Date.parse('2026-09-08T01:01:00.000Z');
function port(candidate: OriginalExecution = original): ReuseExecutionPort {
  return {
    candidates: vi.fn(async () => ok([candidate.ref])),
    original: vi.fn(async () => ok(candidate)),
  };
}

describe('verification reuse decision', () => {
  it('uses only a verified original execution and rechecks current input identity before reuse', async () => {
    const current = vi.fn(async () => ok(context));
    const result = await decideVerificationReuse({ current, executions: port(), now });
    expect(result).toEqual({ mode: 'reuse', original: original.ref, completedAt: original.completedAt, inputDigest: digest });
    expect(current).toHaveBeenCalledTimes(2);
  });

  it('defaults to execution without an approved profile or complete inputs', async () => {
    const executions = port();
    expect((await decideVerificationReuse({ current: async () => ok({ ...context, profile: null }), executions, now })).mode).toBe('execute');
    expect((await decideVerificationReuse({ current: async () => fail('missing', 'Missing immutable inputs'), executions, now })).mode).toBe('execute');
    expect(executions.candidates).not.toHaveBeenCalled();
  });

  it('rejects incomplete fingerprints before asking for old executions', async () => {
    const executions = port();
    const incomplete = { ...context, inputs: { ...context.inputs, environmentDigest: '' } };
    expect((await decideVerificationReuse({ current: async () => ok(incomplete), executions, now })).mode).toBe('execute');
    expect(executions.candidates).not.toHaveBeenCalled();
  });

  it.each([
    { inputDigest: 'c'.repeat(64) }, { recipeDigest: 'c'.repeat(64) },
    { profile: 'deployment' }, { sourceSha: 'HEAD' },
    { completedAt: '2026-09-07T01:00:00.000Z' },
    { completedAt: '2026-09-09T01:00:00.000Z' }, { completedAt: 'not-a-date' },
    { ref: { ...original.ref, repository: 'gitlab:other.example/project' } },
  ])('executes when original provenance is ineligible: %j', async (change) => {
    expect((await decideVerificationReuse({ current: async () => ok(context), executions: port({ ...original, ...change }), now })).mode).toBe('execute');
  });

  it('does not turn a missing, failed or reused gate into an original execution', async () => {
    for (const code of ['job_failed', 'reuse_gate_not_execution', 'recipe_unproven', 'job_missing']) {
      const executions = port();
      executions.original = async () => fail(code, 'No verified original execution');
      expect((await decideVerificationReuse({ current: async () => ok(context), executions, now })).mode).toBe('execute');
    }
  });

  it('executes on incomplete discovery, duplicate references or a bound overflow', async () => {
    const cases: Evidence<ReuseExecutionRef[]>[] = [fail('pagination', 'Incomplete'), ok([original.ref, original.ref]),
      ok(Array.from({ length: 21 }, (_, index) => ({ ...original.ref, job: String(index + 1) })))];
    for (const refs of cases) {
      const executions = port();
      executions.candidates = async () => refs;
      expect((await decideVerificationReuse({ current: async () => ok(context), executions, now })).mode).toBe('execute');
    }
  });

  it('does not look past a newer failed execution to find an old green result', async () => {
    const newer = { ...original.ref, job: '789' };
    const executions = port();
    executions.candidates = async () => ok([newer, original.ref]);
    executions.original = vi.fn(async (ref: ReuseExecutionRef): Promise<Evidence<OriginalExecution>> => ref.job === newer.job ? fail('job_failed', 'Latest execution failed') : ok(original));
    expect((await decideVerificationReuse({ current: async () => ok(context), executions, now })).mode).toBe('execute');
    expect(executions.original).toHaveBeenCalledTimes(1);
  });

  it('refuses a changed head even when its normalized digest stayed equal during the probe', async () => {
    let calls = 0;
    const result = await decideVerificationReuse({
      current: async () => ok(++calls === 1 ? context : { ...context, inputs: { ...context.inputs, sourceSha: 'd'.repeat(40) } }),
      executions: port(), now,
    });
    expect(result.mode).toBe('execute');
  });

  it('retains original execution age instead of refreshing it to decision time', async () => {
    const result = await decideVerificationReuse({ current: async () => ok(context), executions: port(), now: now + 3_600_000 });
    expect(result.mode).toBe('execute');
  });
});
