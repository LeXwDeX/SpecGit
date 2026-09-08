import { describe, expect, it, vi } from 'vitest';
import { runCliWith } from '../../src/cli/index.js';
import { EXIT_SUCCESS, EXIT_UNKNOWN, EXIT_USAGE } from '../../src/cli/exit-codes.js';
import { makeCtx, parseStdoutJson, sampleBinding, stdoutText } from './helpers.js';

vi.mock('@inquirer/prompts', () => ({ confirm: vi.fn(async () => false) }));

describe('specgit unbind', () => {
  it.each([
    ['unbind', '--json'],
    ['--json', 'unbind'],
  ])('requires --yes on a TTY for %s %s without a prompt (#390)', async (first, second) => {
    const { confirm } = await import('@inquirer/prompts');
    const t = makeCtx({ record: sampleBinding(), stdinIsTTY: true });
    const code = await runCliWith(['node', 'specgit', first, second], t.ctx);
    expect(code).toBe(EXIT_USAGE);
    expect(parseStdoutJson(t.io).errors[0].code).toBe('confirmation_required');
    expect(confirm).not.toHaveBeenCalled();
    expect(t.recordPort.deletes).toEqual([]);
  });

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

  // ---- #298: merged-delivery lifecycle — tracked records must not leave
  // a silent deletion residue in the working tree. ----

  it('warns when the record being deleted is tracked by git (#298)', async () => {
    const t = makeCtx({
      record: sampleBinding(),
      gitWrites: {
        trackedFiles: (paths) => ({ ok: true, value: [...paths] }),
      },
    });
    const code = await runCliWith(['node', 'specgit', 'unbind', '--yes', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    const warning = (envelope.warnings ?? []).find(
      (w: { code: string }) => w.code === 'record_deletion_tracked'
    );
    expect(warning).toBeDefined();
    expect(warning.fix).toContain('Commit');
    // The deletion itself still happens — the warning is guidance, not a block.
    expect(t.recordPort.deletes).toEqual(['/repo']);
  });

  it('stays silent when the record is untracked (the #292 default) (#298)', async () => {
    const t = makeCtx({
      record: sampleBinding(),
      gitWrites: {
        trackedFiles: () => ({ ok: true, value: [] }),
      },
    });
    const code = await runCliWith(['node', 'specgit', 'unbind', '--yes', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    const envelope = parseStdoutJson(t.io);
    expect(JSON.stringify(envelope.warnings ?? [])).not.toContain('record_deletion_tracked');
  });

  it('unbind still succeeds when the tracked probe fails closed (#298)', async () => {
    const t = makeCtx({
      record: sampleBinding(),
      gitWrites: {
        trackedFiles: () => ({ ok: false, code: 'tracked_probe_failed', message: 'no git' }),
      },
    });
    const code = await runCliWith(['node', 'specgit', 'unbind', '--yes', '--json'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    expect(t.recordPort.deletes).toEqual(['/repo']);
  });
});
