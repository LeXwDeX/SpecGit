import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireMain, verifyBuildRun } from './publish.mjs';

const source = 'a'.repeat(40);
const run = { id: 123, head_sha: source, head_branch: 'main', head_repository: { full_name: 'LeXwDeX/SpecGit' }, repository: { full_name: 'LeXwDeX/SpecGit' }, path: '.github/workflows/release-prepare.yml', event: 'workflow_dispatch', status: 'completed', conclusion: 'success' };
test('main and build provenance reject stale, foreign or failed candidates', () => {
  requireMain(source, () => ({ ref: 'refs/heads/main', object: { type: 'commit', sha: source } }));
  assert.throws(() => requireMain(source, () => ({ ref: 'refs/heads/main', object: { type: 'commit', sha: 'b'.repeat(40) } })), /main/);
  verifyBuildRun(run, source);
  for (const patch of [{ head_sha: 'b'.repeat(40) }, { head_branch: 'branch' }, { conclusion: 'failure' }, { event: 'pull_request' }, { head_repository: { full_name: 'attacker/fork' } }, { path: '.github/workflows/other.yml' }]) assert.throws(() => verifyBuildRun({ ...run, ...patch }, source), /exact main build/);
});
test('the active release can publish only after all three native smoke jobs succeed', () => {
  const active = { ...run, status: 'in_progress', conclusion: null };
  const jobs = ['linux', 'macos', 'windows'].map(label => ({ name: `Build native release (${label})`, status: 'completed', conclusion: 'success', labels: ['self-hosted'] }));
  verifyBuildRun(active, source, { activeRun: '123', jobs });
  for (const changed of [jobs.slice(1), [...jobs, jobs[0]], jobs.map((j, i) => i ? j : { ...j, conclusion: 'failure' }), jobs.map((j, i) => i ? j : { ...j, labels: ['ubuntu-latest'] })]) assert.throws(() => verifyBuildRun(active, source, { activeRun: '123', jobs: changed }), /three successful/);
  assert.throws(() => verifyBuildRun(active, source, { activeRun: '456', jobs }), /three successful/);
  assert.throws(() => verifyBuildRun(active, source, { jobs }), /three successful/);
});

test('an interrupted signed publication can reuse its bundle only after qualified build and signing jobs', () => {
  const failed = { ...run, conclusion: 'failure' };
  const builds = ['linux', 'macos', 'windows'].map(label => ({ name: `Build native release (${label})`, status: 'completed', conclusion: 'success', labels: ['self-hosted'] }));
  const steps = [
    { name: 'Assemble the three smoke-tested binaries', conclusion: 'success' },
    { name: 'Sign and verify the ZIP checksum manifest', conclusion: 'success' },
    { name: 'Retain signed bundle', conclusion: 'success' },
    { name: 'Publish verified ZIPs, checksums and signature to GitHub Release', conclusion: 'failure' },
  ];
  const assembly = { name: 'assemble', status: 'completed', conclusion: 'failure', steps };
  verifyBuildRun(failed, source, { jobs: [...builds, assembly] });
  for (const jobs of [builds, [...builds, assembly, assembly], [...builds.slice(1), assembly],
    [...builds, { ...assembly, steps: steps.map((step, index) => index === 1 ? { ...step, conclusion: 'failure' } : step) }],
    [...builds, { ...assembly, steps: steps.filter(step => !step.name.startsWith('Sign and verify')) }],
    [...builds, { ...assembly, steps: steps.map(step => ({ ...step, conclusion: 'success' })) }],
  ]) assert.throws(() => verifyBuildRun(failed, source, { jobs }), /recovery/);
  assert.throws(() => verifyBuildRun({ ...failed, head_sha: 'b'.repeat(40) }, source, { jobs: [...builds, assembly] }), /exact main/);
});
