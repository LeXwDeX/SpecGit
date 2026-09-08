import { describe, expect, it } from 'vitest';
import { parseScope, verifyScopeHistory } from '../../src/scope/declaration.js';

const scope = (required = [{ issue: 10, target: 'preview' }]) => JSON.stringify({ version: 1, name: 'programme', parent: 1, required });

describe('approved programme membership', () => {
  it('accepts arbitrary configured branch names and append-only additions', () => {
    const old = scope();
    const current = scope([{ issue: 10, target: 'preview' }, { issue: 11, target: 'release/stable' }]);
    expect(verifyScopeHistory('programme', [old, current])).toMatchObject({ ok: true, value: { required: [{ issue: 10 }, { issue: 11 }] } });
  });

  it.each([
    scope([{ issue: 11, target: 'preview' }]),
    scope([{ issue: 10, target: 'main' }]),
    JSON.stringify({ version: 1, name: 'programme', parent: 2, required: [{ issue: 10, target: 'preview' }] }),
  ])('rejects shrinking, retargeting, or replacing the parent', (current) => {
    expect(verifyScopeHistory('programme', [scope(), current])).toMatchObject({ ok: false, code: 'scope_amendment_unsupported' });
  });

  it('does not let deletion and reappearance erase required history', () => {
    expect(verifyScopeHistory('programme', [scope(), null, scope()])).toMatchObject({ ok: false });
  });

  it.each([
    { required: [] },
    { required: [{ issue: 1, target: 'main' }] },
    { required: [{ issue: 10, target: 'main' }, { issue: 10, target: 'main' }] },
    { required: [{ issue: 10, target: '--bad' }] },
    { required: [{ issue: 10, target: 'main', optional: true }] },
    { parent: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid scope declarations %j', (override) => {
    expect(parseScope('programme', JSON.stringify({ ...JSON.parse(scope()), ...override }))).toMatchObject({ ok: false, code: 'scope_invalid' });
  });

  it('rejects names that escape the declaration directory', () => {
    expect(parseScope('../policy', scope())).toMatchObject({ ok: false });
  });
});
