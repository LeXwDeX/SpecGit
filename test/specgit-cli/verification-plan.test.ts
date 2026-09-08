import { describe, expect, it, vi } from 'vitest';
import { runCliWith } from '../../src/cli/index.js';
import { ok } from '../../src/kernel/evidence.js';
import { makeCtx, parseStdoutJson, sampleBinding, samplePolicy } from './helpers.js';
import { makePrFact } from '../specgit/helpers/mock-forge.js';

function fixture() {
  const t = makeCtx({ record: sampleBinding(), policy: samplePolicy() });
  t.ctx.gh.getPr = vi.fn(async () => ok(makePrFact({ headSha: 'abc123', baseBranch: 'main' })));
  return t;
}

describe('finish --plan-checks', () => {
  it('returns a separate read-only decision for existing fixed checks', async () => {
    const t = fixture();
    expect(await runCliWith(['node', 'specgit', 'finish', '--plan-checks', '--json'], t.ctx)).toBe(0);
    const result = parseStdoutJson(t.io);
    expect(result.verification).toMatchObject({ kind: 'fixed', requiredChecks: ['All checks passed'] });
    expect(result.verdict).toBeUndefined();
    expect(t.recordPort.recordWrites).toEqual([]);
    expect(t.gitPort.pushCalls).toEqual([]);
    expect(t.ctx.git.changesBetween).not.toHaveBeenCalled();
  });

  it('rejects combining a delivery verification plan with an aggregate scope', async () => {
    const t = fixture();
    expect(await runCliWith(['node', 'specgit', 'finish', '--plan-checks', '--scope', 'programme', '--json'], t.ctx)).toBe(2);
    expect(parseStdoutJson(t.io).errors[0].code).toBe('usage_error');
  });

  it('does not plan checks for a newer remote head than the checkout', async () => {
    const t = fixture();
    const pr = await t.ctx.gh.getPr({ platform: 'github', owner: 'o', repo: 'r' }, 42);
    if (!pr.ok) throw new Error(pr.message);
    t.ctx.gh.getPr = vi.fn(async () => ok({ ...pr.value, headSha: 'b'.repeat(40) }));
    expect(await runCliWith(['node', 'specgit', 'finish', '--plan-checks', '--json'], t.ctx)).toBe(3);
    expect(parseStdoutJson(t.io).errors[0].code).toBe('verification_changes_unavailable');
  });
});
