import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runCliWith } from '../../src/cli/index.js';
import { EXIT_SUCCESS, EXIT_UNKNOWN, EXIT_USAGE } from '../../src/cli/exit-codes.js';
import { SPEC_GIT_DIR, POLICY_FILENAME } from '../../src/cli/types.js';
import {
  BLOCK_END_MARKER,
  BLOCK_START_MARKER,
  HARNESS_WORKFLOW_PATH,
  managedPromptBlock,
} from '../../src/cli/harness-assets.js';
import { makeCtx, parseStdoutJson, samplePolicy, stdoutText } from './helpers.js';
import { makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';

const WORKFLOW_ABS = (root: string) => path.join(root, ...HARNESS_WORKFLOW_PATH.split('/'));
const AGENTS_ABS = (root: string) => path.join(root, 'AGENTS.md');
const CLAUDE_ABS = (root: string) => path.join(root, 'CLAUDE.md');

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('specgit init', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir('specgit-init-');
  });

  afterEach(() => {
    rmDir(root);
  });

  it('creates spec_git/policy.yaml with the declared required checks', async () => {
    const t = makeCtx({ root: { ok: true, value: root } });
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
      root,
      policy: { version: 1, required_checks: ['Test', 'All checks passed'] },
    });
    expect(t.recordPort.recordWrites).toHaveLength(0);
  });

  it('prints a human summary with the spec_git path and the harness artifacts', async () => {
    const t = makeCtx({ root: { ok: true, value: root } });
    await runCliWith(['node', 'specgit', 'init', '--required-check', 'Test'], t.ctx);
    expect(stdoutText(t.io)).toContain(SPEC_GIT_DIR);
    expect(stdoutText(t.io)).toContain(POLICY_FILENAME);
    expect(stdoutText(t.io)).toContain(HARNESS_WORKFLOW_PATH);
    expect(stdoutText(t.io)).toContain('AGENTS.md');
  });

  it('emits a JSON envelope in --json mode', async () => {
    const t = makeCtx({ root: { ok: true, value: root } });
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

  it('fails usage in non-TTY when no --required-check is given, writing nothing', async () => {
    const t = makeCtx({ root: { ok: true, value: root }, stdinIsTTY: false });
    const code = await runCliWith(['node', 'specgit', 'init', '--json'], t.ctx);
    expect(code).toBe(EXIT_USAGE);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors[0].code).toBe('required_check_required');
    expect(t.recordPort.policyWrites).toHaveLength(0);
    expect(fs.readdirSync(root)).toHaveLength(0);
  });

  it('does not overwrite an existing policy', async () => {
    const t = makeCtx({
      root: { ok: true, value: root },
      policy: { version: 1, required_checks: ['Existing'] },
    });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'New', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_USAGE);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors[0].code).toBe('policy_exists');
    expect(t.recordPort.policyWrites).toHaveLength(0);
  });

  it('fails usage when a required check name is empty, writing nothing', async () => {
    const t = makeCtx({ root: { ok: true, value: root } });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', ' ', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_USAGE);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.errors[0].code).toBe('required_check_invalid');
    expect(fs.readdirSync(root)).toHaveLength(0);
  });

  it('fails closed (exit 3) outside a git repository, writing nothing', async () => {
    const t = makeCtx({
      root: { ok: false, code: 'not_a_git_repo', message: 'Not a git repository.' },
    });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--json'],
      t.ctx
    );
    expect(code).toBe(EXIT_UNKNOWN);
    const envelope = parseStdoutJson(t.io);
    expect(envelope.status).toBe('unknown');
    expect(envelope.errors[0].code).toBe('not_a_git_repo');
    expect(fs.readdirSync(root)).toHaveLength(0);
  });
});

