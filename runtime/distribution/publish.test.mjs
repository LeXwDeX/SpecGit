import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireMain, verifyBuildRun } from './publish.mjs';

const source = 'a'.repeat(40);
test('main identity and native build provenance reject foreign, stale and unsuccessful candidates', () => {
  requireMain(source, () => ({ ref: 'refs/heads/main', object: { type: 'commit', sha: source } }));
  assert.throws(() => requireMain(source, () => ({ ref: 'refs/heads/main', object: { type: 'commit', sha: 'b'.repeat(40) } })), /main/);
  const run = { head_sha: source, head_branch: 'main', head_repository: { full_name: 'LeXwDeX/SpecGit' }, repository: { full_name: 'LeXwDeX/SpecGit' }, path: '.github/workflows/release-prepare.yml', event: 'workflow_dispatch', status: 'completed', conclusion: 'success' };
  verifyBuildRun(run, source);
  for (const patch of [{ head_sha: 'b'.repeat(40) }, { head_branch: 'branch' }, { conclusion: 'failure' }, { event: 'pull_request' }, { head_repository: { full_name: 'attacker/fork' } }, { path: '.github/workflows/other.yml' }]) assert.throws(() => verifyBuildRun({ ...run, ...patch }, source), /successful main build/);
});
