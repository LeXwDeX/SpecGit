import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runVerificationCi, type ReuseCiState } from '../../src/cli/verification-ci.js';
import { ReuseProfileSchema } from '../../src/verification/reuse-profile.js';
import { collectReuseInputs } from '../../src/verification/reuse-inputs.js';
import { fail, ok } from '../../src/kernel/evidence.js';
import { commitFile, git, initRepo, makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(rmDir));
const now = Date.parse('2026-09-08T01:00:00Z');

async function fixture(originalAvailable = true) {
  const dir = makeTempDir('specgit-ci-reuse-'); dirs.push(dir);
  const { root, env } = initRepo(dir);
  const baseSha = git(root, ['rev-parse', 'HEAD'], env).trim();
  const sourceSha = commitFile(root, 'verify.mjs', 'console.log("BUSINESS_EXECUTED");', env);
  const profile = ReuseProfileSchema.parse({ id: 'linux', check: 'Test', max_age_seconds: 3600,
    node: '20.19.0', pnpm: '9.15.9', runtime: { package: 'specgit@1.15.1', lockfile: 'ci/runtime-lock.json' },
    commands: [['node', 'verify.mjs']], fresh_commands: [['node', '-e', 'console.log("CURRENT_EXECUTED")']],
    github: { runner: 'ubuntu-24.04', entry: '.github/workflows/reuse.yml' },
  });
  const inputs = await collectReuseInputs(root, { sourceSha, checkoutSha: sourceSha, baseSha, policySha: baseSha,
    recipeDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64) });
  if (!inputs.ok) throw new Error('Expected inputs');
  const repository = 'github.com/owner/project';
  const ref = { repository, run: '10', attempt: 1, job: '20' };
  const state: ReuseCiState = { root, profile, checkoutSha: sourceSha, platform: 'github', repository,
    run: '11', attempt: 1, context: ok({ repository, profile: { id: profile.id, maxAgeSeconds: profile.max_age_seconds }, inputs: inputs.value }),
    executions: {
      candidates: async () => ok([ref]),
      original: async () => originalAvailable ? ok({ ref, profile: 'linux', sourceSha, recipeDigest: inputs.value.recipeDigest,
        inputDigest: inputs.value.digest, completedAt: new Date(now - 60_000).toISOString() }) : fail('not_found', 'Original removed'),
    },
  };
  const output: string[] = [];
  const options = { cwd: root, readState: async () => state, now: () => now,
    env: { ...process.env, GITHUB_RUN_ID: '11', GITHUB_RUN_ATTEMPT: '1' }, log: (text: string) => output.push(text) };
  return { state, options, output, root, ref };
}

