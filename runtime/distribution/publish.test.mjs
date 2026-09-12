import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publishChannels, publishNpm, requireMain, verifyBuildRun, verifyRecovery } from './publish.mjs';

const source = 'a'.repeat(40);
const packages = ['specgit-darwin-arm64', 'specgit-linux-x64-gnu', 'specgit-win32-x64', 'specgit'].map(name => ({ name, version: '2.0.0', tarball: `/qualified/${name}.tgz`, executable_sha256: 'c'.repeat(64) }));
const release = { version: '2.0.0', source, packages };
test('channels are independent, preflight never writes, and registry conflicts precede combined writes', async () => {
  const calls = [];
  const io = { registry: async () => { calls.push('registry'); return { phase: 'platforms_missing' }; }, github: () => { calls.push('github'); return {}; }, npm: async () => { calls.push('npm'); return {}; } };
  await publishChannels(release, '.', release, { github: true }, io);
  assert.deepEqual(calls.splice(0), ['github']);
  await publishChannels(release, '.', release, { npm: true }, io);
  assert.deepEqual(calls.splice(0), ['registry', 'npm']);
  const preflight = await publishChannels(release, '.', release, { npm: true, github: true, preflight: true }, io);
  assert.equal(preflight.publication_performed, false);
  assert.deepEqual(calls.splice(0), ['registry']);
  await publishChannels(release, '.', release, { npm: true, github: true }, io);
  assert.deepEqual(calls.splice(0), ['registry', 'github', 'npm']);
  await assert.rejects(publishChannels(release, '.', release, { npm: true, github: true }, { ...io, registry: async () => { throw new Error('conflicting bytes'); } }), /conflicting bytes/);
  assert.deepEqual(calls, []);
});
function transport({ present = [], lost, conflict, invisible } = {}) {
  const published = new Set(present);
  const calls = [];
  const tags = new Map();
  return { calls, published, attempts: 2, wait: async () => {}, registry: async () => {
    if (conflict) throw new Error('Published bytes differ');
    const observations = packages.map(p => ({ ...p, state: published.has(p.name) && !invisible ? 'verified' : 'missing' }));
    return { observations, can_promote_latest: observations.every(p => p.state === 'verified') };
  }, npm: args => {
    calls.push(args);
    if (args[0] === 'publish') {
      const item = packages.find(p => p.tarball === args[1]);
      if (item.name === 'specgit') assert(packages.filter(p => p.name !== 'specgit').every(p => published.has(p.name)));
      published.add(item.name);
      if (item.name === lost) throw new Error('response lost');
    }
    if (args[0] === 'dist-tag') tags.set(args[2].split('@')[0], '2.0.0');
    if (args[0] === 'view') return JSON.stringify(tags.get(args[1]));
    return '';
  } };
}
test('npm resumes existing Mac/Linux versions and promotes the wrapper last', async () => {
  const io = transport({ present: packages.slice(0, 2).map(p => p.name) });
  assert.equal((await publishNpm(release, io)).latest_verified, true);
  assert.deepEqual(io.calls.filter(c => c[0] === 'publish').map(c => c[1]), packages.slice(2).map(p => p.tarball));
  assert.equal(io.calls.filter(c => c[0] === 'dist-tag').at(-1)[2], 'specgit@2.0.0');
});
test('lost npm responses stop writes and subsequent runs reconcile the applied version', async () => {
  const io = transport({ lost: packages[0].name });
  await assert.rejects(publishNpm(release, io), /response lost/);
  assert.equal(io.calls.filter(c => c[0] === 'publish').length, 1);
  assert(!io.calls.some(c => c[0] === 'dist-tag'));
  const retry = transport({ present: [...io.published] });
  await publishNpm(release, retry);
  assert(!retry.calls.some(c => c[0] === 'publish' && c[1] === packages[0].tarball));
});
test('registry conflicts and unobserved publication never promote latest', async () => {
  for (const options of [{ conflict: true }, { invisible: true }]) {
    const io = transport(options);
    await assert.rejects(publishNpm(release, io), /differ|unknown/);
    assert(!io.calls.some(c => c[0] === 'dist-tag'));
  }
});
test('explicit archived npm recovery requires unchanged runtime inputs and matching current binaries', () => {
  const previous = { ...release, source: 'b'.repeat(40) };
  const calls = [];
  verifyRecovery(release, previous, args => calls.push(args));
  assert.deepEqual(calls[0], ['merge-base', '--is-ancestor', previous.source, source]);
  assert(calls[1].includes('runtime/src'));
  assert.throws(() => verifyRecovery(release, previous, () => { throw new Error('changed source'); }), /changed source/);
  assert.throws(() => verifyRecovery(release, { ...previous, packages: previous.packages.map(p => ({ ...p, executable_sha256: 'd'.repeat(64) })) }, () => {}), /executables differ/);
  assert.throws(() => verifyRecovery(release, { ...previous, version: '2.0.1' }, () => {}), /same version/);
});
test('main identity and native build provenance reject foreign, stale and unsuccessful candidates', () => {
  requireMain(source, () => ({ ref: 'refs/heads/main', object: { type: 'commit', sha: source } }));
  assert.throws(() => requireMain(source, () => ({ ref: 'refs/heads/main', object: { type: 'commit', sha: 'b'.repeat(40) } })), /main/);
  const run = { head_sha: source, head_branch: 'main', head_repository: { full_name: 'LeXwDeX/SpecGit' }, repository: { full_name: 'LeXwDeX/SpecGit' }, path: '.github/workflows/release-prepare.yml', event: 'workflow_dispatch', status: 'completed', conclusion: 'success' };
  verifyBuildRun(run, source);
  for (const patch of [{ head_sha: 'b'.repeat(40) }, { head_branch: 'branch' }, { conclusion: 'failure' }, { event: 'pull_request' }, { head_repository: { full_name: 'attacker/fork' } }, { path: '.github/workflows/other.yml' }]) assert.throws(() => verifyBuildRun({ ...run, ...patch }, source), /successful main build/);
});
