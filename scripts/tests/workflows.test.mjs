import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parse } from 'yaml';
import { assertReleaseActorCredentials } from '../release-workflow-contract.mjs';
const workflow = name => readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');
const release = workflow('release-prepare.yml');

test('release is main-only, build-gated, actor-owned and signature-verified', () => {
  assertReleaseActorCredentials(release, 'Release');
});
for (const [label, mutate] of [
  ['foreign signing identity', s => s.replace('LeXwDeX/SpecGit/.github/workflows/release-prepare.yml@refs/heads/main', 'foreign/repo/.github/workflows/release-prepare.yml@refs/heads/main')],
  ['unsigned publication', s => s.replaceAll('cosign verify-blob', 'echo verify-blob')],
  ['insecure verification', s => s.replace('cosign verify-blob', 'cosign verify-blob --insecure-ignore-tlog')],
  ['publication before build success', s => s.replace('needs: build', 'needs: absent')],
  ['persisted checkout token', s => s.replace('persist-credentials: false', 'persist-credentials: true')],
  ['extra publication credential', s => s.replace('GH_TOKEN: ${{ github.token }}', 'GH_TOKEN: ${{ secrets.UNRELATED_TOKEN }}')],
]) test(`rejects ${label}`, () => assert.throws(() => assertReleaseActorCredentials(mutate(release), label)));

test('every workflow uses pinned actions, approved runner routes and isolated checkout credentials', () => {
  for (const file of readdirSync(new URL('../../.github/workflows/', import.meta.url)).filter(x => x.endsWith('.yml'))) {
    const doc = parse(workflow(file));
    assert.deepEqual(doc.permissions, { contents: 'read' }, file);
    for (const [id, job] of Object.entries(doc.jobs)) {
      const routes = job.strategy?.matrix?.include
        ? job.strategy.matrix.include.map(row => row.os)
        : [job['runs-on']];
      assert(routes.length > 0, `${file}/${id}: missing native runner route`);
      for (const route of routes) {
        assert(['ubuntu-24.04', 'macos-15', 'windows-2025'].includes(route),
          `${file}/${id}: runner must use a standard GitHub-hosted label`);
      }
      for (const step of job.steps ?? []) {
        if (step.uses) assert.match(step.uses, /@[a-f\d]{40}$/, `${file}/${id}: unpinned action`);
        if (step.uses?.startsWith('actions/checkout@')) assert.equal(step.with?.['persist-credentials'], false);
        if (step.uses?.startsWith('actions/setup-node@')) assert.equal(step.with?.['package-manager-cache'], false);
        assert(!step.uses?.startsWith('actions/cache@'), 'No cross-run executable cache.');
      }
    }
  }
});

test('protected acceptance requires applicable native verification and a ready main request', () => {
  const { jobs } = parse(workflow('ci.yml'));
  assert.deepEqual(jobs.required_verification.needs, ['changes', 'metadata', 'rust']);
  assert.equal(jobs.required_verification.if, 'always()');
  assert.match(jobs.required_verification.steps[0].run, /true\) test "\$RUST_RESULT" = success/);
  assert.match(jobs.required_verification.steps[0].run, /false\) test "\$RUST_RESULT" = skipped/);
  assert.equal(jobs.acceptance.name, 'SpecGit Acceptance');
  assert.equal(jobs.acceptance.needs, 'required_verification');
  assert.equal(jobs.acceptance.if, 'always()');
  const gate = jobs.acceptance.steps[0].run;
  assert(gate.includes('test "$VERIFICATION_RESULT" = success'));
  assert(gate.includes('test "$PR_DRAFT" = false'));
  assert(gate.includes('test "$PR_TARGET" = main'));
  assert.deepEqual(jobs.rust.strategy.matrix.include.map(x => x.target).sort(), ['aarch64-apple-darwin', 'x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu']);
  const commands = jobs.rust.steps.map(s => s.run ?? '').join('\n');
  for (const phase of ['lint', 'compile-tests', 'source-tests', 'distribution-tests', 'compile-release', 'install', 'profile']) assert(commands.includes(`--phase ${phase} `));
});

test('CI and release use GitHub-hosted native runners for all platforms', () => {
  for (const [file, id] of [['ci.yml', 'rust'], ['release-prepare.yml', 'build']]) {
    const job = parse(workflow(file)).jobs[id];
    assert.deepEqual(job.strategy.matrix.include.map(row => [row.label, row.os]), [
      ['linux', 'ubuntu-24.04'],
      ['macos', 'macos-15'],
      ['windows', 'windows-2025'],
    ]);
    const check = job.steps.find(step => step.name === 'Verify hosted macOS ARM64 toolchain');
    assert.equal(check.if, "runner.os == 'macOS'");
    assert(check.run.includes('test "$RUNNER_ENVIRONMENT" = github-hosted'));
    assert(check.run.includes('test "$RUNNER_ARCH" = ARM64'));
  }
});
