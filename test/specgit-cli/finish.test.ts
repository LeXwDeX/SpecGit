/**
 * `specgit finish` — the human/CI verdict command. Contract: same
 * evaluator as `specgit accept` (which stays as the script alias);
 * finish only changes the command name in the envelope.
 */

import { describe, expect, it } from 'vitest';
import { runCliWith } from '../../src/cli/index.js';
import { runFinish } from '../../src/cli/commands/finish.js';
import { makeCtx, makeEvaluate, makeVerdict, parseStdoutJson } from './helpers.js';

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
