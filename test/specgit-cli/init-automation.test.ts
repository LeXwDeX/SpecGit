import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runInit } from '../../src/cli/commands/init.js';
import { LocalGitAdapter } from '../../src/gitfacts/local.js';
import { fail, ok } from '../../src/kernel/evidence.js';
import { makeCtx, samplePolicy } from './helpers.js';
import { initRepo, makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';

describe('init automation choice', () => {
  let root: string;
  beforeEach(() => { root = makeTempDir('specgit-init-automation-'); });
  afterEach(() => { rmDir(root); });
  const options = { requiredCheck: ['build'], protect: false };
  const disabled = { merge: false, close_issues: false };

  it('defaults to no without a TTY and explains the decision on stderr even in JSON mode', async () => {
    const t = makeCtx({ root: ok(root), cwd: root, stdinIsTTY: false });
    const promptAutomation = vi.fn(async () => 'yes');
    const outcome = await runInit({ ...options, json: true }, t.ctx, { promptAutomation });
    expect(outcome.exit).toBe(0);
    expect(outcome.policy?.automation).toEqual(disabled);
    expect(promptAutomation).not.toHaveBeenCalled();
    expect(t.io.stderr.join('\n')).toMatch(/no.*default/i);
    expect(t.io.stdout).toEqual([]);
  });

  it.each(['no', '', null])('asks on a TTY and treats %j as no', async (answer) => {
    const t = makeCtx({ root: ok(root), cwd: root, stdinIsTTY: true });
    const promptAutomation = vi.fn(async (_message: string) => answer);
    const outcome = await runInit(options, t.ctx, { promptAutomation });
    expect(outcome.exit).toBe(0);
    expect(outcome.policy?.automation).toEqual(disabled);
    expect(promptAutomation).toHaveBeenCalledOnce();
    expect(promptAutomation.mock.calls[0]?.[0]).toMatch(/yes\/no.*no/i);
  });

  it('enables merge and closure after a TTY yes using the proven default branch', async () => {
    const t = makeCtx({ root: ok(root), cwd: root, stdinIsTTY: true,
      gitWrites: { remoteDefaultBranch: () => ok('trunk') } });
    const outcome = await runInit(options, t.ctx, { promptAutomation: async () => 'yes' });
    expect(outcome.exit).toBe(0);
    expect(outcome.policy?.automation).toEqual({ merge: true, close_issues: true, target_branch: 'trunk' });
  });

  it('requires the full yes/no answer instead of treating y as authorization', async () => {
    const t = makeCtx({ root: ok(root), cwd: root, stdinIsTTY: true });
    const outcome = await runInit(options, t.ctx, { promptAutomation: async () => 'y' });
    expect(outcome.exit).toBe(2);
    expect(outcome.errors?.[0]?.code).toBe('automation_invalid');
    expect(t.recordPort.policyWrites).toEqual([]);
  });

  it('accepts an explicit script answer and target without prompting', async () => {
    const t = makeCtx({ root: ok(root), cwd: root, stdinIsTTY: true });
    const promptAutomation = vi.fn(async () => 'no');
    const outcome = await runInit(
      { ...options, automation: 'yes', mergeTarget: 'release/stable' }, t.ctx, { promptAutomation }
    );
    expect(outcome.exit).toBe(0);
    expect(outcome.policy?.automation).toEqual({ merge: true, close_issues: true, target_branch: 'release/stable' });
    expect(promptAutomation).not.toHaveBeenCalled();
  });

  it('does not guess main when a yes has no proven default branch', async () => {
    const t = makeCtx({ root: ok(root), cwd: root,
      gitWrites: { remoteDefaultBranch: () => fail('git_default_branch_unknown', 'no remote HEAD') } });
    const outcome = await runInit({ ...options, automation: 'yes' }, t.ctx);
    expect(outcome.exit).toBe(3);
    expect(outcome.errors?.[0]?.code).toBe('automation_target_unknown');
    expect(t.recordPort.policyWrites).toEqual([]);
    expect(fs.existsSync(path.join(root, 'AGENTS.md'))).toBe(false);
  });

  it('rejects a yes against real git with no origin HEAD before writing any policy', async () => {
    const { root: repoRoot } = initRepo(root);
    const t = makeCtx({ root: ok(repoRoot), cwd: repoRoot });
    t.ctx.git = new LocalGitAdapter();
    const outcome = await runInit({ ...options, automation: 'yes' }, t.ctx);
    expect(outcome.exit).toBe(3);
    expect(outcome.errors?.[0]?.code).toBe('automation_target_unknown');
    expect(t.recordPort.policyWrites).toEqual([]);
    expect(fs.existsSync(path.join(repoRoot, 'AGENTS.md'))).toBe(false);
  });

  it.each([
    { automation: 'maybe' },
    { automation: 'yes', mergeTarget: '--all' },
    { automation: 'yes', mergeTarget: 'main~1' },
  ])('rejects invalid script options %j before writing', async (invalid) => {
    const t = makeCtx({ root: ok(root), cwd: root });
    const outcome = await runInit({ ...options, ...invalid }, t.ctx);
    expect(outcome.exit).toBe(2);
    expect(t.recordPort.policyWrites).toEqual([]);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it.each(['yes', 'no'])('reselects %s on force while preserving other project policy fields', async (answer) => {
    const previous = samplePolicy({
      required_checks: ['Existing'], language: 'zh', ordered_issues: true,
      tags: [{ name: 'module::auth' }],
      automation: { merge: true, target_branch: 'old-target', close_issues: true },
    });
    const t = makeCtx({ root: ok(root), cwd: root, stdinIsTTY: true, policy: previous });
    const promptAutomation = vi.fn(async () => answer);
    const outcome = await runInit({ force: true, protect: false }, t.ctx, { promptAutomation });
    expect(outcome.exit).toBe(0);
    expect(outcome.policy).toEqual({
      ...previous,
      automation: answer === 'yes'
        ? { merge: true, target_branch: 'main', close_issues: true }
        : disabled,
    });
    expect(promptAutomation).toHaveBeenCalledOnce();
  });

  it('defaults to no on noninteractive force even if the previous policy enabled automation', async () => {
    const t = makeCtx({ root: ok(root), cwd: root, policy: samplePolicy({
      automation: { merge: true, target_branch: 'main', close_issues: true },
    }) });
    const outcome = await runInit({ force: true, protect: false }, t.ctx);
    expect(outcome.exit).toBe(0);
    expect(outcome.policy?.automation).toEqual(disabled);
  });
});
