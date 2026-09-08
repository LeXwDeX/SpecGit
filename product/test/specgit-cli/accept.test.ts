import { describe, expect, it } from 'vitest';
import { runCliWith } from '../../src/cli/index.js';
import {
  EXIT_REJECTED,
  EXIT_SUCCESS,
  EXIT_UNKNOWN,
  EXIT_USAGE,
} from '../../src/cli/exit-codes.js';
import {
  makeCtx,
  makeEvaluate,
  makeVerdict,
  parseStdoutJson,
  sampleBinding,
  samplePolicy,
} from './helpers.js';

describe('specgit accept (G1-G10 via the evaluator)', () => {
  it('exits 0 when the evaluator accepts', async () => {
    const verdict = makeVerdict({
      gates: [{ id: 'checks', status: 'pass', failures: [] }],
    });
    const evaluate = makeEvaluate(verdict);
    const t = makeCtx({ record: sampleBinding(), policy: samplePolicy(), evaluate });
    const code = await runCliWith(['node', 'specgit', 'accept', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.status).toBe('ok');
    expect(envelope.state).toBe('accepted');
    expect(envelope.verdict.accepted).toBe(true);
    expect(envelope.verdict.gates).toEqual([{ id: 'checks', status: 'pass', failures: [] }]);
    expect(envelope.verdict.evidence.repo).toBe('LeXwDeX/SpecGit');
  });

  it('exits 1 when the evaluator rejects with complete evidence', async () => {
    const verdict = makeVerdict({
      accepted: false,
      state: 'rejected',
      classification: 'rejected',
      exitCode: 1,
      gates: [
        {
          id: 'closing',
          status: 'fail',
          failures: [
            {
              code: 'closing_refs_incomplete',
              message: 'The PR body does not close every bound issue.',
              detail: { missing: [124] },
              fix: 'Add "Closes #124" to the PR body.',
            },
          ],
        },
      ],
    });
    const evaluate = makeEvaluate(verdict);
    const t = makeCtx({
      record: sampleBinding({ issues: [123, 124] }),
      policy: samplePolicy(),
      evaluate,
    });
    const code = await runCliWith(['node', 'specgit', 'accept', '--json'], t.ctx);
    expect(code).toBe(EXIT_REJECTED);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.status).toBe('rejected');
    expect(envelope.verdict.accepted).toBe(false);
    expect(envelope.verdict.gates[0].failures[0].detail).toEqual({ missing: [124] });
  });

  it('exits 3 when evidence cannot be determined', async () => {
    const verdict = makeVerdict({
      accepted: false,
      state: 'unknown',
      classification: 'unknown',
      exitCode: 3,
      complete: false,
      gates: [{ id: 'provider', status: 'fail', failures: [{ code: 'gh_transport', message: 'gh failed.' }] }],
    });
    const evaluate = makeEvaluate(verdict);
    const t = makeCtx({ record: sampleBinding(), policy: samplePolicy(), evaluate });
    const code = await runCliWith(['node', 'specgit', 'accept', '--json'], t.ctx);
    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.status).toBe('unknown');
  });

  it('passes root, record, policy, git port, and provider to the evaluator', async () => {
    const binding = sampleBinding();
    const policy = samplePolicy();
    const evaluate = makeEvaluate(makeVerdict());
    const t = makeCtx({ record: binding, policy, evaluate });
    await runCliWith(['node', 'specgit', 'accept', '--json'], t.ctx);
    expect(evaluate.calls).toHaveLength(1);
    const input = evaluate.calls[0];
    expect(input.root).toEqual({ ok: true, value: '/repo' });
    expect(input.record).toEqual({ ok: true, value: binding });
    expect(input.policy).toEqual({ ok: true, value: policy });
    expect(input.git).toBe(t.gitPort);
    expect(input.gh).toBe(t.ghProvider);
  });

  it('hands a missing record to the evaluator as fail-closed evidence', async () => {
    const verdict = makeVerdict({
      accepted: false,
      state: 'unbound',
      classification: 'unknown',
      exitCode: 3,
      complete: false,
      gates: [
        {
          id: 'record',
          status: 'fail',
          failures: [{ code: 'record_missing', message: 'No delivery binding found.' }],
        },
      ],
    });
    const evaluate = makeEvaluate(verdict);
    const t = makeCtx({ policy: samplePolicy(), evaluate });
    const code = await runCliWith(['node', 'specgit', 'accept', '--json'], t.ctx);
    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.status).toBe('unknown');
    expect(envelope.verdict.gates[0].failures[0].code).toBe('record_missing');
    expect(evaluate.calls[0].record.ok).toBe(false);
    if (!evaluate.calls[0].record.ok) {
      expect(evaluate.calls[0].record.code).toBe('record_missing');
    }
  });

  it('hands a missing policy to the evaluator as fail-closed evidence', async () => {
    const verdict = makeVerdict({
      accepted: false,
      state: 'bound',
      classification: 'unknown',
      exitCode: 3,
      complete: false,
      gates: [
        { id: 'record', status: 'pass', failures: [] },
        {
          id: 'policy',
          status: 'fail',
          failures: [{ code: 'policy_missing', message: 'No policy found.' }],
        },
      ],
    });
    const evaluate = makeEvaluate(verdict);
    const t = makeCtx({ record: sampleBinding(), evaluate });
    const code = await runCliWith(['node', 'specgit', 'accept', '--json'], t.ctx);
    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.verdict.gates[1].failures[0].code).toBe('policy_missing');
    expect(evaluate.calls[0].policy.ok).toBe(false);
  });

  it('fails closed (exit 3) outside a git repository without evaluating', async () => {
    const evaluate = makeEvaluate(makeVerdict());
    const t = makeCtx({
      root: { ok: false, code: 'not_a_git_repo', message: 'Not a git repository.' },
      evaluate,
    });
    const code = await runCliWith(['node', 'specgit', 'accept', '--json'], t.ctx);
    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors[0].code).toBe('not_a_git_repo');
    expect(evaluate.calls).toHaveLength(0);
  });

  it('prints a human verdict line in text mode', async () => {
    const verdict = makeVerdict({
      accepted: false,
      state: 'rejected',
      classification: 'rejected',
      exitCode: 1,
      gates: [
        {
          id: 'checks',
          status: 'fail',
          failures: [
            {
              code: 'checks_failed',
              message: 'A required check failed.',
              detail: { name: 'Test', conclusion: 'failure' },
            },
          ],
        },
      ],
    });
    const evaluate = makeEvaluate(verdict);
    const t = makeCtx({ record: sampleBinding(), policy: samplePolicy(), evaluate });
    const code = await runCliWith(['node', 'specgit', 'accept'], t.ctx);
    expect(code).toBe(EXIT_REJECTED);
    expect(t.io.stdout.join('\n')).toMatch(/reject/i);
  });

  it('usage errors exit 2 (unknown flag)', async () => {
    const t = makeCtx({ record: sampleBinding(), policy: samplePolicy() });
    const code = await runCliWith(['node', 'specgit', 'accept', '--bogus', '--json'], t.ctx);
    expect(code).toBe(EXIT_USAGE);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.status).toBe('error');
  });
});
