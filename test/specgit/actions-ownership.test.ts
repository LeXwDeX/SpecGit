import { describe, expect, it } from 'vitest';
import { createActionsOwnership } from '../../src/harness-runtime/actions-ownership.mjs';

describe('shared Actions execution ownership', () => {
  it('selects the newer workflow owner while retaining pending state for the caller', () => {
    const previous = { key: 'workflow:12:pull_request', checkSuiteId: 31, runAttempt: 1,
      check: { id: 41, startedAt: '2026-09-04T16:19:01Z', status: 'completed' } };
    const current = { ...previous, checkSuiteId: 32, check: { ...previous.check, id: 42, status: 'in_progress' } };
    const ownership = createActionsOwnership([previous, current]);
    expect(ownership.currentFor(31)).toBeNull();
    expect(ownership.currentFor(32)).toBe(current);
    expect(ownership.latest).toEqual([current]);
  });
});
