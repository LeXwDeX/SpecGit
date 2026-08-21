/**
 * #214 — anti-drift lock for the human surface.
 *
 * The accept/finish rendering passes diagnostic text through verbatim:
 * `verdictFailureLine` prints the gate failure's code and fix unchanged,
 * and `finishOutcome` prints the error message and fix unchanged. These
 * tests pin that pass-through BYTE-FOR-BYTE against the one registry the
 * text comes from (CODE_INFO) — the expectations are composed from the
 * registry itself, so the lock proves the terminal sees the registry's
 * bytes, not a hand-copied duplicate that could drift silently.
 *
 * Also locks the human branches the CLI suites had not pinned yet: the
 * unexpected-error catch path (runMain/wrap) in both text and JSON mode.
 */

import { describe, expect, it } from 'vitest';
import { runCliWith } from '../../src/cli/index.js';
import { EXIT_REJECTED, EXIT_UNKNOWN } from '../../src/cli/exit-codes.js';
import { CODE_INFO, type SpecGitCode } from '../../src/acceptance/codes.js';
import type { GateId } from '../../src/acceptance/evaluate.js';
import {
  makeCtx,
  makeEvaluate,
  makeVerdict,
  parseStdoutJson,
  sampleBinding,
  samplePolicy,
} from './helpers.js';

/** A rejected verdict whose one gate failure carries the registry's own text. */
function registryRejectedVerdict(gateId: GateId, code: SpecGitCode) {
  const info = CODE_INFO[code];
  return makeVerdict({
    accepted: false,
    state: 'rejected',
    classification: 'rejected',
    exitCode: EXIT_REJECTED,
    gates: [
      {
        id: gateId,
        status: 'fail',
        failures: [
          {
            code,
            message: info.message,
            ...(info.fix !== undefined ? { fix: info.fix } : {}),
          },
        ],
      },
    ],
  });
}

describe('human rendering: CODE_INFO pass-through is byte-verbatim (#214)', () => {
  it.each([
    ['pr', 'pr_draft'],
    ['checks', 'checks_failed'],
    ['closing', 'closing_refs_incomplete'],
  ] as const)('accept text mode renders %s/%s byte-identical to CODE_INFO', async (gateId, code) => {
    const info = CODE_INFO[code];
    const verdict = registryRejectedVerdict(gateId, code);
    const t = makeCtx({
      record: sampleBinding(),
      policy: samplePolicy(),
      evaluate: makeEvaluate(verdict),
    });
    const exit = await runCliWith(['node', 'specgit', 'accept'], t.ctx);
    expect(exit).toBe(EXIT_REJECTED);

    // The verdict failure line carries the registry's fix unchanged.
    const stdout = t.io.stdout.join('\n');
    expect(stdout).toContain(`  ${gateId}: ${code} — ${info.fix}`);

    // The stderr diagnostic block carries the registry's message and fix
    // unchanged — no wording owned outside CODE_INFO.
    const stderr = t.io.stderr.join('\n');
    expect(stderr).toContain(`Error: ${info.message}`);
    expect(stderr).toContain(`Fix: ${info.fix}`);
  });

  it('finish renders the same byte shapes as accept (evaluator parity)', async () => {
    const info = CODE_INFO.pr_draft;
    const verdict = registryRejectedVerdict('pr', 'pr_draft');
    const t = makeCtx({
      record: sampleBinding(),
      policy: samplePolicy(),
      evaluate: makeEvaluate(verdict),
    });
    const exit = await runCliWith(['node', 'specgit', 'finish'], t.ctx);
    expect(exit).toBe(EXIT_REJECTED);
    const stdout = t.io.stdout.join('\n');
    expect(stdout).toContain(`  pr: pr_draft — ${info.fix}`);
    expect(t.io.stderr.join('\n')).toContain(`Error: ${info.message}`);
  });

  it('the --json envelope carries the registry text through sanitize unchanged', async () => {
    const info = CODE_INFO.checks_failed;
    const verdict = registryRejectedVerdict('checks', 'checks_failed');
    const t = makeCtx({
      record: sampleBinding(),
      policy: samplePolicy(),
      evaluate: makeEvaluate(verdict),
    });
    const exit = await runCliWith(['node', 'specgit', 'accept', '--json'], t.ctx);
    expect(exit).toBe(EXIT_REJECTED);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors[0].code).toBe('checks_failed');
    expect(envelope.errors[0].message).toBe(info.message);
    expect(envelope.errors[0].fix).toBe(info.fix);
  });
});

describe('human rendering: the unexpected-error catch path (#214)', () => {
  function throwingCtx() {
    return makeCtx({
      record: sampleBinding(),
      policy: samplePolicy(),
      evaluate: async () => {
        throw new Error('boom\u0007');
      },
    });
  }

  it('text mode renders a sanitized Error line and exits 3', async () => {
    const t = throwingCtx();
    const exit = await runCliWith(['node', 'specgit', 'accept'], t.ctx);
    expect(exit).toBe(EXIT_UNKNOWN);
    // errorLine sanitizes: the control character never reaches the terminal.
    expect(t.io.stdout.join('\n')).toContain('Error: boom');
    expect(t.io.stdout.join('\n')).not.toContain('\u0007');
  });

  it('--json mode reports unexpected_error with the fail-closed exit', async () => {
    const t = throwingCtx();
    const exit = await runCliWith(['node', 'specgit', 'accept', '--json'], t.ctx);
    expect(exit).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.status).toBe('unknown');
    expect(envelope.exit).toBe(EXIT_UNKNOWN);
    expect(envelope.errors[0].code).toBe('unexpected_error');
    expect(envelope.errors[0].message).toBe('boom');
  });
});
