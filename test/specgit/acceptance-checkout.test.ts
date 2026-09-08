import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAcceptanceCheckout as prepareCheckout, prepareGitlabEventBranch } from '../../src/harness-runtime/acceptance-checkout.mjs';
import { readRecord } from '../../src/record/io.js';
import { LocalGitAdapter } from '../../src/gitfacts/local.js';
import { bindingContextMismatch } from '../../src/record/context-match.js';
import { commitFile, git, initRepo, makeTempDir, rmDir } from './helpers/temp-repo.js';

const withAcceptanceCheckout = <T>(root: string, run: (checkout: string) => Promise<T>) =>
  prepareCheckout(root, run, { readRecord, git: new LocalGitAdapter(), bindingContextMismatch });
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach(rmDir); });
function fixture(label = 'delivery', autocrlf = false) {
  const dir = makeTempDir('specgit-acceptance-checkout-'); dirs.push(dir);
  const { root, env } = initRepo(dir);
  // Fixture creation and the real adapter must use the same repository checkout convention.
  git(root, ['config', 'core.autocrlf', String(autocrlf)], env);
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

  it('retains the canonical binding blob and original bytes when Git converts checkout newlines', async () => {
    const f = fixture('delivery', true);
    const before = fs.readFileSync(path.join(f.root, '.specgit.yaml'));
    const blob = git(f.root, ['rev-parse', 'HEAD:.specgit.yaml'], f.env).trim();
    const refs = git(f.root, ['show-ref'], f.env);
    const worktrees = git(f.root, ['worktree', 'list', '--porcelain'], f.env);
    await withAcceptanceCheckout(f.root, async (checkout) => {
      expect(checkout).not.toBe(f.root);
      expect(fs.readFileSync(path.join(checkout, '.specgit.yaml'), 'utf8')).toContain('\r\n');
      expect(git(checkout, ['hash-object', '--path=.specgit.yaml', '.specgit.yaml'], f.env).trim()).toBe(blob);
      expect(bindingContextMismatch({ kind: 'worktree', label: f.label, branch: f.branch },
        await new LocalGitAdapter().facts(checkout))).toBeNull();
    });
    expect(fs.readFileSync(path.join(f.root, '.specgit.yaml'))).toEqual(before);
    expect(git(f.root, ['show-ref'], f.env)).toBe(refs);
    expect(git(f.root, ['worktree', 'list', '--porcelain'], f.env)).toBe(worktrees);
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

  it('preserves unknown dirty evidence instead of making a clean worktree', async () => {
    const f = fixture();
    const facts = await new LocalGitAdapter().facts(f.root);
    vi.spyOn(LocalGitAdapter.prototype, 'facts').mockResolvedValue({ ...facts, dirty: null });
    await withAcceptanceCheckout(f.root, async (root) => { expect(root).toBe(f.root); });
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

describe('explicit GitLab event checkout preparation', () => {
  it('creates the exact event branch from a detached source head and then supports the declared worktree', async () => {
    const f = fixture();
    const eventBranch = 'test/event-head';
    commitFile(f.root, '.specgit.yaml', f.binding.replace(`branch: ${f.branch}`, `branch: ${eventBranch}`), f.env);
    const sha = git(f.root, ['rev-parse', 'HEAD'], f.env).trim();
    const originalRef = git(f.root, ['rev-parse', f.branch], f.env);
    git(f.root, ['checkout', '--detach'], f.env);
    const event = { CI_COMMIT_SHA: sha, CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: eventBranch, CI_MERGE_REQUEST_EVENT_TYPE: 'detached' };
    prepareGitlabEventBranch(f.root, event);
    expect(git(f.root, ['branch', '--show-current'], f.env).trim()).toBe(eventBranch);
    const refs = git(f.root, ['show-ref'], f.env);
    await withAcceptanceCheckout(f.root, async (checkout) => {
      expect((await new LocalGitAdapter().facts(checkout)).headSha).toBe(sha);
      expect(checkout).not.toBe(f.root);
    });
    expect(git(f.root, ['show-ref'], f.env)).toBe(refs);
    expect(git(f.root, ['rev-parse', f.branch], f.env)).toBe(originalRef);
  });

  it.each(['wrong-sha', 'wrong-branch', 'merged-result', 'existing-ref'])('rejects %s without rewriting refs', (kind) => {
    const f = fixture();
    const event = { CI_COMMIT_SHA: kind === 'wrong-sha' ? '0'.repeat(40) : f.head,
      CI_COMMIT_BRANCH: kind === 'existing-ref' ? f.branch : 'test/event',
      CI_MERGE_REQUEST_EVENT_TYPE: kind === 'merged-result' ? 'merged_result' : 'detached' };
    if (kind !== 'wrong-branch') git(f.root, ['checkout', '--detach'], f.env);
    const refs = git(f.root, ['show-ref'], f.env);
    const head = git(f.root, ['rev-parse', 'HEAD'], f.env);
    expect(() => prepareGitlabEventBranch(f.root, event)).toThrow();
    expect(git(f.root, ['show-ref'], f.env)).toBe(refs);
    expect(git(f.root, ['rev-parse', 'HEAD'], f.env)).toBe(head);
  });
});
