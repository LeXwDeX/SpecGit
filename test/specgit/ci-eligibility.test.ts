import { describe, expect, it } from 'vitest';
import { classifyCiEligibility } from '../../src/automation/ci-eligibility.js';
import { makeCheckRun } from './helpers/mock-forge.js';

describe('shared automation CI eligibility', () => {
  it('requires executed evidence even when no check names are required', () => {
    expect(classifyCiEligibility([], [])).toEqual({
      empty: true, missingRequired: [], executedCount: 0, problems: [], eligible: false,
    });
  });

  it('accepts successful executed checks covering every required name', () => {
    expect(classifyCiEligibility([makeCheckRun('Test'), makeCheckRun('Scan')], ['Test'])).toEqual({
      empty: false, missingRequired: [], executedCount: 2, problems: [], eligible: true,
    });
  });
  it('retains missing required names in policy order', () => {
    expect(classifyCiEligibility([makeCheckRun('Test')], ['Scan', 'Test', 'Deploy'])).toEqual({
      empty: false, missingRequired: ['Scan', 'Deploy'], executedCount: 1, problems: [], eligible: false,
    });
  });

  it('ignores completed optional skips but never treats an entirely skipped set as executed', () => {
    const skip = makeCheckRun('Optional', { conclusion: 'skipped' });
    expect(classifyCiEligibility([skip], [])).toEqual({
      empty: false, missingRequired: [], executedCount: 0, problems: [], eligible: false,
    });
    expect(classifyCiEligibility([skip, makeCheckRun('Test')], ['Test'])).toEqual({
      empty: false, missingRequired: [], executedCount: 1, problems: [], eligible: true,
    });
  });

  it.each(['skipped', 'neutral', 'failure', null])('rejects a completed required check with conclusion %j', (conclusion) => {
    const check = makeCheckRun('Test', { conclusion, allowFailure: true });
    expect(classifyCiEligibility([check], ['Test'])).toEqual({
      empty: false, missingRequired: [], executedCount: 1,
      problems: [{ kind: 'failed', check }], eligible: false,
    });
  });

  it('retains pending and failed problems in evidence order for caller-specific handling', () => {
    const waiting = makeCheckRun('Waiting', { status: 'queued', conclusion: null });
    const broken = makeCheckRun('Broken', { conclusion: 'failure', allowFailure: true });
    expect(classifyCiEligibility([waiting, makeCheckRun('Test'), broken], ['Test'])).toEqual({
      empty: false, missingRequired: [], executedCount: 3,
      problems: [{ kind: 'pending', check: waiting }, { kind: 'failed', check: broken }], eligible: false,
    });
    expect(classifyCiEligibility([broken, waiting], []).problems).toEqual([
      { kind: 'failed', check: broken }, { kind: 'pending', check: waiting },
    ]);
  });

  it('keeps a non-completed optional check pending even if its conclusion says skipped', () => {
    const check = makeCheckRun('Optional', { status: 'queued', conclusion: 'skipped' });
    expect(classifyCiEligibility([check], [])).toEqual({
      empty: false, missingRequired: [], executedCount: 1,
      problems: [{ kind: 'pending', check }], eligible: false,
    });
  });

});
