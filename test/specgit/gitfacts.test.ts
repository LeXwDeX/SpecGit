import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalGitAdapter } from '../../src/gitfacts/local.js';
import { commitFile, git, initRepo, makeTempDir, rmDir } from './helpers/temp-repo.js';

describe('LocalGitAdapter', () => {
  let tempDir: string;
  let root: string;
  let env: NodeJS.ProcessEnv;
  const adapter = new LocalGitAdapter();

  beforeEach(() => {
    tempDir = makeTempDir('specgit-gitfacts-');
    ({ root, env } = initRepo(tempDir));
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  it('reads branch, sha, and clean-tree facts from a real repo', async () => {
    const facts = await adapter.facts(root);
    const expectedSha = git(root, ['rev-parse', 'HEAD'], env).trim();
    expect(facts.repo).toBe(true);
    expect(facts.branch).toBe('main');
    expect(facts.headSha).toBe(expectedSha);
    expect(facts.dirty).toBe(false);
    expect(facts.isLinkedWorktree).toBe(false);
    expect(facts.worktreeLabel).toBeNull();
    expect(facts.upstreamDrift).toBeNull();
    expect(facts.worktrees).toHaveLength(1);
    expect(facts.worktrees[0]).toEqual({ label: path.basename(root), branch: 'main' });
  });

  it('reports branch null on detached HEAD while keeping the sha', async () => {
    git(root, ['checkout', '--detach'], env);
    const facts = await adapter.facts(root);
    expect(facts.branch).toBeNull();
    expect(facts.headSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('reports a dirty working tree', async () => {
    fs.writeFileSync(path.join(root, 'README.md'), 'modified\n');
    const facts = await adapter.facts(root);
    expect(facts.dirty).toBe(true);
  });

  it('resolves linked worktree identity and enumerates all worktrees', async () => {
    const wtRoot = path.join(tempDir, 'wt-x');
    git(root, ['worktree', 'add', wtRoot, '-b', 'feat/wt'], env);

    const wtFacts = await adapter.facts(wtRoot);
    expect(wtFacts.repo).toBe(true);
    expect(wtFacts.isLinkedWorktree).toBe(true);
    expect(wtFacts.worktreeLabel).toBe('wt-x');
    expect(wtFacts.branch).toBe('feat/wt');
    expect(wtFacts.worktrees.map((w) => w.label)).toEqual(
      expect.arrayContaining([path.basename(root), 'wt-x'])
    );
    expect(wtFacts.worktrees.find((w) => w.label === 'wt-x')).toEqual({
      label: 'wt-x',
      branch: 'feat/wt',
    });

    const mainFacts = await adapter.facts(root);
    expect(mainFacts.isLinkedWorktree).toBe(false);
    expect(mainFacts.worktreeLabel).toBeNull();
  });

  it('round-trips the origin URL from local config only', async () => {
    git(root, ['remote', 'add', 'origin', 'https://github.com/LeXwDeX/SpecGit.git'], env);
    const facts = await adapter.facts(root);
    expect(facts.originUrl).toBe('https://github.com/LeXwDeX/SpecGit.git');
  });

  it('sets gitAvailable false when the git binary cannot be spawned', async () => {
    const noGitAdapter = new LocalGitAdapter({ env: { PATH: tempDir } });
    const facts = await noGitAdapter.facts(root);
    expect(facts.gitAvailable).toBe(false);
    expect(facts.repo).toBe(false);
    expect(facts.branch).toBeNull();
  });

  it('reports repo false for a non-repo directory', async () => {
    const plain = path.join(tempDir, 'plain');
    fs.mkdirSync(plain, { recursive: true });
    const facts = await adapter.facts(plain);
    expect(facts.repo).toBe(false);
    expect(facts.branch).toBeNull();
    expect(facts.headSha).toBeNull();
  });

  it('reports no_commits state via null headSha on a fresh repo', async () => {
    const emptyRepo = path.join(tempDir, 'empty');
    fs.mkdirSync(emptyRepo, { recursive: true });
    git(emptyRepo, ['init', '-b', 'main'], env);
    const facts = await adapter.facts(emptyRepo);
    expect(facts.repo).toBe(true);
    expect(facts.headSha).toBeNull();
  });

  it('computes upstream drift from local refs only', async () => {
    const bareOrigin = path.join(tempDir, 'origin.git');
    git(tempDir, ['clone', '--bare', '-b', 'main', root, bareOrigin], env);
    git(root, ['remote', 'add', 'origin', bareOrigin], env);
    git(root, ['fetch', 'origin'], env);
    git(root, ['branch', '--set-upstream-to', 'origin/main'], env);

    fs.writeFileSync(path.join(root, 'two.txt'), '2\n');
    git(root, ['add', 'two.txt'], env);
    git(root, ['commit', '-m', 'second'], env);

    const facts = await adapter.facts(root);
    expect(facts.upstreamDrift).toEqual({ ahead: 1, behind: 0 });
  });

  describe('headContains (merged-delivery lineage)', () => {
    it('proves containment for an ancestor commit and for HEAD itself', async () => {
      const ancestor = git(root, ['rev-parse', 'HEAD'], env).trim();
      const head = commitFile(root, 'two.txt', '2\n', env);
      await expect(adapter.headContains(root, ancestor)).resolves.toEqual({
        ok: true,
        value: { contained: true },
      });
      await expect(adapter.headContains(root, head)).resolves.toEqual({
        ok: true,
        value: { contained: true },
      });
    });

    it('decisively reports a locally known commit that is not an ancestor of HEAD', async () => {
      git(root, ['checkout', '-b', 'side'], env);
      const side = commitFile(root, 'side.txt', 'side\n', env);
      git(root, ['checkout', 'main'], env);
      const result = await adapter.headContains(root, side);
      expect(result).toEqual({ ok: true, value: { contained: false } });
    });

    it('fails closed when the commit is unknown to the local object store', async () => {
      const result = await adapter.headContains(root, 'd'.repeat(40));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('merged_lineage_unavailable');
    });
  });
});
