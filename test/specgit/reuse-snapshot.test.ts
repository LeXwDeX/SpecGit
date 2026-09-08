import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectReuseInputs } from '../../src/verification/reuse-inputs.js';
import { materializeReuseSnapshot, verifyReuseSnapshot } from '../../src/verification/reuse-snapshot.js';
import { commitFile, git, initRepo, makeTempDir, rmDir } from './helpers/temp-repo.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(rmDir));

async function fixture() {
  const parent = makeTempDir('specgit-reuse-snapshot-');
  directories.push(parent);
  const { root, env } = initRepo(path.join(parent, 'repo'));
  const baseSha = git(root, ['rev-parse', 'HEAD'], env).trim();
  fs.writeFileSync(path.join(root, 'binary.dat'), Buffer.from([0, 255, 13, 10, 128]));
  git(root, ['add', 'binary.dat'], env);
  const sourceSha = commitFile(root, '.specgit.yaml',
    'version: 1\ndelivery: example\ncontext: {kind: branch, branch: feature}\nissues: [1]\npr: 2\n', env);
  const inputs = await collectReuseInputs(root, {
    sourceSha, checkoutSha: sourceSha, baseSha, policySha: baseSha,
    recipeDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64),
  });
  if (!inputs.ok) throw new Error('Expected complete inputs');
  return { root, env, inputs: inputs.value, destination: path.join(parent, 'snapshot') };
}

describe('normalized verification execution snapshot', () => {
  it('exports the immutable checkout as exact bytes without Git metadata, binding or dirty files', async () => {
    const { root, inputs, destination } = await fixture();
    fs.writeFileSync(path.join(root, 'binary.dat'), 'dirty');
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'not an input');
    const result = await materializeReuseSnapshot(root, inputs, destination);
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(destination, 'binary.dat'))).toEqual(Buffer.from([0, 255, 13, 10, 128]));
    for (const file of ['.git', '.specgit.yaml', 'untracked.txt']) {
      expect(fs.existsSync(path.join(destination, file))).toBe(false);
    }
    if (!result.ok) throw new Error('Expected snapshot');
    expect((await verifyReuseSnapshot(destination, inputs.checkoutTreeDigest, result.value)).ok).toBe(true);
  });

  it.each(['changed', 'missing', 'extra', 'binding', 'git'])('rejects %s execution inputs before any business command', async (change) => {
    const { root, inputs, destination } = await fixture();
    const snapshot = await materializeReuseSnapshot(root, inputs, destination);
    if (!snapshot.ok) throw new Error('Expected snapshot');
    if (change === 'changed') fs.writeFileSync(path.join(destination, 'binary.dat'), 'different');
    if (change === 'missing') fs.unlinkSync(path.join(destination, 'binary.dat'));
    if (change === 'extra') fs.writeFileSync(path.join(destination, 'unexpected.txt'), 'extra');
    if (change === 'binding') fs.writeFileSync(path.join(destination, '.specgit.yaml'), 'issues: [2]');
    if (change === 'git') fs.mkdirSync(path.join(destination, '.git'));
    expect((await verifyReuseSnapshot(destination, inputs.checkoutTreeDigest, snapshot.value)).ok).toBe(false);
  });

  it('refuses a tampered manifest even when all bytes match that manifest', async () => {
    const { root, inputs, destination } = await fixture();
    const snapshot = await materializeReuseSnapshot(root, inputs, destination);
    if (!snapshot.ok) throw new Error('Expected snapshot');
    expect((await verifyReuseSnapshot(destination, 'f'.repeat(64), snapshot.value)).ok).toBe(false);
  });

  it('never overwrites an existing destination', async () => {
    const { root, inputs, destination } = await fixture();
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, 'keep.txt'), 'keep');
    expect((await materializeReuseSnapshot(root, inputs, destination)).ok).toBe(false);
    expect(fs.readFileSync(path.join(destination, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('refuses a link replacing a snapshot file', async () => {
    const { root, inputs, destination } = await fixture();
    const snapshot = await materializeReuseSnapshot(root, inputs, destination);
    if (!snapshot.ok) throw new Error('Expected snapshot');
    fs.unlinkSync(path.join(destination, 'binary.dat'));
    // A directory junction is available to ordinary Windows CI users too.
    fs.symlinkSync(root, path.join(destination, 'binary.dat'), 'junction');
    expect((await verifyReuseSnapshot(destination, inputs.checkoutTreeDigest, snapshot.value)).ok).toBe(false);
  });
});
