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

  it('registers exactly the ten SpecGit commands', async () => {
    const t = makeCtx();
    await runCliWith(['node', 'specgit', '--help'], t.ctx);
    const help = stdoutText(t.io);
    for (const cmd of ['init', 'setup', 'issue', 'pr', 'finish', 'bind', 'unbind', 'status', 'accept', 'doctor']) {
      expect(help, `help must mention ${cmd}`).toMatch(new RegExp(`\\b${cmd}\\b`));
    }
  });
});

describe('CLI contract: ten-command surface (#69)', () => {
  it('exports the command registry as exactly ten commands in a stable order', async () => {
    const { COMMAND_NAMES } = await import('../../src/cli/index.js');
    expect(COMMAND_NAMES).toBeDefined();
    expect(COMMAND_NAMES).toEqual([
      'init',
      'setup',
      'issue',
      'pr',
      'finish',
      'bind',
      'unbind',
      'status',
      'accept',
      'doctor',
    ]);
  });

  it('setup is a public command with help of its own', async () => {
    const t = makeCtx();
    const code = await runCliWith(['node', 'specgit', 'setup', '--help'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    const help = stdoutText(t.io);
    expect(help).toMatch(/entry points/i);
  });

  it.each([
    ['bind', /script alias/i],
    ['unbind', /script alias/i],
    ['accept', /alias/i],
  ])('%s help presents it as an automation alias', async (cmd, pattern) => {
    const t = makeCtx();
    const code = await runCliWith(['node', 'specgit', cmd, '--help'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);
    expect(stdoutText(t.io)).toMatch(pattern);
  });

  it('top-level help documents the SPECGIT_GH and SPECGIT_GH_TIMEOUT_MS seams', async () => {
    const t = makeCtx();
    await runCliWith(['node', 'specgit', '--help'], t.ctx);
    const help = stdoutText(t.io);
    expect(help).toContain('SPECGIT_GH');
    expect(help).toContain('SPECGIT_GH_TIMEOUT_MS');
  });
});

describe('CLI contract: interruption exit 130 (#69)', () => {
  it('defines EXIT_INTERRUPTED = 130 outside the 0/1/2/3 product contract', async () => {
    const { EXIT_INTERRUPTED } = await import('../../src/cli/exit-codes.js');
    expect(EXIT_INTERRUPTED).toBe(130);
  });

  it('emitInterrupted writes only to stderr and never a JSON envelope', async () => {
    const { emitInterrupted } = await import('../../src/cli/output.js');
    const out: string[] = [];
    const err: string[] = [];
    const code = emitInterrupted({
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    });
    expect(code).toBe(130);
    expect(out).toEqual([]);
    expect(err).toEqual(['Interrupted.']);
  });

  it('top-level help documents the Ctrl-C 130 exception', async () => {
    const t = makeCtx();
    await runCliWith(['node', 'specgit', '--help'], t.ctx);
    expect(stdoutText(t.io)).toContain('130');
  });
});

describe('CLI contract: gate surface truth (#69)', () => {
  it('GATE_ORDER is eleven gates including sequence', async () => {
    const { GATE_ORDER } = await import('../../src/acceptance/evaluate.js');
    expect(GATE_ORDER).toBeDefined();
    expect(GATE_ORDER).toEqual([
      'record',
      'policy',
      'completeness',
      'context',
      'origin',
      'provider',
      'issues',
      'sequence',
      'pr',
      'closing',
      'checks',
    ]);
  });

  it('the generated finish skill names the eleven gates', async () => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const { writeAgentSurface } = await import('../../src/cli/agent-surface.js');
    const dir = await fs.mkdtemp(await os.tmpdir() + '/specgit-contract-');
    await writeAgentSurface(dir, 'generic');
    const skill = await fs.readFile(`${dir}/.agents/skills/specgit-finish/SKILL.md`, 'utf-8');
    expect(skill).toContain('Eleven gates');
    for (const gate of ['record', 'policy', 'completeness', 'context', 'origin', 'provider', 'issues', 'sequence', 'closing', 'checks']) {
      expect(skill, `finish skill must mention gate ${gate}`).toMatch(new RegExp(`\\b${gate}\\b`, 'i'));
    }
  });

  it('the managed AGENTS.md block covers the whole ten-command surface', async () => {
    const { COMMAND_NAMES } = await import('../../src/cli/index.js');
    const { managedPromptBlock } = await import('../../src/cli/harness-assets.js');
    const block = managedPromptBlock();
    for (const name of COMMAND_NAMES) {
      expect(block, `managed block must mention \`specgit ${name}\``).toContain(`specgit ${name}`);
    }
  });
});

describe('CLI contract: state/asset taxonomy (#69)', () => {
  it('classifies state into authoritative, derived harness, and local integration tiers', async () => {
    const { STATE_ASSET_TAXONOMY } = await import('../../src/cli/state-taxonomy.js');
    expect(STATE_ASSET_TAXONOMY).toBeDefined();
    const tiers = Object.keys(STATE_ASSET_TAXONOMY).sort();
    expect(tiers).toEqual(['authoritativeCommitted', 'derivedCommittedHarness', 'localIntegrationAssets']);

    const authoritative = STATE_ASSET_TAXONOMY.authoritativeCommitted.paths as string[];
    expect(authoritative).toContain('spec_git/policy.yaml');
    expect(authoritative).toContain('spec_git/providers.yaml');
    expect(authoritative).toContain('.specgit.yaml');

    const derived = STATE_ASSET_TAXONOMY.derivedCommittedHarness.paths as string[];
    expect(derived).toContain('.github/workflows/specgit-accept.yml');

    const local = STATE_ASSET_TAXONOMY.localIntegrationAssets.paths as string[];
    expect(local.some((p) => p.startsWith('.agents/skills/'))).toBe(true);
    expect(local.some((p) => p.startsWith('.opencode/command/'))).toBe(true);

    for (const tier of tiers) {
      expect(STATE_ASSET_TAXONOMY[tier as keyof typeof STATE_ASSET_TAXONOMY].description.length).toBeGreaterThan(0);
      expect(STATE_ASSET_TAXONOMY[tier as keyof typeof STATE_ASSET_TAXONOMY].paths.length).toBeGreaterThan(0);
    }
  });
});

describe('CLI contract: cross-slice documentation locks (reserved write sets)', () => {
  // These become real assertions when the docs/community slice lands; they are
  // the in-code record of what this slice needs from the reserved files.
  it.todo('docs/cli.md states ten commands and lists setup in the command table');
  it.todo('docs/cli.md and docs/reference.md count eleven gates (sequence row included)');
  it.todo('README.md and AGENTS.md replace the "two committed files" claim with the three-tier taxonomy');
  it.todo('schemas/specgit templates carry the same taxonomy and command surface');
});
