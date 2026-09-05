/**
 * `specgit finish` — the human/CI verdict command. Contract: same
 * evaluator as `specgit accept` (which stays as the script alias);
 * finish only changes the command name in the envelope.
 */

import { describe, expect, it } from 'vitest';
import { runCliWith } from '../../src/cli/index.js';
import { runFinish } from '../../src/cli/commands/finish.js';
import { makeCtx, makeEvaluate, makeVerdict, parseStdoutJson, samplePolicy } from './helpers.js';

describe('specgit finish: evaluator parity with accept', () => {
  it('delegates to the same evaluation and reports command "finish"', async () => {
    const evaluate = makeEvaluate(makeVerdict());
    const t = makeCtx({ evaluate });
    const code = await runCliWith(['node', 'specgit', 'finish', '--json'], t.ctx);

    expect(code).toBe(0);
    expect(evaluate.calls.length).toBe(1);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.command).toBe('finish');
    expect(envelope.status).toBe('ok');
    expect(envelope.verdict.accepted).toBe(true);
  });

  // #361: an accepted LIVE delivery hands off the merge (auto-merge per
  // policy); completed history hands off the next delivery instead.
  it('accepted live PR: nextActions name the auto-merge (#361)', async () => {
    const accepted = makeVerdict({
      accepted: true,
      state: 'accepted',
      classification: 'accepted',
      exitCode: 0,
      complete: true,
    });
    const t = makeCtx({ evaluate: makeEvaluate(accepted) });
    const code = await runCliWith(['node', 'specgit', 'finish', '--json'], t.ctx);
    expect(code).toBe(0);
    const envelope = parseStdoutJson(t.io);
    const actions = envelope.nextActions ?? [];
    expect(actions.map((a: any) => a.code)).toEqual(['delivery_merge']);
    expect(actions[0].command).toContain('gh pr merge 42 --auto --merge');
    expect(String(actions[0].reason)).not.toContain('unbind');
  });

  it.each(['accepted', 'completed'] as const)('configured automation hands off %s without performing writes (#382)', async (state) => {
    const t = makeCtx({
      policy: samplePolicy({ automation: { merge: true, target_branch: 'main', close_issues: true } }),
      evaluate: makeEvaluate(makeVerdict({ state })),
    });
    expect(await runCliWith(['node', 'specgit', 'finish', '--json'], t.ctx)).toBe(0);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.nextActions).toMatchObject(state === 'completed'
      ? [{ code: 'next_delivery', command: 'specgit issue "<type>: <title>"' }]
      : [{ code: 'delivery_merge', command: 'specgit pr --merge' }]);
    expect(t.ghProvider.calls).toEqual([]);
    expect(t.recordPort.recordWrites).toEqual([]);
    expect(t.gitPort.pushCalls).toEqual([]);
  });

  it('completed history: nextActions name the next delivery, never unbind (#361)', async () => {
    const completed = makeVerdict({
      accepted: true,
      state: 'completed',
      classification: 'accepted',
      exitCode: 0,
      complete: true,
    });
    const t = makeCtx({ evaluate: makeEvaluate(completed) });
    const code = await runCliWith(['node', 'specgit', 'finish', '--json'], t.ctx);
    expect(code).toBe(0);
    const envelope = parseStdoutJson(t.io);
    const actions = envelope.nextActions ?? [];
    expect(actions.map((a: any) => a.code)).toEqual(['next_delivery']);
    expect(actions[0].command).toContain('specgit issue');
    expect(String(actions[0].command)).not.toContain('unbind');
  });

  it.each([
    { language: 'en' as const, reason: 'The PR/MR is merged' },
    { language: 'zh' as const, reason: 'PR/MR 已合并' },
  ])('closure-pending hand-off keeps delivery_finalize and localizes its reason ($language)', async ({ language, reason }) => {
    const closurePending = makeVerdict({
      accepted: true,
      state: 'closure_pending',
      classification: 'accepted',
      exitCode: 0,
      complete: true,
    });
    const t = makeCtx({
      policy: samplePolicy({ language, automation: { merge: false, close_issues: false } }),
      evaluate: makeEvaluate(closurePending),
    });

    expect(await runCliWith(['node', 'specgit', 'finish', '--json'], t.ctx)).toBe(0);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.nextActions).toEqual([
      expect.objectContaining({
        code: 'delivery_finalize',
        command: 'specgit finish --json',
        reason: expect.stringContaining(reason),
      }),
    ]);
  });

  it('propagates rejected verdicts with exit 1 and the gate evidence', async () => {
    const rejected = makeVerdict({
      accepted: false,
      state: 'rejected',
      classification: 'rejected',
      exitCode: 1,
      complete: true,
    });
    const evaluate = makeEvaluate(rejected);
    const t = makeCtx({ evaluate });
    const code = await runCliWith(['node', 'specgit', 'finish', '--json'], t.ctx);

    expect(code).toBe(1);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.status).toBe('rejected');
  });

  it('produces the identical exit code and verdict as accept on the same context', async () => {
    const unknown = makeVerdict({
      accepted: false,
      state: 'unknown',
      classification: 'unknown',
      exitCode: 3,
      complete: false,
    });
    const finishCtx = makeCtx({ evaluate: makeEvaluate(unknown) });
    const acceptCtx = makeCtx({ evaluate: makeEvaluate(unknown) });

    const finishCode = await runCliWith(['node', 'specgit', 'finish', '--json'], finishCtx.ctx);
    const acceptCode = await runCliWith(['node', 'specgit', 'accept', '--json'], acceptCtx.ctx);

    expect(finishCode).toBe(acceptCode);
    expect(finishCode).toBe(3);
    const finishEnvelope = parseStdoutJson(finishCtx.io);
    const acceptEnvelope = parseStdoutJson(acceptCtx.io);
    expect(finishEnvelope.verdict).toEqual(acceptEnvelope.verdict);
    expect(finishEnvelope.command).toBe('finish');
    expect(acceptEnvelope.command).toBe('accept');
  });

  it('runs the command function directly against the accept path', async () => {
    const evaluate = makeEvaluate(makeVerdict());
    const t = makeCtx({ evaluate });
    const outcome = await runFinish({ json: true }, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(outcome.verdict?.classification).toBe('accepted');
  });
});
