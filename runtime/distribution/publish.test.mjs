import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publishNpm, requireMain, verifyBuildRun } from './publish.mjs';

const source = 'a'.repeat(40);
const packages = ['specgit-darwin-arm64', 'specgit-linux-x64-gnu', 'specgit-win32-x64', 'specgit'].map(name => ({ name, version: '2.0.0', integrity: `sha512-${name}`, tarball: `/qualified/${name}-2.0.0.tgz` }));
const release = { version: '2.0.0', source, packages };
function transport({ present = [], responseLost, conflict = false, invisible = false } = {}) {
  const published = new Set(present);
  const calls = [];
  const tags = new Map();
  const registry = async () => {
    if (conflict) throw new Error('Published bytes differ');
    const observations = packages.map(item => ({ ...item, state: published.has(item.name) && !invisible ? 'verified' : 'missing' }));
    return { observations, can_promote_latest: observations.every(item => item.state === 'verified') };
  };
  const npm = args => {
    calls.push(args);
    if (args[0] === 'publish') {
      const artifact = packages.find(item => item.tarball === args[1]);
      assert(artifact);
      if (artifact.name === 'specgit') assert(packages.filter(item => item.name !== 'specgit').every(item => published.has(item.name)), 'wrapper must be last');
      published.add(artifact.name);
      if (responseLost === artifact.name) throw new Error('response lost after server applied publication');
    }
    if (args[0] === 'dist-tag') tags.set(args[2].split('@')[0], '2.0.0');
    if (args[0] === 'view') return JSON.stringify(tags.get(args[1]));
    return '';
  };
  return { registry, npm, calls, published, wait: async () => {}, attempts: 2 };
}
test('publishes exact artifacts before the wrapper, then verifies latest last', async () => {
  const io = transport();
  const result = await publishNpm(release, io);
  assert.equal(result.latest_verified, true);
  const publishes = io.calls.filter(call => call[0] === 'publish');
  assert.deepEqual(publishes.map(call => call[1]), packages.map(item => item.tarball));
  assert(publishes.every(call => call.includes('--ignore-scripts') && call.includes('--provenance=false') && call.includes('--tag=v2-staging')));
  assert.equal(io.calls.filter(call => call[0] === 'dist-tag').at(-1)[2], 'specgit@2.0.0');
});
test('lost publish response stops writes; retry reads and reuses the applied immutable package', async () => {
  const io = transport({ responseLost: packages[0].name });
  await assert.rejects(publishNpm(release, io), /response lost/);
  assert.equal(io.calls.filter(call => call[0] === 'publish').length, 1);
  assert.equal(io.calls.some(call => call[0] === 'dist-tag'), false);
  const retry = transport({ present: [...io.published] });
  await publishNpm(release, retry);
  assert.equal(retry.calls.some(call => call[0] === 'publish' && call[1] === packages[0].tarball), false);
});
test('matching complete releases are reused; mismatched bytes never publish or promote', async () => {
  const existing = transport({ present: packages.map(item => item.name) });
  await publishNpm(release, existing);
  assert.equal(existing.calls.some(call => call[0] === 'publish'), false);
  const conflict = transport({ conflict: true });
  await assert.rejects(publishNpm(release, conflict), /Published bytes differ/);
  assert.deepEqual(conflict.calls.map(call => call[0]), ['whoami']);
});
test('unknown registry propagation is bounded and never exposes an incomplete wrapper or latest', async () => {
  const io = transport({ invisible: true });
  await assert.rejects(publishNpm(release, io), /propagation/);
  assert.equal(io.calls.filter(call => call[0] === 'publish').length, 1);
  assert.equal(io.calls.some(call => call[0] === 'dist-tag'), false);
});
test('main identity and native build provenance reject foreign, stale and unsuccessful candidates', () => {
  requireMain(source, () => ({ ref: 'refs/heads/main', object: { type: 'commit', sha: source } }));
  assert.throws(() => requireMain(source, () => ({ ref: 'refs/heads/main', object: { type: 'commit', sha: 'b'.repeat(40) } })), /main/);
  const run = { head_sha: source, head_branch: 'main', head_repository: { full_name: 'LeXwDeX/SpecGit' }, repository: { full_name: 'LeXwDeX/SpecGit' }, path: '.github/workflows/release-prepare.yml', event: 'workflow_dispatch', status: 'completed', conclusion: 'success' };
  verifyBuildRun(run, source);
  for (const patch of [{ head_sha: 'b'.repeat(40) }, { head_branch: 'branch' }, { conclusion: 'failure' }, { event: 'pull_request' }, { head_repository: { full_name: 'attacker/fork' } }, { path: '.github/workflows/other.yml' }]) assert.throws(() => verifyBuildRun({ ...run, ...patch }, source), /successful main build/);
});
