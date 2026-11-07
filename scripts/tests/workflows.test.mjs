import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

test('CI native routes preserve owner and fork runner labels', () => {
  const job = parse(workflow('ci.yml')).jobs.rust;
  assert.equal(job['runs-on'], "${{ (github.event_name == 'push' && github.ref == 'refs/heads/main' || github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository) && fromJSON(matrix.runs_on) || fromJSON(matrix.hosted_runs_on) }}");
  assert.deepEqual(job.strategy.matrix.include.map(row => [row.label, JSON.parse(row.runs_on), JSON.parse(row.hosted_runs_on)]), [
    ['linux', ['self-hosted', 'Linux', 'X64', 'azure-f16'], ['ubuntu-24.04']],
    ['macos', ['macos-15'], ['macos-15']],
    ['windows', ['self-hosted', 'Windows', 'X64', 'azure-win'], ['windows-2025']],
  ]);
});

test('CI and release preserve native platform labels and hosted macOS checks', () => {
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

test('PR classifier changes cannot suppress Rust or dependency classification', () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'specgit-ci-scope-')));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.name', 'CI test');
    git('config', 'user.email', 'ci@example.invalid');
    mkdirSync(path.join(root, 'scripts'));
    const classifier = path.join(root, 'scripts/ci-change-scope.mjs');
    writeFileSync(classifier, readFileSync(new URL('../ci-change-scope.mjs', import.meta.url)));
    git('add', '.'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(classifier, "process.stdout.write('build=false\\nmetadata=true\\ndependencies=false\\n');\n");
    git('add', '.'); git('commit', '-qm', 'replace classifier');
    const head = git('rev-parse', 'HEAD');
    const event = path.join(root, 'event.json');
    writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head } } }));
    for (const [file, id] of [['ci.yml', 'scope'], ['security.yml', 'changes']]) {
      const job = parse(workflow(file)).jobs[file === 'ci.yml' ? 'changes' : 'scope'];
      const step = job.steps.find(s => s.id === id);
      assert.equal(step.env.BASE_SHA, file === 'ci.yml'
        ? '${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha || github.event.before || github.sha }}'
        : '${{ github.event.pull_request.base.sha || github.event.before || github.sha }}');
      const output = path.join(root, `${id}.out`);
      writeFileSync(output, '');
      execFileSync('bash', ['-e', '-c', step.run], { cwd: root, env: { ...process.env, BASE_SHA: base, RUNNER_TEMP: root, GITHUB_OUTPUT: output, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event } });
      assert.match(readFileSync(output, 'utf8'), /^build=true$/m);
      assert.match(readFileSync(output, 'utf8'), /^dependencies=true$/m);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('release artifacts are selected by the current attempt', () => {
  const jobs = parse(release).jobs;
  const upload = jobs.build.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  const download = jobs.assemble.steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(upload.with.name, 'release-platform-${{ matrix.target }}-${{ github.run_attempt }}');
  assert.equal(download.with.pattern, 'release-platform-*-${{ github.run_attempt }}');
  const recovery = readFileSync(new URL('../../runtime/distribution/README.md', import.meta.url), 'utf8');
  assert.match(recovery, /Do not rerun the assembly job: it signs again/);
  assert.match(recovery, /Retry\s+only the publisher with the original retained signed bundle/);
});

test('dependency review is an unconditional PR high-severity gate and cooldowns match', () => {
  const review = parse(workflow('security.yml')).jobs['dependency-review'];
  assert.equal(review.if, "github.event_name == 'pull_request'");
  assert.equal(review.needs, undefined);
  const step = review.steps.find(s => s.uses?.startsWith('actions/dependency-review-action@'));
  assert.equal(step.with['fail-on-severity'], 'high');
  assert.notEqual(step['continue-on-error'], true);
  assert.notEqual(review['continue-on-error'], true);
  const dependabot = parse(readFileSync(new URL('../../.github/dependabot.yml', import.meta.url), 'utf8'));
  for (const ecosystem of ['cargo', 'npm', 'github-actions']) assert.equal(dependabot.updates.find(update => update['package-ecosystem'] === ecosystem).cooldown['default-days'], 7);
});

test('release checks precede signing and scheduled Node audits enforce failures', () => {
  const doc = parse(release);
  assert.equal(doc.jobs.assemble.permissions.checks, 'read');
  const steps = doc.jobs.assemble.steps;
  const check = steps.findIndex(step => step.run?.endsWith('--verify-source'));
  const sign = steps.findIndex(step => step.run?.includes('cosign sign-blob'));
  assert(check >= 0 && check < sign);
  assert.throws(() => assertReleaseActorCredentials(release.replace('      checks: read\n', ''), 'missing checks permission'));
  assert.throws(() => assertReleaseActorCredentials(release.replace('--verify-source', '--preflight'), 'missing source gate'));
  const security = parse(workflow('security.yml'));
  const audits = Object.values(security.jobs).flatMap(job => job.steps ?? []).filter(step => step.run?.includes('pnpm audit'));
  assert.equal(audits.length, 1);
  assert.equal(audits[0]['continue-on-error'], "${{ github.event_name == 'pull_request' }}");
});
