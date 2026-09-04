import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../../src/cli/commands/init.js';
import { runSetup } from '../../src/cli/commands/setup.js';
import { buildAgentSurfaceDesiredState } from '../../src/cli/agent-surface.js';
import { buildHarnessDesiredState } from '../../src/cli/harness-placement.js';
import { inspectManagedAssets } from '../../src/cli/managed-reconcile.js';
import { makeCtx } from './helpers.js';
import { makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';
import { LocalGitAdapter } from '../../src/gitfacts/local.js';

describe('initialization asset ownership', () => {
  let root: string;
  beforeEach(() => { root = makeTempDir('specgit-assets-isolation-'); });
  afterEach(() => { rmDir(root); });

  it('installs safe assets while leaving external hooks and the unused legacy hook untouched', async () => {
    const repository = path.join(root, 'repo');
    const shared = path.join(root, 'shared-hooks');
    fs.mkdirSync(shared);
    execFileSync('git', ['init', '-q', repository]);
    execFileSync('git', ['-C', repository, 'config', 'core.hooksPath', shared]);
    fs.writeFileSync(path.join(shared, 'pre-push'), '#!/bin/sh\nuser shared hook\n');
    const t = makeCtx({ root: { ok: true, value: repository } });
    const local = new LocalGitAdapter();
    t.ctx.git.hooksPath = (repo) => local.hooksPath(repo);
    const result = await runInit({ requiredCheck: ['test'], protect: false }, t.ctx);
    expect(result.exit).toBe(0);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'git_hooks_external' })]));
    expect(result.reconciled?.created).not.toContain('.git/hooks/pre-push');
    expect(fs.readFileSync(path.join(shared, 'pre-push'), 'utf8')).toBe('#!/bin/sh\nuser shared hook\n');
    expect(fs.existsSync(path.join(repository, '.git/hooks/pre-push'))).toBe(false);
    expect(fs.existsSync(path.join(repository, '.opencode/hooks/specgit-merge-guard.sh'))).toBe(true);
  });

  it('ignores local entry points and state without hiding unrelated agent files or shared configuration', async () => {
    execFileSync('git', ['init', '-q', root]);
    fs.writeFileSync(path.join(root, '.gitignore'), '# user rule\n/user-temp/\n');
    const t = makeCtx({ root: { ok: true, value: root } });
    const result = await runSetup({ tool: 'all' }, t.ctx);
    expect(result.exit).toBe(0);
    const installed = result.assets?.installed;
    if (!Array.isArray(installed)) throw new Error('setup must report installed paths');
    const ignored = [...installed, '.local/state/gh/device-id', '.local/cache/download',
      '.opencode/hooks/specgit-merge-guard.sh'];
    const actual = execFileSync('git', ['-C', root, 'check-ignore', '--stdin'], {
      encoding: 'utf8', input: `${ignored.join('\n')}\n`,
    }).trim().split('\n');
    expect(actual).toEqual(ignored);
    const visible = ['.agents/skills/user-skill/SKILL.md', '.opencode/command/user-task.md',
      '.opencode/hooks.json', '.github/workflows/specgit-accept.yml', 'AGENTS.md'];
    for (const name of visible) {
      expect(() => execFileSync('git', ['-C', root, 'check-ignore', '--quiet', name])).toThrow();
    }
    const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    expect(ignore).toContain('# user rule\n/user-temp/\n');
    expect((await runSetup({ tool: 'all' }, t.ctx)).exit).toBe(0);
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe(ignore);
  });

  it.each([
    { target: '.github/workflows/specgit-accept.yml', command: 'init' },
    { target: '.opencode/hooks/specgit-merge-guard.sh', command: 'init' },
    { target: '.opencode/command/specgit-issue.md', command: 'opencode' },
    { target: '.agents/skills/specgit-issue/SKILL.md', command: 'generic' },
  ])('preserves foreign $target and refuses before any write', async ({ target, command }) => {
    const absolute = path.join(root, target);
    const original = 'User-owned content; the filename does not transfer ownership.\n';
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, original);
    const before = fs.readdirSync(root, { recursive: true }).sort();
    const t = makeCtx({ root: { ok: true, value: root } });
    const result = command === 'init'
      ? await runInit({ requiredCheck: ['test'], protect: false }, t.ctx)
      : await runSetup({ tool: command }, t.ctx);
    expect(result.exit).toBe(3);
    expect(result.errors?.[0]?.message).toContain(target);
    expect(fs.readFileSync(absolute, 'utf8')).toBe(original);
    expect(fs.readdirSync(root, { recursive: true }).sort()).toEqual(before);
    expect(t.recordPort.policyWrites).toEqual([]);
    const desired = command === 'init'
      ? await buildHarnessDesiredState(root, {})
      : await buildAgentSurfaceDesiredState(root, command as 'generic' | 'opencode');
    const inspection = await inspectManagedAssets(root, desired);
    expect(inspection.findings).toContainEqual({ path: target, state: 'conflict', code: 'asset_conflict' });
  });
});
