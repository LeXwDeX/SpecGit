import { describe, expect, it } from 'vitest';
import { LocalGitAdapter } from '../../src/gitfacts/local.js';
import { commitFile, git, initRepo, makeTempDir, rmDir } from './helpers/temp-repo.js';

describe('immutable verification changes', () => {
  it('includes gitlink changes even when local Git configuration hides submodules', async () => {
    const temp = makeTempDir();
    try {
      const { root, env } = initRepo(temp);
      const first = git(root, ['rev-parse', 'HEAD'], env).trim();
      git(root, ['update-index', '--add', '--cacheinfo', `160000,${first},vendor/lib`], env);
      git(root, ['commit', '-m', 'add gitlink'], env);
      const base = git(root, ['rev-parse', 'HEAD'], env).trim();
      git(root, ['update-index', '--cacheinfo', `160000,${base},vendor/lib`], env);
      git(root, ['commit', '-m', 'update gitlink'], env);
      const head = git(root, ['rev-parse', 'HEAD'], env).trim();
      git(root, ['config', 'diff.ignoreSubmodules', 'all'], env);
      expect(await new LocalGitAdapter({ env }).changesBetween(root, base, head)).toMatchObject({
        ok: true, value: { changes: [{ path: 'vendor/lib', status: 'M', oldMode: '160000', newMode: '160000' }] },
      });
    } finally { rmDir(temp); }
  });

  it('compares the complete PR diff and retains both sides of a rename independently of checkout', async () => {
    const temp = makeTempDir();
    try {
      const { root, env } = initRepo(temp);
      commitFile(root, 'src/product.ts', 'product', env);
      const mergeBaseSha = git(root, ['rev-parse', 'HEAD'], env).trim();
      git(root, ['checkout', '-b', 'delivery'], env);
      git(root, ['mv', 'src/product.ts', 'GUIDE.md'], env);
      git(root, ['commit', '-m', 'rename product'], env);
      const headSha = git(root, ['rev-parse', 'HEAD'], env).trim();
      git(root, ['checkout', 'main'], env);
      commitFile(root, 'target-only.txt', 'target moved', env);
      const baseSha = git(root, ['rev-parse', 'HEAD'], env).trim();
      const result = await new LocalGitAdapter({ env }).changesBetween(root, baseSha, headSha);
      expect(result).toMatchObject({ ok: true, value: { baseSha, mergeBaseSha, headSha, changes: [
        { path: 'GUIDE.md', status: 'A', oldMode: '000000', newMode: '100644' },
        { path: 'src/product.ts', status: 'D', oldMode: '100644', newMode: '000000' },
      ] } });
    } finally { rmDir(temp); }
  });

  it('rejects mutable refs and missing commit objects', async () => {
    const temp = makeTempDir();
    try {
      const { root, env } = initRepo(temp);
      const head = git(root, ['rev-parse', 'HEAD'], env).trim();
      const adapter = new LocalGitAdapter({ env });
      expect(await adapter.changesBetween(root, 'HEAD', head)).toMatchObject({ ok: false, code: 'verification_changes_unavailable' });
      expect(await adapter.changesBetween(root, 'f'.repeat(40), head)).toMatchObject({ ok: false, code: 'verification_changes_unavailable' });
    } finally { rmDir(temp); }
  });

  it.each([':100644 100644 broken broken M\0x\0', ':100644 100644 ' + 'a'.repeat(40) + ' ' + 'b'.repeat(40) + ' M\0x', ''])('rejects incomplete Git evidence rather than classifying an empty diff: %j', async (raw) => {
    const adapter = new LocalGitAdapter({ spawnImpl: async (_command, args) => {
      if (args.includes('--is-shallow-repository')) return { stdout: 'false\n', stderr: '' };
      if (args.includes('merge-base')) return { stdout: 'a'.repeat(40) + '\n' + (raw === '' ? 'b'.repeat(40) + '\n' : ''), stderr: '' };
      return { stdout: raw, stderr: '' };
    } });
    expect(await adapter.changesBetween('/repo', 'a'.repeat(40), 'b'.repeat(40))).toMatchObject({ ok: false, code: 'verification_changes_unavailable' });
  });
});
