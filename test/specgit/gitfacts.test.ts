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

  describe('commitFile (binding commit past the local-asset ignore, #292)', () => {
    it('force-stages ignored authoritative files, commits exactly them, and is idempotent', async () => {
      // The #292 shape: .gitignore shields the delivery assets, so a
      // plain `git add` would refuse them — the binding commit must
      // carry them into git anyway, on a real repo.
      fs.writeFileSync(path.join(root, '.gitignore'), ['/.specgit.yaml', '/spec_git/'].join('\n') + '\n');
      fs.writeFileSync(path.join(root, 'readme.txt'), 'base\n');
      git(root, ['add', '.gitignore', 'readme.txt'], env);
      git(root, ['commit', '-m', 'base'], env);

      fs.writeFileSync(path.join(root, '.specgit.yaml'), 'version: 1\n');
      fs.mkdirSync(path.join(root, 'spec_git'), { recursive: true });
      fs.writeFileSync(path.join(root, 'spec_git', 'policy.yaml'), 'version: 1\n');
      // Sanity: git really ignores both files (clean porcelain).
      expect(git(root, ['status', '--porcelain'], env).trim()).toBe('');

      const first = await adapter.commitFile(
        root,
        ['.specgit.yaml', 'spec_git/policy.yaml'],
        'chore: record delivery binding for x'
      );
      expect(first).toEqual({ ok: true, value: { committed: true } });
      // Both files are in HEAD and the tree is clean around them.
      const tracked = git(root, ['ls-tree', '-r', '--name-only', 'HEAD'], env)
        .split('\n')
        .filter((line) => line.includes('specgit') || line.includes('spec_git'));
      expect(tracked).toEqual(['.specgit.yaml', 'spec_git/policy.yaml']);
      expect(git(root, ['status', '--porcelain'], env).trim()).toBe('');

      // Idempotent: an unchanged tree commits nothing on re-run.
      const second = await adapter.commitFile(
        root,
        ['.specgit.yaml', 'spec_git/policy.yaml'],
        'chore: record delivery binding for x'
      );
      expect(second).toEqual({ ok: true, value: { committed: false } });
    });
  });

  describe('anchor validation (issue #76)', () => {
    const HEX40 = 'a1b2c3d4'.padEnd(40, '0');
    const HEX64 = 'e5f6a7b8'.padEnd(64, '0');

    /** Spawn spy: records every git invocation; success means exit 0. */
    function spyAdapter() {
      const gitArgs: string[][] = [];
      const spawnImpl = async (_command: string, args: string[]) => {
        gitArgs.push(args);
        return { stdout: '', stderr: '' };
      };
      return { spy: new LocalGitAdapter({ spawnImpl }), gitArgs };
    }

    it('passes full-length hex anchors (40 and 64) through to git unchanged', async () => {
      const { spy, gitArgs } = spyAdapter();
      await expect(spy.headContains(root, HEX40)).resolves.toEqual({
        ok: true,
        value: { contained: true },
      });
      await expect(spy.headContains(root, HEX64)).resolves.toEqual({
        ok: true,
        value: { contained: true },
      });
      expect(gitArgs).toEqual([
        ['-C', root, 'merge-base', '--is-ancestor', HEX40, 'HEAD'],
        ['-C', root, 'merge-base', '--is-ancestor', HEX64, 'HEAD'],
      ]);
    });

    it('rejects empty and whitespace anchors without invoking git', async () => {
      const { spy, gitArgs } = spyAdapter();
      for (const anchor of ['', '   ', `  ${HEX40}  `]) {
        const result = await spy.headContains(root, anchor);
        expect(result.ok).toBe(false);
        if (result.ok) continue;
        expect(result.code).toBe('merged_lineage_unavailable');
      }
      expect(gitArgs).toEqual([]);
    });

    it('rejects ref-like and malformed anchors without invoking git', async () => {
      const { spy, gitArgs } = spyAdapter();
      const anchors = [
        'origin/main',
        'HEAD~1',
        'refs/heads/main',
        'abc123', // abbreviated sha: git would resolve it as an abbreviation
        'g'.repeat(40), // right length, not hex
        'a'.repeat(39), // one short of a sha1 object id
        'a'.repeat(41),
        'a'.repeat(63), // one short of a sha256 object id
        'a'.repeat(65),
      ];
      for (const anchor of anchors) {
        const result = await spy.headContains(root, anchor);
        expect(result.ok, `anchor ${anchor}`).toBe(false);
        if (result.ok) continue;
        expect(result.code, `anchor ${anchor}`).toBe('merged_lineage_unavailable');
      }
      expect(gitArgs).toEqual([]);
    });

    it('never resolves a ref-like anchor as a ref on a real repository', async () => {
      // Before #76, `git merge-base --is-ancestor origin/main HEAD` exits 0
      // and the ref is silently accepted as a lineage anchor — so the repo
      // must actually carry a resolvable origin/main that HEAD contains.
      const bareOrigin = path.join(tempDir, 'origin.git');
      git(tempDir, ['clone', '--bare', '-b', 'main', root, bareOrigin], env);
      git(root, ['remote', 'add', 'origin', bareOrigin], env);
      git(root, ['fetch', 'origin'], env);
      const result = await adapter.headContains(root, 'origin/main');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('merged_lineage_unavailable');
    });
  });

  describe('hooksPath', () => {
    it('resolves the absolute .git/hooks directory of a plain repository', async () => {
      const result = await adapter.hooksPath(root);
      expect(result).toEqual({
        ok: true,
        value: path.join(root, '.git', 'hooks'),
      });
    });

    it('resolves a relative core.hooksPath against the repository root', async () => {
      git(root, ['config', 'core.hooksPath', '.husky'], env);
      const result = await adapter.hooksPath(root);
      expect(result).toEqual({ ok: true, value: path.join(root, '.husky') });
    });

    it('resolves the shared hooks directory from inside a linked worktree', async () => {
      const wtRoot = path.join(tempDir, 'wt-hooks');
      git(root, ['worktree', 'add', wtRoot, '-b', 'feat/wt-hooks'], env);
      const result = await adapter.hooksPath(wtRoot);
      // Hooks live in the common dir (the main repository's .git), not the
      // per-worktree gitdir: a worktree init must not fork its own guard.
      // Compare native-canonicalized paths on both sides: git canonicalizes
      // symlinks (/var → /private/var on macOS) and emits long paths on
      // Windows while os.tmpdir() there is the 8.3 short form — only the
      // native realpath (GetFinalPathNameByHandle / realpath(3)) lands both
      // sides on the same physical directory spelling.
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const canonical = (p: string) => fs.realpathSync.native(p);
      expect(canonical(result.value)).toBe(canonical(path.join(root, '.git', 'hooks')));
    });

    it('fails closed outside a git repository', async () => {
      const plain = path.join(tempDir, 'plain-dir');
      fs.mkdirSync(plain, { recursive: true });
      const result = await adapter.hooksPath(plain);
      expect(result.ok).toBe(false);
    });
  });
});
