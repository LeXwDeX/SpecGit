import { describe, expect, it } from 'vitest';
import { runCliWith } from '../../src/cli/index.js';
import { sanitize } from '../../src/cli/output.js';
import { EXIT_REJECTED, EXIT_SUCCESS, EXIT_UNKNOWN, EXIT_USAGE } from '../../src/cli/exit-codes.js';
import { makeCtx, parseStdoutJson, stdoutText } from './helpers.js';

describe('CLI contract: exit codes', () => {
  it('exposes the stable exit-code constants', () => {
    expect(EXIT_SUCCESS).toBe(0);
    expect(EXIT_REJECTED).toBe(1);
    expect(EXIT_USAGE).toBe(2);
    expect(EXIT_UNKNOWN).toBe(3);
  });
});

describe('CLI contract: JSON envelope', () => {
  it('emits exactly one JSON document on stdout for usage errors in --json mode', async () => {
    const t = makeCtx();
    const code = await runCliWith(['node', 'specgit', 'bind', '--json'], t.ctx);
    expect(code).toBe(EXIT_USAGE);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.tool).toBe('specgit');
    expect(envelope.command).toBe('bind');
    expect(envelope.status).toBe('error');
    expect(envelope.version).toBe('0.0.0-test');
    expect(Array.isArray(envelope.errors)).toBe(true);
    expect(envelope.errors.length).toBeGreaterThan(0);
    expect(envelope.errors[0].severity).toBe('error');
    expect(envelope.errors[0].code).toBe('nothing_to_bind');
  });

  it('keeps human-readable text off stdout in --json mode', async () => {
    const t = makeCtx();
    await runCliWith(['node', 'specgit', 'bind', '--json'], t.ctx);
    const joined = t.io.stdout.join('');
    expect(joined.startsWith('{')).toBe(true);
    expect(() => JSON.parse(joined)).not.toThrow();
  });
});

describe('CLI contract: sanitization', () => {
  it('strips ANSI escapes and control characters', () => {
    const dirty = '\u001b[31mred\u0007bell\u0000null ok';
    expect(sanitize(dirty)).toBe('redbellnull ok');
  });

  it('truncates over-long strings', () => {
    const huge = 'x'.repeat(5000);
    const out = sanitize(huge);
    expect(out.length).toBeLessThan(5000);
    expect(out.endsWith('…')).toBe(true);
  });

  it('never lets injected control characters reach JSON error output', async () => {
    const t = makeCtx();
    const code = await runCliWith(
      ['node', 'specgit', 'bind', '--delivery', 'bad-id', '--issue', '\u001b[2MJIRA-9', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_USAGE);
    const raw = stdoutText(t.io);
    expect(raw.includes('\u001b')).toBe(false);
    const envelope = JSON.parse(raw);
    expect(envelope.errors[0].code).toBe('issue_ref_not_github');
    expect(envelope.errors[0].message.includes('\u001b')).toBe(false);
    expect(envelope.errors[0].message).toContain('JIRA-9');
  });
});

describe('CLI contract: usage surface', () => {
  it('rejects retired context flags on bind (--branch does not exist)', async () => {
    const t = makeCtx();
    const code = await runCliWith(
      ['node', 'specgit', 'bind', '--branch', 'feat/x', '--issue', '1', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_USAGE);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.status).toBe('error');
  });

  it('rejects retired context flags on bind (--worktree does not exist)', async () => {
    const t = makeCtx();
    const code = await runCliWith(
      ['node', 'specgit', 'bind', '--worktree', 'wt-1', '--issue', '1', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_USAGE);
  });

  it('help exits 0', async () => {
    const t = makeCtx();
    const code = await runCliWith(['node', 'specgit', '--help'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
  });

  it('version exits 0', async () => {
    const t = makeCtx();
    const code = await runCliWith(['node', 'specgit', '--version'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
  });

  it('registers exactly the six SpecGit commands', async () => {
    const t = makeCtx();
    await runCliWith(['node', 'specgit', '--help'], t.ctx);
    const help = stdoutText(t.io);
    for (const cmd of ['init', 'bind', 'unbind', 'status', 'accept', 'doctor']) {
      expect(help).toContain(cmd);
    }
  });
});
