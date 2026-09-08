import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runInit } from '../../src/cli/commands/init.js';
import { finishGuidedUpgrade } from '../../src/cli/commands/init-upgrade.js';
import { runSetup } from '../../src/cli/commands/setup.js';
import { GUARD_SCRIPT_PATH, HARNESS_WORKFLOW_PATH } from '../../src/cli/harness-placement.js';
import { LOCAL_ASSET_IGNORE_START } from '../../src/cli/commands/init-ignore.js';
import type { Policy } from '../../src/record/policy.js';
import { makeCtx, samplePolicy } from './helpers.js';
import { makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';

const OPENCODE_STATUS = '.opencode/command/specgit-status.md';
const GENERIC_STATUS = '.agents/skills/specgit-status/SKILL.md';

function absolute(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split('/'));
}

function read(root: string, relativePath: string): string {
  return fs.readFileSync(absolute(root, relativePath), 'utf-8');
}

function treeState(root: string): Map<string, { content: string; mode: number }> {
  const state = new Map<string, { content: string; mode: number }>();
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else state.set(path.relative(root, target), {
        content: fs.readFileSync(target, 'utf-8'),
        mode: fs.statSync(target).mode,
      });
    }
  };
  walk(root);
  return state;
}

async function seedCurrentAssets(root: string, policy: Policy) {
  const seeded = makeCtx({
    root: { ok: true, value: root },
    cwd: root,
    stdinIsTTY: false,
    policy,
  });
  expect((await runInit({ force: true, protect: false }, seeded.ctx)).exit).toBe(0);
  expect((await runSetup({ tool: 'all' }, seeded.ctx)).exit).toBe(0);
  return seeded;
}

