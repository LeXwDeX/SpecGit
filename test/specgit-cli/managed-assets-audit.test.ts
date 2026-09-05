import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mergeGitPrePush, mergeHooksJson } from '../../src/cli/harness-content.js';
import { LOCAL_ASSET_IGNORE_START, LOCAL_ASSET_IGNORE_END, reconcileLocalAssetIgnore } from '../../src/cli/commands/init-ignore.js';
import {
  inspectManagedAssets,
  ManagedReconcileError,
  reconcileManagedAssets,
} from '../../src/cli/managed-reconcile.js';
import { git, initRepo, makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';

describe('managed asset audit: preserve user behavior and rollback identity', () => {
  let root: string;
  let externalRoots: string[];
  beforeEach(() => {
    root = makeTempDir('specgit-assets-audit-');
    externalRoots = [];
  });
  afterEach(() => {
    rmDir(root);
    for (const external of externalRoots) rmDir(external);
  });

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
    const repo = initRepo(root);
    root = repo.root;
    git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD'], repo.env);
    git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], repo.env);
    const hook = path.join(root, 'pre-push');
    fs.writeFileSync(hook, mergeGitPrePush(original));
    const result = spawnSync('sh', [hook], { cwd: root, encoding: 'utf8',
      input: `refs/heads/feature ${'a'.repeat(40)} refs/heads/main ${'0'.repeat(40)}\n`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('direct push to main');
  });

  it('preserves stdin and the exit status for a user hook on a delivery branch', () => {
    const repo = initRepo(root);
    root = repo.root;
    git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD'], repo.env);
    git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], repo.env);
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

  it.skipIf(process.platform === 'win32')('rejects an owned symlink in the plan instead of following or removing it', async () => {
    const external = makeTempDir('specgit-assets-external-');
    externalRoots.push(external);
    const referent = path.join(external, 'target.md');
    fs.writeFileSync(referent, 'external bytes');
    fs.symlinkSync(referent, path.join(root, 'retired.md'));
    const steps = [
      { kind: 'remove' as const, path: 'retired.md', isOwned: () => true },
    ];

    expect(await inspectManagedAssets(root, { steps })).toEqual({
      findings: [{ path: 'retired.md', state: 'conflict', code: 'asset_conflict' }],
      notInspected: [],
    });
    let caught: unknown;
    try {
      await reconcileManagedAssets(root, { steps });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ManagedReconcileError);
    expect((caught as ManagedReconcileError).phase).toBe('plan');
    expect((caught as ManagedReconcileError).message).toContain('symbolic link "retired.md"');
    expect(fs.lstatSync(path.join(root, 'retired.md')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(referent, 'utf8')).toBe('external bytes');
  });

  it.skipIf(process.platform === 'win32')('refuses a dangling symlink without creating its referent or losing the link', async () => {
    fs.symlinkSync('missing.md', path.join(root, 'managed.md'));
    await expect(reconcileManagedAssets(root, { steps: [
      { kind: 'write', path: 'managed.md', mode: 0o644, merge: () => 'generated' },
    ] })).rejects.toThrow('symbolic link "managed.md"');
    expect(fs.readlinkSync(path.join(root, 'managed.md'))).toBe('missing.md');
    expect(fs.existsSync(path.join(root, 'missing.md'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('rejects a linked ancestor before any planned write reaches its external directory', async () => {
    const external = makeTempDir('specgit-assets-external-');
    externalRoots.push(external);
    fs.writeFileSync(path.join(external, 'keep.txt'), 'external bytes');
    fs.symlinkSync(external, path.join(root, '.agents'), 'dir');
    const steps = [
      { kind: 'write' as const, path: 'safe.txt', mode: 0o644, merge: () => 'must not exist' },
      { kind: 'write' as const, path: '.agents/skills/specgit-issue/SKILL.md', mode: 0o644, merge: () => 'generated' },
    ];

    await expect(reconcileManagedAssets(root, { steps })).rejects.toThrow(
      'symbolic link ".agents"'
    );
    expect(fs.existsSync(path.join(root, 'safe.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(external, 'keep.txt'), 'utf8')).toBe('external bytes');
    expect(fs.existsSync(path.join(external, 'skills'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('allows only an explicitly trusted git-hooks path outside the worktree', async () => {
    const hooks = makeTempDir('specgit-owned-hooks-');
    externalRoots.push(hooks);
    const prePush = path.join(hooks, 'pre-push');
    fs.writeFileSync(prePush, '#!/bin/sh\nuser-check\n');
    const hookPath = path.relative(root, prePush).split(path.sep).join('/');

    const report = await reconcileManagedAssets(root, { steps: [{
      kind: 'write',
      path: hookPath,
      scope: 'git-hooks',
      mode: 0o755,
      merge: () => '#!/bin/sh\nspecgit-check\n',
    }] });

    expect(report.updated).toEqual([hookPath]);
    expect(fs.readFileSync(prePush, 'utf8')).toBe('#!/bin/sh\nspecgit-check\n');
  });

  it.skipIf(process.platform === 'win32')('still rejects a symlinked git hook leaf without touching its referent', async () => {
    const hooks = makeTempDir('specgit-owned-hooks-');
    const external = makeTempDir('specgit-hook-referent-');
    externalRoots.push(hooks, external);
    const referent = path.join(external, 'pre-push');
    fs.writeFileSync(referent, '#!/bin/sh\nexternal\n');
    const prePush = path.join(hooks, 'pre-push');
    fs.symlinkSync(referent, prePush);
    const hookPath = path.relative(root, prePush).split(path.sep).join('/');

    await expect(reconcileManagedAssets(root, { steps: [{
      kind: 'write',
      path: hookPath,
      scope: 'git-hooks',
      mode: 0o755,
      merge: () => '#!/bin/sh\nspecgit\n',
    }] })).rejects.toThrow('symbolic link');

    expect(fs.lstatSync(prePush).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(referent, 'utf8')).toBe('#!/bin/sh\nexternal\n');
  });

  it.skipIf(process.platform === 'win32')('does not extend git-hook trust to a linked ancestor inside the repository', async () => {
    const external = makeTempDir('specgit-linked-gitdir-');
    externalRoots.push(external);
    fs.mkdirSync(path.join(external, 'hooks'));
    const prePush = path.join(external, 'hooks', 'pre-push');
    fs.writeFileSync(prePush, '#!/bin/sh\nexternal\n');
    fs.symlinkSync(external, path.join(root, '.git'), 'dir');

    await expect(reconcileManagedAssets(root, { steps: [{
      kind: 'write',
      path: '.git/hooks/pre-push',
      scope: 'git-hooks',
      mode: 0o755,
      merge: () => '#!/bin/sh\nspecgit\n',
    }] })).rejects.toThrow('symbolic link ".git"');

    expect(fs.readFileSync(prePush, 'utf8')).toBe('#!/bin/sh\nexternal\n');
  });

  it.skipIf(process.platform === 'win32')('rolls back a port-created symlink by unlinking the leaf, never its referent', async () => {
    const external = makeTempDir('specgit-port-referent-');
    externalRoots.push(external);
    const referent = path.join(external, 'policy.yaml');
    fs.writeFileSync(referent, 'external policy bytes\n');
    const managed = path.join(root, 'spec_git', 'policy.yaml');

    await expect(reconcileManagedAssets(root, { steps: [{
      kind: 'portWrite',
      path: 'spec_git/policy.yaml',
      write: async () => {
        fs.mkdirSync(path.dirname(managed), { recursive: true });
        fs.symlinkSync(referent, managed);
      },
    }] })).rejects.toThrow('symbolic link');

    expect(fs.existsSync(managed)).toBe(false);
    expect(fs.existsSync(path.join(root, 'spec_git'))).toBe(false);
    expect(fs.readFileSync(referent, 'utf8')).toBe('external policy bytes\n');
  });
});