describe('specgit init harness generation', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir('specgit-init-harness-');
  });

  afterEach(() => {
    rmDir(root);
  });

  it('generates the acceptance workflow and the AGENTS.md managed block; no CLAUDE.md when absent', async () => {
    const t = makeCtx({ root: { ok: true, value: root } });
    const code = await runCliWith(['node', 'specgit', 'init', '--required-check', 'Test'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);

    const workflow = read(WORKFLOW_ABS(root));
    expect(workflow).toContain('name: SpecGit Acceptance');
    expect(workflow).toContain('pull_request');
    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('GH_TOKEN: ${{ github.token }}');
    expect(workflow).toContain('node bin/specgit.js finish --json');
    expect(workflow).not.toContain('\r');

    const agents = read(AGENTS_ABS(root));
    expect(agents).toBe(`${managedPromptBlock()}\n`);
    expect(agents).toContain(BLOCK_START_MARKER);
    expect(agents).toContain(BLOCK_END_MARKER);
    expect(agents).not.toContain('\r');

    expect(fs.existsSync(CLAUDE_ABS(root))).toBe(false);
  });

  it('covers the human story, repair, diagnostics, granularity, and iron rules in the block', async () => {
    const t = makeCtx({ root: { ok: true, value: root } });
    await runCliWith(['node', 'specgit', 'init', '--required-check', 'Test'], t.ctx);

    const block = managedPromptBlock();
    expect(block).toContain('specgit issue');
    expect(block).toContain('specgit finish');
    expect(block).toContain('specgit pr');
    expect(block).toContain('specgit status');
    expect(block).toContain('specgit doctor');
    expect(block.toLowerCase()).toContain('one issue = one independently verifiable why');
    expect(block).toContain('never request merge');
    expect(block.toLowerCase()).toContain('never weaken');
    expect(block).toContain('--json');
    expect(block.startsWith(BLOCK_START_MARKER)).toBe(true);
    expect(block.endsWith(BLOCK_END_MARKER)).toBe(true);
  });

  it('second init is idempotent: artifacts are rewritten byte-identical, policy still protected', async () => {
    const first = makeCtx({ root: { ok: true, value: root } });
    await runCliWith(['node', 'specgit', 'init', '--required-check', 'Test'], first.ctx);
    const workflowAfterFirst = read(WORKFLOW_ABS(root));
    const agentsAfterFirst = read(AGENTS_ABS(root));

    fs.appendFileSync(WORKFLOW_ABS(root), '# drifted local edit\n');
    const second = makeCtx({ root: { ok: true, value: root }, policy: samplePolicy() });
    const code = await runCliWith(
      ['node', 'specgit', 'init', '--required-check', 'Test', '--json'],
      second.ctx
    );

    expect(code).toBe(EXIT_USAGE);
    const envelope = parseStdoutJson(second.io);
    expect(envelope.errors[0].code).toBe('policy_exists');

    expect(read(WORKFLOW_ABS(root))).toBe(workflowAfterFirst);
    const agentsAfterSecond = read(AGENTS_ABS(root));
    expect(agentsAfterSecond).toBe(agentsAfterFirst);
    expect(countOccurrences(agentsAfterSecond, BLOCK_START_MARKER)).toBe(1);
    expect(countOccurrences(agentsAfterSecond, BLOCK_END_MARKER)).toBe(1);
  });

  it('injects the block into an existing AGENTS.md without touching surrounding content', async () => {
    const original = '# Project notes\n\nKeep this header.\n\nTail content stays.\n';
    fs.writeFileSync(AGENTS_ABS(root), original);

    const t = makeCtx({ root: { ok: true, value: root } });
    const code = await runCliWith(['node', 'specgit', 'init', '--required-check', 'Test'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);

    const updated = read(AGENTS_ABS(root));
    expect(updated).toBe(`${original}\n${managedPromptBlock()}\n`);
    expect(updated).toContain('Keep this header.');
    expect(updated).toContain('Tail content stays.');
    expect(updated.startsWith('# Project notes')).toBe(true);
  });

  it('injects the block into an existing CLAUDE.md without creating AGENTS.md copies of it', async () => {
    fs.writeFileSync(AGENTS_ABS(root), '# Agents\n');
    fs.writeFileSync(CLAUDE_ABS(root), '# Claude\n');

    const t = makeCtx({ root: { ok: true, value: root } });
    const code = await runCliWith(['node', 'specgit', 'init', '--required-check', 'Test'], t.ctx);
    expect(code).toBe(EXIT_SUCCESS);

    const claude = read(CLAUDE_ABS(root));
    expect(claude).toBe(`# Claude\n\n${managedPromptBlock()}\n`);
    const agents = read(AGENTS_ABS(root));
    expect(agents).toBe(`# Agents\n\n${managedPromptBlock()}\n`);
  });

  it('re-init replaces only the content between the markers (round-trip)', async () => {
    const first = makeCtx({ root: { ok: true, value: root } });
    await runCliWith(['node', 'specgit', 'init', '--required-check', 'Test'], first.ctx);

    const canonical = read(AGENTS_ABS(root));
    const startIndex = canonical.indexOf(BLOCK_START_MARKER);
    const endIndex = canonical.indexOf(BLOCK_END_MARKER);
    const prefix = canonical.slice(0, startIndex);
    const suffix = '\nEdited after the block.\n';
    fs.writeFileSync(
      AGENTS_ABS(root),
      `${prefix}${BLOCK_START_MARKER}\nSTALE CONTENT\n${BLOCK_END_MARKER}${suffix}`
    );

    const second = makeCtx({ root: { ok: true, value: root }, policy: samplePolicy() });
    await runCliWith(['node', 'specgit', 'init', '--required-check', 'Test'], second.ctx);

    expect(read(AGENTS_ABS(root))).toBe(`${prefix}${managedPromptBlock()}${suffix}`);
  });
});