describe('CI verification execution and reuse entry point', () => {
  it('removes the downloaded GitLab parent assertion before business and current commands', async () => {
    const { options, state, root, output } = await fixture(false);
    state.platform = 'gitlab';
    state.profile.gitlab = { image: 'node@sha256:' + 'a'.repeat(64), entry: '.gitlab-ci.yml', tags: [], bootstrap: [] };
    const assertion = path.join(root, '.specgit-reuse/identity.json');
    state.profile.fresh_commands = [['node', '-e', `if (require('node:fs').existsSync(${JSON.stringify(assertion)})) process.exit(7); console.log('IDENTITY_ABSENT');`]];
    const env = { ...options.env, CI_JOB_ID: '77', SPECGIT_REUSE_IDENTITY: 'deterministic-test-assertion' };
    expect((await runVerificationCi('prepare', 'linux', { ...options, env })).ok).toBe(true);
    expect(fs.existsSync(assertion)).toBe(true);
    expect((await runVerificationCi('execute', 'linux', { ...options, env })).ok).toBe(true);
    expect(fs.existsSync(assertion)).toBe(false);
    expect(output.join('')).toContain('IDENTITY_ABSENT');
    expect(fs.existsSync(path.join(root, '.specgit-reuse/parent.json'))).toBe(true);
  });

  it('plans reuse, rechecks the original, and still executes current delivery checks', async () => {
    const { options, output } = await fixture();
    expect(await runVerificationCi('prepare', 'linux', options)).toMatchObject({ ok: true, value: { mode: 'reuse' } });
    expect(await runVerificationCi('reuse', 'linux', options)).toMatchObject({ ok: true, value: { mode: 'reused' } });
    expect(output.join('')).not.toContain('BUSINESS_EXECUTED');
    expect(output.join('')).toContain('CURRENT_EXECUTED');
  });

  it('executes the real commands when no original can be verified', async () => {
    const { options, output } = await fixture(false);
    expect(await runVerificationCi('prepare', 'linux', options)).toMatchObject({ ok: true, value: { mode: 'execute' } });
    expect(await runVerificationCi('execute', 'linux', options)).toMatchObject({ ok: true, value: { mode: 'executed' } });
    expect(output.join('')).toContain('BUSINESS_EXECUTED');
    expect(output.join('')).toContain('CURRENT_EXECUTED');
  });

  it('falls back to actual execution if original evidence disappears after planning', async () => {
    const { options, output, state } = await fixture();
    await runVerificationCi('prepare', 'linux', options);
    state.executions.original = async () => fail('not_found', 'Removed');
    expect(await runVerificationCi('reuse', 'linux', options)).toMatchObject({ ok: true, value: { mode: 'executed' } });
    expect(output.join('')).toContain('BUSINESS_EXECUTED');
  });

  it('never accepts a current-check failure after a reuse hit', async () => {
    const { options, state } = await fixture();
    state.profile.fresh_commands = [['node', '-e', 'process.exit(7)']];
    await runVerificationCi('prepare', 'linux', options);
    expect((await runVerificationCi('reuse', 'linux', options)).ok).toBe(false);
  });

  it('runs normally when reuse has not been approved and cannot emit an original identity', async () => {
    const { options, state, output, root } = await fixture();
    state.context = fail('reuse_not_approved', 'Candidate policy is not approved');
    await runVerificationCi('prepare', 'linux', options);
    const plan = JSON.parse(fs.readFileSync(path.join(root, '.specgit-reuse/plan.json'), 'utf8'));
    expect(plan.jobName).toBe('SpecGit uncached / linux');
    expect((await runVerificationCi('execute', 'linux', options)).ok).toBe(true);
    expect(output.join('')).toContain('BUSINESS_EXECUTED');
  });

  it('rejects a changed head or policy between preparation and execution', async () => {
    const { options, state, output } = await fixture(false);
    await runVerificationCi('prepare', 'linux', options);
    if (!state.context.ok) throw new Error('Expected context');
    state.context.value.inputs.policySha = 'c'.repeat(40);
    expect((await runVerificationCi('execute', 'linux', options)).ok).toBe(false);
    expect(output.join('')).not.toContain('BUSINESS_EXECUTED');
  });

  it('uses approved applicability and still runs current checks without creating original evidence', async () => {
    const { options, state, output, root } = await fixture(false);
    state.applicable = false;
    expect(await runVerificationCi('prepare', 'linux', options)).toMatchObject({ ok: true, value: { reason: 'check_not_applicable' } });
    const plan = JSON.parse(fs.readFileSync(path.join(root, '.specgit-reuse/plan.json'), 'utf8'));
    expect(plan.jobName).toBe('SpecGit not applicable / linux');
    expect(await runVerificationCi('execute', 'linux', options)).toMatchObject({ ok: true, value: { mode: 'not_applicable' } });
    expect(output.join('')).not.toContain('BUSINESS_EXECUTED');
    expect(output.join('')).toContain('CURRENT_EXECUTED');
  });

  it('rejects changed applicability before skipping work', async () => {
    const { options, state, output } = await fixture(false);
    state.applicable = false;
    await runVerificationCi('prepare', 'linux', options);
    state.applicable = true;
    expect((await runVerificationCi('execute', 'linux', options)).ok).toBe(false);
    expect(output.join('')).not.toContain('CURRENT_EXECUTED');
  });

  it('rejects a tampered plan instead of running a different recipe', async () => {
    const { options, root } = await fixture();
    await runVerificationCi('prepare', 'linux', options);
    const file = path.join(root, '.specgit-reuse/plan.json');
    const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
    plan.profile = 'other';
    fs.writeFileSync(file, JSON.stringify(plan));
    expect((await runVerificationCi('reuse', 'linux', options)).ok).toBe(false);
  });
});