describe('specgit init guided managed-asset upgrade (#457)', () => {
  let root: string;
  let externalRoots: string[];

  beforeEach(() => {
    root = makeTempDir('specgit-guided-upgrade-');
    externalRoots = [];
  });

  afterEach(() => {
    rmDir(root);
    for (const external of externalRoots) rmDir(external);
  });

  it.skipIf(process.platform === 'win32')('forced init rejects a symlinked managed ancestor before any write', async () => {
    const external = makeTempDir('specgit-init-external-');
    externalRoots.push(external);
    fs.writeFileSync(path.join(external, 'keep.txt'), 'external init bytes\n');
    fs.symlinkSync(external, path.join(root, '.opencode'), 'dir');
    const policy = samplePolicy({ automation: { merge: false, close_issues: false } });
    const t = makeCtx({ root: { ok: true, value: root }, cwd: root, policy });

    const outcome = await runInit({ force: true, protect: false }, t.ctx);

    expect(outcome.exit).toBe(3);
    expect(outcome.errors?.[0]?.code).toBe('harness_content_failed');
    expect(outcome.errors?.[0]?.message).toContain('symbolic link ".opencode"');
    expect(fs.readFileSync(path.join(external, 'keep.txt'), 'utf8')).toBe('external init bytes\n');
    expect(fs.existsSync(path.join(external, 'hooks'))).toBe(false);
    expect(t.recordPort.policyWrites).toHaveLength(0);
    expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('guided inspection reports a symlink conflict without prompting or following it', async () => {
    const policy = samplePolicy({ automation: { merge: false, close_issues: false } });
    const t = await seedCurrentAssets(root, policy);
    fs.unlinkSync(path.join(root, '.gitignore'));
    const external = makeTempDir('specgit-guided-external-');
    externalRoots.push(external);
    const referent = path.join(external, 'ignore');
    fs.writeFileSync(referent, 'external guided bytes\n');
    fs.symlinkSync(referent, path.join(root, '.gitignore'));
    const policyWrites = t.recordPort.policyWrites.length;
    t.ctx.stdinIsTTY = true;
    const promptUpgrade = vi.fn(async (_message: string) => 'yes');

    const outcome = await runInit({}, t.ctx, { promptUpgrade });

    expect(outcome.exit).toBe(3);
    expect(outcome.errors).toEqual([
      expect.objectContaining({ code: 'asset_conflict', target: '.gitignore' }),
    ]);
    expect(promptUpgrade).not.toHaveBeenCalled();
    expect(fs.readFileSync(referent, 'utf8')).toBe('external guided bytes\n');
    expect(fs.lstatSync(path.join(root, '.gitignore')).isSymbolicLink()).toBe(true);
    expect(t.recordPort.policyWrites).toHaveLength(policyWrites);
  });

  it('a human yes refreshes stale init and both setup surfaces while preserving policy', async () => {
    const policy = samplePolicy({
      required_checks: ['CI / test'],
      ordered_issues: true,
      language: 'zh',
      validation: { titles: true, labels: 'kind', bodies: true },
      automation: { merge: false, close_issues: false, repair_labels: ['kind::fix'] },
    });
    const t = await seedCurrentAssets(root, policy);
    const workflowBefore = read(root, HARNESS_WORKFLOW_PATH);
    const opencodeBefore = read(root, OPENCODE_STATUS);
    const genericBefore = read(root, GENERIC_STATUS);
    fs.appendFileSync(absolute(root, HARNESS_WORKFLOW_PATH), '# old init generation\n');
    fs.appendFileSync(absolute(root, OPENCODE_STATUS), '\nOld opencode generation.\n');
    fs.appendFileSync(absolute(root, GENERIC_STATUS), '\nOld generic generation.\n');

    t.ctx.stdinIsTTY = true;
    const promptUpgrade = vi.fn(async (_message: string) => 'y');
    const outcome = await runInit({}, t.ctx, { promptUpgrade });

    expect(outcome.exit).toBe(0);
    expect(promptUpgrade).toHaveBeenCalledOnce();
    expect(promptUpgrade.mock.calls[0]?.[0]).toContain('是否立即升级');
    expect(promptUpgrade.mock.calls[0]?.[0]).toContain('specgit init --force --no-protect');
    expect(promptUpgrade.mock.calls[0]?.[0]).toContain('specgit setup --tool all');
    expect(read(root, HARNESS_WORKFLOW_PATH)).toBe(workflowBefore);
    expect(read(root, OPENCODE_STATUS)).toBe(opencodeBefore);
    expect(read(root, GENERIC_STATUS)).toBe(genericBefore);
    expect(t.recordPort.policyWrites.at(-1)?.policy).toEqual(policy);
    expect(outcome.human?.join('\n')).toContain('specgit-status');
    expect(t.ghProvider.calls).toEqual([]);
  });

  it('offers the same guided repair for a missing required init asset', async () => {
    const policy = samplePolicy({ automation: { merge: false, close_issues: false } });
    const t = await seedCurrentAssets(root, policy);
    const expectedWorkflow = read(root, HARNESS_WORKFLOW_PATH);
    fs.unlinkSync(absolute(root, HARNESS_WORKFLOW_PATH));
    t.ctx.stdinIsTTY = true;
    const promptUpgrade = vi.fn(async (_message: string) => 'yes');

    const outcome = await runInit({}, t.ctx, { promptUpgrade });

    expect(outcome.exit).toBe(0);
    expect(promptUpgrade).toHaveBeenCalledOnce();
    expect(read(root, HARNESS_WORKFLOW_PATH)).toBe(expectedWorkflow);
    expect(t.ghProvider.calls).toEqual([]);
  });

  it('offers a guided repair when only an installed setup surface is stale', async () => {
    const policy = samplePolicy({ automation: { merge: false, close_issues: false } });
    const t = await seedCurrentAssets(root, policy);
    const expectedStatus = read(root, OPENCODE_STATUS);
    fs.appendFileSync(absolute(root, OPENCODE_STATUS), '\nOld setup generation.\n');
    t.ctx.stdinIsTTY = true;
    const promptUpgrade = vi.fn(async (_message: string) => 'yes');

    const outcome = await runInit({}, t.ctx, { promptUpgrade });

    expect(outcome.exit).toBe(0);
    expect(promptUpgrade).toHaveBeenCalledOnce();
    expect(read(root, OPENCODE_STATUS)).toBe(expectedStatus);
    expect(t.ghProvider.calls).toEqual([]);
  });

  it('current managed assets keep the ordinary policy_exists result without prompting or writing', async () => {
    const policy = samplePolicy({
      language: 'en',
      automation: { merge: false, close_issues: false },
    });
    const t = await seedCurrentAssets(root, policy);
    const before = treeState(root);
    const policyWrites = t.recordPort.policyWrites.length;
    t.ctx.stdinIsTTY = true;
    const promptUpgrade = vi.fn(async (_message: string) => 'yes');

    const outcome = await runInit({}, t.ctx, { promptUpgrade });

    expect(outcome.exit).toBe(2);
    expect(outcome.errors?.[0]?.code).toBe('policy_exists');
    expect(promptUpgrade).not.toHaveBeenCalled();
    expect(treeState(root)).toEqual(before);
    expect(t.recordPort.policyWrites).toHaveLength(policyWrites);
    expect(t.ghProvider.calls).toEqual([]);
  });

  it('does not treat never-installed setup surfaces as an upgrade trigger', async () => {
    const policy = samplePolicy({ automation: { merge: false, close_issues: false } });
    const t = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      stdinIsTTY: false,
      policy,
    });
    expect((await runInit({ force: true, protect: false }, t.ctx)).exit).toBe(0);
    const before = treeState(root);
    const policyWrites = t.recordPort.policyWrites.length;
    t.ctx.stdinIsTTY = true;
    const promptUpgrade = vi.fn(async (_message: string) => 'yes');

    const outcome = await runInit({}, t.ctx, { promptUpgrade });

    expect(outcome.exit).toBe(2);
    expect(outcome.errors?.[0]?.code).toBe('policy_exists');
    expect(promptUpgrade).not.toHaveBeenCalled();
    expect(treeState(root)).toEqual(before);
    expect(t.recordPort.policyWrites).toHaveLength(policyWrites);
    expect(fs.existsSync(absolute(root, OPENCODE_STATUS))).toBe(false);
    expect(fs.existsSync(absolute(root, GENERIC_STATUS))).toBe(false);
  });

  it('does not prompt when any desired-state claim is incomplete', async () => {
    const policy = samplePolicy({ automation: { merge: false, close_issues: false } });
    const t = await seedCurrentAssets(root, policy);
    fs.appendFileSync(absolute(root, GUARD_SCRIPT_PATH), '# old guard generation\n');
    vi.mocked(t.gitPort.remoteDefaultBranch).mockResolvedValue({
      ok: false,
      code: 'remote_default_branch_unknown',
      message: 'Cannot resolve the remote default branch.',
    });
    const before = treeState(root);
    t.ctx.stdinIsTTY = true;
    const promptUpgrade = vi.fn(async (_message: string) => 'yes');

    const outcome = await runInit({}, t.ctx, { promptUpgrade });

    expect(outcome.exit).toBe(2);
    expect(outcome.errors?.[0]?.code).toBe('policy_exists');
    expect(promptUpgrade).not.toHaveBeenCalled();
    expect(treeState(root)).toEqual(before);
  });

  it('a human no leaves every byte untouched and returns policy_exists', async () => {
    const policy = samplePolicy({
      language: 'en',
      automation: { merge: false, close_issues: false },
    });
    const t = await seedCurrentAssets(root, policy);
    fs.appendFileSync(absolute(root, HARNESS_WORKFLOW_PATH), '# old generation\n');
    const before = treeState(root);
    const policyWrites = t.recordPort.policyWrites.length;
    t.ctx.stdinIsTTY = true;
    const promptUpgrade = vi.fn(async (_message: string) => 'no');

    const outcome = await runInit({}, t.ctx, { promptUpgrade });

    expect(outcome.exit).toBe(2);
    expect(outcome.errors?.[0]?.code).toBe('policy_exists');
    expect(promptUpgrade).toHaveBeenCalledOnce();
    expect(treeState(root)).toEqual(before);
    expect(t.recordPort.policyWrites).toHaveLength(policyWrites);
  });

  it('never turns configuration flags into an implicitly forced policy change', async () => {
    const policy = samplePolicy({
      language: 'en',
      automation: { merge: false, close_issues: false },
    });
    const t = await seedCurrentAssets(root, policy);
    fs.appendFileSync(absolute(root, HARNESS_WORKFLOW_PATH), '# old generation\n');
    const before = treeState(root);
    const policyWrites = t.recordPort.policyWrites.length;
    t.ctx.stdinIsTTY = true;
    const promptUpgrade = vi.fn(async (_message: string) => 'yes');

    const outcome = await runInit({ language: 'zh' }, t.ctx, { promptUpgrade });

    expect(outcome.exit).toBe(2);
    expect(outcome.errors?.[0]?.code).toBe('policy_exists');
    expect(promptUpgrade).not.toHaveBeenCalled();
    expect(treeState(root)).toEqual(before);
    expect(t.recordPort.policyWrites).toHaveLength(policyWrites);
    expect(t.ghProvider.calls).toEqual([]);
  });

  it('preserves a committed-authoritative .gitignore opt-out during guided refresh', async () => {
    const policy = samplePolicy({ automation: { merge: false, close_issues: false } });
    const t = makeCtx({
      root: { ok: true, value: root },
      cwd: root,
      stdinIsTTY: false,
      policy,
      gitWrites: { trackedFiles: (paths) => ({ ok: true, value: [...paths] }) },
    });
    fs.writeFileSync(absolute(root, '.gitignore'), 'node_modules/\n');
    expect((await runInit({ force: true, protect: false, ignore: false }, t.ctx)).exit).toBe(0);
    expect((await runSetup({ tool: 'all' }, t.ctx)).exit).toBe(0);
    expect(read(root, '.gitignore')).toBe('node_modules/\n');
    expect(read(root, '.gitignore')).not.toContain(LOCAL_ASSET_IGNORE_START);
    fs.appendFileSync(absolute(root, HARNESS_WORKFLOW_PATH), '# old generation\n');
    const ignoreBefore = read(root, '.gitignore');
    t.ctx.stdinIsTTY = true;
    const promptUpgrade = vi.fn(async (_message: string) => 'yes');

    const outcome = await runInit({}, t.ctx, { promptUpgrade });

    expect(outcome.exit).toBe(0);
    expect(promptUpgrade.mock.calls[0]?.[0]).toContain('--no-ignore');
    expect(read(root, '.gitignore')).toBe(ignoreBefore);
    expect(read(root, '.gitignore')).not.toContain(LOCAL_ASSET_IGNORE_START);
    expect(t.ghProvider.calls).toEqual([]);
  });

  it.each([
    { name: '--json', stdinIsTTY: true, json: true },
    { name: 'a non-TTY run', stdinIsTTY: false, json: false },
  ])('$name never prompts or writes and names both deterministic repair commands', async ({ stdinIsTTY, json }) => {
    const policy = samplePolicy({ automation: { merge: false, close_issues: false } });
    const t = await seedCurrentAssets(root, policy);
    fs.appendFileSync(absolute(root, HARNESS_WORKFLOW_PATH), '# old generation\n');
    const before = treeState(root);
    const policyWrites = t.recordPort.policyWrites.length;
    const factsCalls = t.gitPort.factsCalls.length;
    t.ctx.stdinIsTTY = stdinIsTTY;
    const promptUpgrade = vi.fn(async (_message: string) => 'yes');

    const outcome = await runInit({ json }, t.ctx, { promptUpgrade });

    expect(outcome.exit).toBe(2);
    expect(promptUpgrade).not.toHaveBeenCalled();
    expect(treeState(root)).toEqual(before);
    expect(t.recordPort.policyWrites).toHaveLength(policyWrites);
    const fix = outcome.errors?.[0]?.fix ?? '';
    expect(t.gitPort.factsCalls).toHaveLength(factsCalls);
    expect(fix.indexOf('specgit init --force --no-protect')).toBeGreaterThanOrEqual(0);
    expect(fix.indexOf('specgit setup --tool all')).toBeGreaterThan(
      fix.indexOf('specgit init --force --no-protect')
    );
  });

  it('reports a failed setup phase after init with an explicit recovery command', () => {
    const outcome = finishGuidedUpgrade(
      { exit: 0, human: ['Initialized SpecGit.'] },
      {
        exit: 3,
        errors: [{
          severity: 'error',
          code: 'setup_write_failed',
          message: 'The setup surface could not be written.',
        }],
      }
    );
    expect(outcome.exit).toBe(3);
    expect(outcome.errors?.[0]?.code).toBe('setup_write_failed');
    expect(outcome.errors?.[0]?.fix).toContain('specgit setup --tool all');
    expect(outcome.errors?.[0]?.fix).toContain('init --force phase completed');
  });

  it('fails closed before prompting when a retired setup candidate is not provably owned', async () => {
    const policy = samplePolicy({ automation: { merge: false, close_issues: false } });
    const t = await seedCurrentAssets(root, policy);
    const retired = '.opencode/command/specgit-old.md';
    fs.writeFileSync(absolute(root, retired), '# user-owned command\n');
    const before = treeState(root);
    const policyWrites = t.recordPort.policyWrites.length;
    t.ctx.stdinIsTTY = true;
    const promptUpgrade = vi.fn(async (_message: string) => 'yes');

    const outcome = await runInit({}, t.ctx, { promptUpgrade });

    expect(outcome.exit).toBe(3);
    expect(outcome.errors).toEqual([
      expect.objectContaining({ code: 'asset_conflict', target: retired }),
    ]);
    expect(outcome.errors?.[0]?.fix).toContain('move it outside the managed path');
    expect(promptUpgrade).not.toHaveBeenCalled();
    expect(treeState(root)).toEqual(before);
    expect(t.recordPort.policyWrites).toHaveLength(policyWrites);
    expect(t.ghProvider.calls).toEqual([]);
  });

  it('rejects an invalid answer without mutating the tree', async () => {
    const policy = samplePolicy({ automation: { merge: false, close_issues: false } });
    const t = await seedCurrentAssets(root, policy);
    fs.appendFileSync(absolute(root, HARNESS_WORKFLOW_PATH), '# old generation\n');
    const before = treeState(root);
    const policyWrites = t.recordPort.policyWrites.length;
    t.ctx.stdinIsTTY = true;

    const outcome = await runInit({}, t.ctx, { promptUpgrade: async () => 'later' });

    expect(outcome.exit).toBe(2);
    expect(outcome.errors?.[0]?.code).toBe('upgrade_answer_invalid');
    expect(outcome.errors?.[0]?.fix).toContain('answer yes or no');
    expect(treeState(root)).toEqual(before);
    expect(t.recordPort.policyWrites).toHaveLength(policyWrites);
    expect(t.ghProvider.calls).toEqual([]);
  });

  it('propagates prompt interruption without mutating the tree', async () => {
    const policy = samplePolicy({ automation: { merge: false, close_issues: false } });
    const t = await seedCurrentAssets(root, policy);
    fs.appendFileSync(absolute(root, HARNESS_WORKFLOW_PATH), '# old generation\n');
    const before = treeState(root);
    const interrupted = new Error('Interrupted.');
    interrupted.name = 'ExitPromptError';
    t.ctx.stdinIsTTY = true;

    await expect(runInit({}, t.ctx, {
      promptUpgrade: async () => { throw interrupted; },
    })).rejects.toBe(interrupted);
    expect(treeState(root)).toEqual(before);
  });
});
