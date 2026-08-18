import { describe, expect, it } from 'vitest';
import { runCliWith } from '../../src/cli/index.js';
import { EXIT_SUCCESS, EXIT_UNKNOWN, EXIT_USAGE } from '../../src/cli/exit-codes.js';
import { SPEC_GIT_DIR, POLICY_FILENAME } from '../../src/cli/types.js';
import { makeCtx, parseStdoutJson, stdoutText } from './helpers.js';

describe('specgit init', () => {
  it('creates spec_git/policy.yaml with the declared required checks', async () => {
    const t = makeCtx();
    const code = await runCliWith(
      [
        'node', 'specgit', 'init',
        '--required-check', 'Test',
        '--required-check', 'All checks passed',
      ],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);
    expect(t.recordPort.policyWrites).toHaveLength(1);
    expect(t.recordPort.policyWrites[0]).toEqual({
      root: '/repo',
      policy: { version: 1, required_checks: ['Test', 'All checks passed'] },
    });
    expect(t.recordPort.recordWrites).toHaveLength(0);
  });

  it('prints a human summary with the spec_git path', async () => {
    const t = makeCtx();
    await runCliWith(['node', 'specgit', 'init', '--required-check', 'Test'], t.ctx);
    expect(stdoutText(t.io)).toContain(SPEC_GIT_DIR);
    expect(stdoutText(t.io)).toContain(POLICY_FILENAME);
  });

  it('emits a JSON envelope in --json mode', async () => {
    const t = makeCtx();
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.status).toBe('ok');
    expect(envelope.command).toBe('init');
    expect(envelope.policy).toEqual({ version: 1, required_checks: ['Test'] });
  });

  it('fails usage in non-TTY when no --required-check is given', async () => {
    const t = makeCtx({ stdinIsTTY: false });
    const code = await runCliWith(['node', 'specgit', 'init', '--json'], t.ctx);
    expect(code).toBe(EXIT_USAGE);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors[0].code).toBe('required_check_required');
    expect(t.recordPort.policyWrites).toHaveLength(0);
  });

  it('does not overwrite an existing policy', async () => {
    const t = makeCtx({ policy: { version: 1, required_checks: ['Existing'] } });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'New', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_USAGE);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors[0].code).toBe('policy_exists');
    expect(t.recordPort.policyWrites).toHaveLength(0);
  });

  it('fails usage when a required check name is empty', async () => {
    const t = makeCtx();
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', ' ', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_USAGE);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors[0].code).toBe('required_check_invalid');
  });

  it('fails closed (exit 3) outside a git repository', async () => {
    const t = makeCtx({ root: { ok: false, code: 'not_a_git_repo', message: 'Not a git repository.' } });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.status).toBe('unknown');
    expect(envelope.errors[0].code).toBe('not_a_git_repo');
  });
});
