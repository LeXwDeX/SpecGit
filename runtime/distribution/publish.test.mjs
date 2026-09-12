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
