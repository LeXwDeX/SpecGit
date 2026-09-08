import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withAcceptanceCheckout } from '../../src/automation/acceptance-checkout.js';
import { LocalGitAdapter } from '../../src/gitfacts/local.js';
import { bindingContextMismatch } from '../../src/record/context-match.js';
import { commitFile, git, initRepo, makeTempDir, rmDir } from './helpers/temp-repo.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(rmDir));
function fixture(label = 'delivery') {
  const dir = makeTempDir('specgit-acceptance-checkout-'); dirs.push(dir);
  const { root, env } = initRepo(dir);
  const branch = git(root, ['branch', '--show-current'], env).trim();
  const binding = `version: 1\ndelivery: context-repair\ncontext:\n  kind: worktree\n  label: ${label}\n  branch: ${branch}\nissues: [1]\npr: 2\n`;
  const head = commitFile(root, '.specgit.yaml', binding, env);
  return { root, env, branch, binding, head, label };
}

describe('acceptance checkout preparation', () => {
  it('reproduces the declared worktree at the same head without changing binding or branch refs', async () => {
    const f = fixture();
    const gitAdapter = new LocalGitAdapter();
    const before = git(f.root, ['worktree', 'list', '--porcelain'], f.env);
    let checkout = '';
    await withAcceptanceCheckout(f.root, async (root) => {
      checkout = root;
      const facts = await gitAdapter.facts(root);
      expect(bindingContextMismatch({ kind: 'worktree', label: f.label, branch: f.branch }, facts)).toBeNull();
      expect(facts.headSha).toBe(f.head);
      expect(fs.readFileSync(path.join(root, '.specgit.yaml'), 'utf8')).toBe(f.binding);
    });
    expect(fs.existsSync(checkout)).toBe(false);
    expect(git(f.root, ['worktree', 'list', '--porcelain'], f.env)).toBe(before);
    expect(git(f.root, ['rev-parse', 'HEAD'], f.env).trim()).toBe(f.head);
    expect(git(f.root, ['branch', '--show-current'], f.env).trim()).toBe(f.branch);
  });

  it('keeps wrong-branch evidence intact for the normal gate to reject', async () => {
    const f = fixture(); git(f.root, ['switch', '-c', 'other'], f.env);
    await withAcceptanceCheckout(f.root, async (root) => {
      expect(root).toBe(f.root);
      expect((await new LocalGitAdapter().facts(root)).branch).toBe('other');
    });
  });

  it('does not discard dirty tracked inputs by creating a clean snapshot', async () => {
    const f = fixture(); fs.appendFileSync(path.join(f.root, '.specgit.yaml'), '# local change\n');
    await withAcceptanceCheckout(f.root, async (root) => {
      expect(root).toBe(f.root);
      expect((await new LocalGitAdapter().facts(root)).dirty).toBe(true);
    });
  });

  it('cleans up registration when the verdict callback fails', async () => {
    const f = fixture();
    const before = git(f.root, ['worktree', 'list', '--porcelain'], f.env);
    await expect(withAcceptanceCheckout(f.root, async () => { throw new Error('verdict failed'); })).rejects.toThrow('verdict failed');
    expect(git(f.root, ['worktree', 'list', '--porcelain'], f.env)).toBe(before);
  });

  it.each(['..', '../outside'])('refuses unsafe label %s', async (label) => {
    const f = fixture(label);
    await expect(withAcceptanceCheckout(f.root, async () => 0)).rejects.toThrow(/label/i);
  });
});
