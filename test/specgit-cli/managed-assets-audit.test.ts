import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mergeGitPrePush, mergeHooksJson } from '../../src/cli/harness-content.js';
import { LOCAL_ASSET_IGNORE_START, LOCAL_ASSET_IGNORE_END, reconcileLocalAssetIgnore } from '../../src/cli/commands/init-ignore.js';
import { reconcileManagedAssets } from '../../src/cli/managed-reconcile.js';
import { makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';

describe('managed asset audit: preserve user behavior and rollback identity', () => {
  let root: string;
  beforeEach(() => { root = makeTempDir('specgit-assets-audit-'); });
  afterEach(() => { rmDir(root); });

  it('keeps malformed PreToolUse content byte-exact with a warning', () => {
    const original = JSON.stringify({ PreToolUse: { matcher: 'Bash', hooks: [{ command: 'my-check' }] } });
    const merged = mergeHooksJson(original);
    expect(merged.json).toBe(original);
    expect(merged.warning).toBeDefined();
  });

  it('does not widen a user hook sharing the old SpecGit Bash entry', () => {
    const result = mergeHooksJson(JSON.stringify({ PreToolUse: [{ matcher: 'Bash', hooks: [
      { command: 'my-check' }, { command: '.opencode/hooks/specgit-merge-guard.sh' },
    ] }] }));
    const parsed = JSON.parse(result.json) as { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    const user = parsed.PreToolUse.find((entry) => entry.hooks.some((hook) => hook.command === 'my-check'));
    expect(user?.matcher).toBe('Bash');
    expect(parsed.PreToolUse.find((entry) => entry.matcher === 'Bash|Edit|Write')?.hooks).toHaveLength(1);
  });

  it.each(['#!/bin/sh\nexit 0\n', '#!/bin/sh\ncat >/dev/null\n'])('blocks main even when the existing hook exits or consumes stdin (%s)', (original) => {
    const hook = path.join(root, 'pre-push');
    fs.writeFileSync(hook, mergeGitPrePush(original));
    const result = spawnSync('sh', [hook], { cwd: root, encoding: 'utf8',
      input: `refs/heads/feature ${'a'.repeat(40)} refs/heads/main ${'0'.repeat(40)}\n`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('direct push to main');
  });

  it('preserves stdin and the exit status for a user hook on a delivery branch', () => {
    const hook = path.join(root, 'pre-push');
    fs.writeFileSync(hook, mergeGitPrePush('#!/bin/sh\ncat > user-refs\nexit 7\n'));
    const refs = `refs/heads/feature ${'a'.repeat(40)} refs/heads/feature ${'0'.repeat(40)}\n`;
    const result = spawnSync('sh', [hook], { cwd: root, input: refs });
    expect(result.status).toBe(7);
    expect(fs.readFileSync(path.join(root, 'user-refs'), 'utf8')).toBe(refs);
  });

  it('refuses to insert shell code into a hook using another interpreter', () => {
    expect(() => mergeGitPrePush('#!/usr/bin/python3\nprint("user")\n')).toThrow('not a supported shell script');
  });

  it('preserves rules between a stray ignore start and the nearest complete block', () => {
    const original = [LOCAL_ASSET_IGNORE_START, 'secrets.env', LOCAL_ASSET_IGNORE_START,
      '/.specgit.yaml', '/spec_git/', LOCAL_ASSET_IGNORE_END, ''].join('\n');
    const repaired = reconcileLocalAssetIgnore(original);
    expect(repaired).toContain('secrets.env\n');
    expect(reconcileLocalAssetIgnore(repaired)).toBe(repaired);
  });

  it.skipIf(process.platform === 'win32')('restores a removed owned symlink after a later transaction failure', async () => {
    fs.writeFileSync(path.join(root, 'target.md'), 'owned');
    fs.symlinkSync('target.md', path.join(root, 'retired.md'));
    await expect(reconcileManagedAssets(root, { steps: [
      { kind: 'remove', path: 'retired.md', isOwned: () => true },
      { kind: 'portWrite', path: 'failure', write: async () => { throw new Error('injected failure'); } },
    ] })).rejects.toThrow('injected failure');
    expect(fs.lstatSync(path.join(root, 'retired.md')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(root, 'retired.md'))).toBe('target.md');
  });

  it.skipIf(process.platform === 'win32')('refuses a dangling symlink without creating its referent or losing the link', async () => {
    fs.symlinkSync('missing.md', path.join(root, 'managed.md'));
    await expect(reconcileManagedAssets(root, { steps: [
      { kind: 'write', path: 'managed.md', mode: 0o644, merge: () => 'generated' },
    ] })).rejects.toThrow('dangling symlink');
    expect(fs.readlinkSync(path.join(root, 'managed.md'))).toBe('missing.md');
    expect(fs.existsSync(path.join(root, 'missing.md'))).toBe(false);
  });
});
