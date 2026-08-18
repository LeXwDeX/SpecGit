import { describe, expect, it } from 'vitest';
import { runCliWith } from '../../src/cli/index.js';
import { EXIT_SUCCESS, EXIT_UNKNOWN, EXIT_USAGE } from '../../src/cli/exit-codes.js';
import { makeCtx, parseStdoutJson, sampleBinding, stdoutText } from './helpers.js';

describe('specgit unbind', () => {
  it('deletes the record with --yes', async () => {
    const t = makeCtx({ record: sampleBinding() });
    const code = await runCliWith(['node', 'specgit', 'unbind', '--yes'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    expect(t.recordPort.deletes).toEqual(['/repo']);
    expect(stdoutText(t.io)).toContain('.specgit.yaml');
  });

  it('emits a JSON envelope in --json mode', async () => {
    const t = makeCtx({ record: sampleBinding() });
    const code = await runCliWith(['node', 'specgit', 'unbind', '--yes', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.status).toBe('ok');
    expect(envelope.command).toBe('unbind');
  });

  it('requires confirmation in non-TTY mode', async () => {
    const t = makeCtx({ record: sampleBinding(), stdinIsTTY: false });
    const code = await runCliWith(['node', 'specgit', 'unbind', '--json'], t.ctx);
    expect(code).toBe(EXIT_USAGE);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors[0].code).toBe('confirmation_required');
    expect(t.recordPort.deletes).toEqual([]);
  });

  it('fails usage when there is no record to unbind', async () => {
    const t = makeCtx();
    const code = await runCliWith(['node', 'specgit', 'unbind', '--yes', '--json'], t.ctx);
    expect(code).toBe(EXIT_USAGE);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors[0].code).toBe('record_missing');
  });

  it('fails closed (exit 3) when the record is invalid', async () => {
    const t = makeCtx({ record: 'invalid' });
    const code = await runCliWith(['node', 'specgit', 'unbind', '--yes', '--json'], t.ctx);
    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors[0].code).toBe('record_invalid');
  });
});
