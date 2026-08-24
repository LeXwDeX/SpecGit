/**
 * Issue #179: `CommandOutcome` is a union of per-command outcome subtypes,
 * so a command can only set the fields it actually emits. This file pins
 * those shapes twice: at the type level (foreign fields must be compile
 * errors, `@ts-expect-error` fails the run if a shape loosens) and at
 * runtime (`buildEnvelope` key order and presence stay byte-identical).
 */

import { describe, expect, it } from 'vitest';
import {
  buildEnvelope,
  type AcceptOutcome,
  type BindOutcome,
  type CommandOutcome,
  type DoctorOutcome,
  type InitOutcome,
  type IssueOutcome,
  type PrOutcome,
  type SetupOutcome,
  type StatusOutcome,
  type UnbindOutcome,
} from '../../src/cli/output.js';
import type { Diagnostic, GateResult, Verdict } from '../../src/cli/types.js';

const VERSION = '0.0.0-test';

const diagnostic: Diagnostic = { severity: 'error', code: 'x', message: 'm' };
const gate: GateResult = { id: 'record', status: 'pass', failures: [] };

describe('per-command outcome shapes (#179)', () => {
  it('every per-command outcome assigns to CommandOutcome', () => {
    const outcomes: CommandOutcome[] = [
      { exit: 0 } satisfies AcceptOutcome,
      { exit: 0, state: 'bound', record: { pr: 1 } } satisfies BindOutcome,
      { exit: 0, state: 'unbound' } satisfies UnbindOutcome,
      { exit: 0, state: 'bound', record: {} } satisfies IssueOutcome,
      { exit: 0, state: 'bound', record: {} } satisfies PrOutcome,
      { exit: 0, state: 'bound', gates: [gate], evidence: {}, assets: {} } satisfies StatusOutcome,
      { exit: 0, probes: [{ name: 'git', ok: true }] } satisfies DoctorOutcome,
      { exit: 0, assets: { tool: 'generic' } } satisfies SetupOutcome,
      // #307: setup assets carry the reconciliation report additively.
      {
        exit: 0,
        assets: {
          tool: 'generic',
          installed: [],
          reconciled: { created: [], updated: [], removed: [], preserved: [] },
        },
      } satisfies SetupOutcome,
      { exit: 0, policy: { version: 1, required_checks: [] }, harness: {}, platform: {} } satisfies InitOutcome,
    ];
    expect(outcomes).toHaveLength(10);
  });

  it('accept/finish outcomes reject fields they do not emit', () => {
    // @ts-expect-error record belongs to bind/issue/pr, not accept/finish (#179)
    const record: AcceptOutcome = { exit: 0, record: {} as never };
    // @ts-expect-error probes belongs to doctor (#179)
    const probes: AcceptOutcome = { exit: 0, probes: [] as never };
    // @ts-expect-error policy belongs to init (#179)
    const policy: AcceptOutcome = { exit: 0, policy: {} as never };
    expect(record).toBeDefined();
    expect(probes).toBeDefined();
    expect(policy).toBeDefined();
  });

  it('bind outcomes reject fields bind does not emit', () => {
    // @ts-expect-error verdict belongs to accept/finish (#179)
    const verdict: BindOutcome = { exit: 0, verdict: {} as never };
    // @ts-expect-error gates belongs to status (#179)
    const gates: BindOutcome = { exit: 0, gates: [] as never };
    // @ts-expect-error assets belongs to status/setup (#179)
    const assets: BindOutcome = { exit: 0, assets: {} as never };
    expect(verdict).toBeDefined();
    expect(gates).toBeDefined();
    expect(assets).toBeDefined();
  });

  it('unbind outcomes reject fields unbind does not emit', () => {
    // @ts-expect-error record belongs to bind/issue/pr (#179)
    const record: UnbindOutcome = { exit: 0, record: {} as never };
    // @ts-expect-error verdict belongs to accept/finish (#179)
    const verdict: UnbindOutcome = { exit: 0, verdict: {} as never };
    expect(record).toBeDefined();
    expect(verdict).toBeDefined();
  });

  it('issue outcomes reject fields issue does not emit', () => {
    // @ts-expect-error verdict belongs to accept/finish (#179)
    const verdict: IssueOutcome = { exit: 0, verdict: {} as never };
    // @ts-expect-error probes belongs to doctor (#179)
    const probes: IssueOutcome = { exit: 0, probes: [] as never };
    expect(verdict).toBeDefined();
    expect(probes).toBeDefined();
  });

  it('pr outcomes reject fields pr does not emit', () => {
    // @ts-expect-error verdict belongs to accept/finish (#179)
    const verdict: PrOutcome = { exit: 0, verdict: {} as never };
    // @ts-expect-error detected belongs to init (#179)
    const detected: PrOutcome = { exit: 0, detected: {} as never };
    expect(verdict).toBeDefined();
    expect(detected).toBeDefined();
  });

  it('status outcomes reject fields status does not emit', () => {
    // @ts-expect-error verdict belongs to accept/finish (#179)
    const verdict: StatusOutcome = { exit: 0, verdict: {} as never };
    // @ts-expect-error record belongs to bind/issue/pr (#179)
    const record: StatusOutcome = { exit: 0, record: {} as never };
    // @ts-expect-error probes belongs to doctor (#179)
    const probes: StatusOutcome = { exit: 0, probes: [] as never };
    expect(verdict).toBeDefined();
    expect(record).toBeDefined();
    expect(probes).toBeDefined();
  });

  it('doctor outcomes reject fields doctor does not emit', () => {
    // @ts-expect-error state belongs to binding commands, not doctor (#179)
    const state: DoctorOutcome = { exit: 0, state: 'bound' as never };
    // @ts-expect-error gates belongs to status (#179)
    const gates: DoctorOutcome = { exit: 0, gates: [] as never };
    expect(state).toBeDefined();
    expect(gates).toBeDefined();
  });

  it('setup outcomes reject fields setup does not emit', () => {
    // @ts-expect-error record belongs to bind/issue/pr (#179)
    const record: SetupOutcome = { exit: 0, record: {} as never };
    // @ts-expect-error harness belongs to init (#179)
    const harness: SetupOutcome = { exit: 0, harness: {} as never };
    expect(record).toBeDefined();
    expect(harness).toBeDefined();
  });

  it('init outcomes reject fields init does not emit', () => {
    // @ts-expect-error state belongs to binding commands, not init (#179)
    const state: InitOutcome = { exit: 0, state: 'bound' as never };
    // @ts-expect-error probes belongs to doctor (#179)
    const probes: InitOutcome = { exit: 0, probes: [] as never };
    // @ts-expect-error assets belongs to status/setup (#179)
    const assets: InitOutcome = { exit: 0, assets: {} as never };
    expect(state).toBeDefined();
    expect(probes).toBeDefined();
    expect(assets).toBeDefined();
  });
});

