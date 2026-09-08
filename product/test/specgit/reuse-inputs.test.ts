import { afterEach, describe, expect, it } from 'vitest';
import { collectReuseInputs, type ReuseInputIdentity } from '../../src/verification/reuse-inputs.js';
import { commitFile, git, initRepo, makeTempDir, rmDir } from './helpers/temp-repo.js';

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(rmDir));
const binding = 'version: 1\ndelivery: example\ncontext: {kind: branch, branch: feature}\nissues: [1]\npr: 2\n';

function repository() {
  const directory = makeTempDir('specgit-reuse-inputs-');
  temporary.push(directory);
  const { root, env } = initRepo(directory);
  const baseSha = git(root, ['rev-parse', 'HEAD'], env).trim();
  const head = commitFile(root, '.specgit.yaml', binding, env);
  const identity: ReuseInputIdentity = {
    sourceSha: head, checkoutSha: head, baseSha, policySha: baseSha,
    recipeDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64),
  };
  return { root, env: { ...process.env, ...env }, identity };
}

describe('immutable inputs for a normalized verification snapshot', () => {
  it('keeps binding-only carrying commits equivalent while retaining their source identities', async () => {
    const { root, env, identity } = repository();
    const first = await collectReuseInputs(root, identity, { env });
    const next = commitFile(root, '.specgit.yaml', binding.replace('[1]', '[1, 3]'), env);
    const second = await collectReuseInputs(root, { ...identity, sourceSha: next, checkoutSha: next }, { env });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('Expected complete immutable inputs');
    expect(second.value.digest).toBe(first.value.digest);
    expect(second.value.sourceSha).not.toBe(first.value.sourceSha);
  });

  it.each(['src/app.ts', 'pnpm-lock.yaml', '.github/workflows/test.yml', 'spec_git/policy.yaml'])('invalidates the complete product tree when %s changes', async (file) => {
    const { root, env, identity } = repository();
    const first = await collectReuseInputs(root, identity, { env });
    const next = commitFile(root, file, 'changed\n', env);
    const second = await collectReuseInputs(root, { ...identity, sourceSha: next, checkoutSha: next }, { env });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('Expected complete immutable inputs');
    expect(second.value.digest).not.toBe(first.value.digest);
  });

  it.each(['baseSha', 'policySha', 'recipeDigest', 'environmentDigest'] as const)('invalidates a changed %s even with the same source tree', async (field) => {
    const { root, env, identity } = repository();
    const first = await collectReuseInputs(root, identity, { env });
    const replacement = field.endsWith('Sha') ? identity.sourceSha : 'c'.repeat(64);
    const second = await collectReuseInputs(root, { ...identity, [field]: replacement }, { env });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('Expected complete immutable inputs');
    expect(second.value.digest).not.toBe(first.value.digest);
  });

  it('compares the actual integration checkout independently from the request source', async () => {
    const { root, env, identity } = repository();
    const first = await collectReuseInputs(root, identity, { env });
    const checkoutSha = commitFile(root, 'integration.txt', 'base contribution\n', env);
    const second = await collectReuseInputs(root, { ...identity, checkoutSha }, { env });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('Expected complete immutable inputs');
    expect(second.value.digest).not.toBe(first.value.digest);
  });

  it.each([binding + 'build: echo unsafe\n', 'invalid: ['])('refuses to exclude an unrecognized binding', async (content) => {
    const { root, env, identity } = repository();
    const next = commitFile(root, '.specgit.yaml', content, env);
    expect((await collectReuseInputs(root, { ...identity, sourceSha: next, checkoutSha: next }, { env })).ok).toBe(false);
  });

  it('includes executable mode changes and refuses submodule snapshots', async () => {
    const { root, env, identity } = repository();
    const first = await collectReuseInputs(root, identity, { env });
    git(root, ['update-index', '--chmod=+x', 'README.md'], env);
    git(root, ['commit', '-m', 'executable mode'], env);
    const executable = git(root, ['rev-parse', 'HEAD'], env).trim();
    const second = await collectReuseInputs(root, { ...identity, checkoutSha: executable }, { env });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('Expected complete immutable inputs');
    expect(second.value.digest).not.toBe(first.value.digest);
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${identity.baseSha},module`], env);
    git(root, ['commit', '-m', 'gitlink'], env);
    const linked = git(root, ['rev-parse', 'HEAD'], env).trim();
    expect((await collectReuseInputs(root, { ...identity, checkoutSha: linked }, { env })).ok).toBe(false);
  });

  it('does not treat revision expressions or missing commit objects as evidence', async () => {
    const { root, env, identity } = repository();
    for (const sourceSha of ['HEAD', identity.sourceSha.slice(0, 7), 'f'.repeat(40)]) {
      expect((await collectReuseInputs(root, { ...identity, sourceSha }, { env })).ok).toBe(false);
    }
  });
});
