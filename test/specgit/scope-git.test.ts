import { describe, expect, it } from 'vitest';
import { LocalGitAdapter } from '../../src/gitfacts/local.js';
import { verifyScopeHistory } from '../../src/scope/declaration.js';
import { commitFile, git, initRepo, makeTempDir, rmDir } from './helpers/temp-repo.js';

describe('immutable scope history', () => {
  it('accepts an appended declaration merged by PR and detects a later merged reduction', async () => {
    const temp = makeTempDir();
    try {
      const { root, env } = initRepo(temp);
      const path = 'spec_git/scopes/programme.yaml';
      const scope = (issues: number[]) => JSON.stringify({ version: 1, name: 'programme', parent: 1, required: issues.map((issue) => ({ issue, target: 'preview' })) });
      commitFile(root, path, scope([10]), env);
      git(root, ['checkout', '-b', 'declare-append'], env);
      commitFile(root, path, scope([10, 11]), env);
      git(root, ['checkout', 'main'], env);
      git(root, ['merge', '--no-ff', 'declare-append', '-m', 'merge scope append'], env);
      const adapter = new LocalGitAdapter({ env });
      const read = async () => {
        const history = await adapter.readFileHistory(root, git(root, ['rev-parse', 'HEAD'], env).trim(), path);
        expect(history.ok).toBe(true);
        if (!history.ok) throw new Error(history.message);
        return verifyScopeHistory('programme', history.value.map((revision) => revision.content));
      };
      expect(await read()).toMatchObject({ ok: true, value: { required: [{ issue: 10 }, { issue: 11 }] } });
      git(root, ['checkout', '-b', 'declare-reduction'], env);
      commitFile(root, path, scope([10]), env);
      git(root, ['checkout', 'main'], env);
      git(root, ['merge', '--no-ff', 'declare-reduction', '-m', 'merge scope reduction'], env);
      expect(await read()).toMatchObject({ ok: false, code: 'scope_amendment_unsupported' });
    } finally { rmDir(temp); }
  });

  it('retains removed members across real commits and later reverts independently of checkout', async () => {
    const temp = makeTempDir();
    try {
      const { root, env } = initRepo(temp);
      const path = 'spec_git/scopes/programme.yaml';
      const scope = (issues: number[]) => JSON.stringify({ version: 1, name: 'programme', parent: 1, required: issues.map((issue) => ({ issue, target: 'preview' })) });
      commitFile(root, path, scope([10, 11]), env);
      const initial = (await git(root, ['rev-parse', 'HEAD'])).trim();
      commitFile(root, path, scope([10]), env);
      commitFile(root, path, scope([10, 11]), env);
      const tip = (await git(root, ['rev-parse', 'HEAD'])).trim();
      await git(root, ['checkout', '--detach', initial]);
      const adapter = new LocalGitAdapter({ env });
      const history = await adapter.readFileHistory(root, tip, path);
      expect(history.ok).toBe(true);
      if (!history.ok) return;
      expect(history.value).toHaveLength(3);
      expect(verifyScopeHistory('programme', history.value.map((revision) => revision.content))).toMatchObject({ ok: false, code: 'scope_amendment_unsupported' });
      expect(await adapter.readFileAtCommit(root, tip, path)).toMatchObject({ ok: true, value: { content: scope([10, 11]) } });
    } finally { rmDir(temp); }
  });

  it('rejects revision expressions and missing objects', async () => {
    const temp = makeTempDir();
    try {
      const { root, env } = initRepo(temp);
      const adapter = new LocalGitAdapter({ env });
      expect(await adapter.readFileAtCommit(root, 'HEAD', '.specgit.yaml')).toMatchObject({ ok: false, code: 'git_file_invalid' });
      expect(await adapter.readFileAtCommit(root, 'f'.repeat(40), '.specgit.yaml')).toMatchObject({ ok: false, code: 'git_file_unavailable' });
    } finally { rmDir(temp); }
  });
});