describe('buildEnvelope byte-identical emission (#179)', () => {
  it('emits the documented key order for a full init outcome', () => {
    const outcome: InitOutcome = {
      exit: 0,
      warnings: [{ severity: 'warning', code: 'w', message: 'wm' }],
      policy: { version: 1, required_checks: ['ci'] },
      detected: { fallback: false },
      protection: { enabled: true },
      platform: { mode: 'github' },
      harness: { template: 'local' },
      human: ['never in the envelope'],
    };
    const json = JSON.stringify(buildEnvelope('init', VERSION, outcome), null, 2);
    expect(json).toBe(
      [
        '{',
        '  "tool": "specgit",',
        `  "version": "${VERSION}",`,
        '  "command": "init",',
        '  "status": "ok",',
        '  "exit": 0,',
        '  "warnings": [',
        '    {',
        '      "severity": "warning",',
        '      "code": "w",',
        '      "message": "wm"',
        '    }',
        '  ],',
        '  "policy": {',
        '    "version": 1,',
        '    "required_checks": [',
        '      "ci"',
        '    ]',
        '  },',
        '  "detected": {',
        '    "fallback": false',
        '  },',
        '  "protection": {',
        '    "enabled": true',
        '  },',
        '  "platform": {',
        '    "mode": "github"',
        '  },',
        '  "harness": {',
        '    "template": "local"',
        '  }',
        '}',
      ].join('\n')
    );
  });

  it('emits state/gates/evidence/assets in order for a status outcome', () => {
    const outcome: StatusOutcome = {
      exit: 0,
      state: 'bound',
      gates: [gate],
      evidence: { root: '/repo' },
      assets: { tiers: 3 },
      human: ['never in the envelope'],
    };
    const envelope = buildEnvelope('status', VERSION, outcome);
    expect(Object.keys(envelope)).toEqual([
      'tool',
      'version',
      'command',
      'status',
      'exit',
      'state',
      'gates',
      'evidence',
      'assets',
    ]);
  });

  it('emits state/verdict/errors/warnings in order for an accept outcome', () => {
    const verdict = {
      accepted: false,
      state: 'rejected',
      classification: 'rejected',
      exitCode: 1,
      complete: true,
      gates: [gate],
      evidence: {},
      warnings: [],
    } as unknown as Verdict;
    const outcome: AcceptOutcome = {
      exit: 1,
      state: 'rejected',
      verdict,
      errors: [diagnostic],
      warnings: [{ severity: 'warning', code: 'w', message: 'wm' }],
      human: ['never in the envelope'],
    };
    const envelope = buildEnvelope('accept', VERSION, outcome);
    expect(Object.keys(envelope)).toEqual([
      'tool',
      'version',
      'command',
      'status',
      'exit',
      'state',
      'verdict',
      'errors',
      'warnings',
    ]);
  });

  it('omits absent optional fields and never emits human', () => {
    const outcome: DoctorOutcome = {
      exit: 0,
      probes: [{ name: 'git', ok: true }],
      errors: undefined,
      human: ['ok    git'],
    };
    const envelope = buildEnvelope('doctor', VERSION, outcome);
    expect(Object.keys(envelope)).toEqual([
      'tool',
      'version',
      'command',
      'status',
      'exit',
      'probes',
    ]);
    expect('human' in envelope).toBe(false);
  });
});
