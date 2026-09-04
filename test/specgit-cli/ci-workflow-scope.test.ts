import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parse } from 'yaml';

interface Step { name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, string>; 'continue-on-error'?: unknown }
interface Job { name?: string; needs?: string | string[]; if?: string; uses?: string; steps?: Step[]; 'continue-on-error'?: unknown; strategy?: { 'fail-fast'?: boolean; matrix?: { include?: Array<{ label: string }> } } }
interface Workflow { on: Record<string, { paths?: string[]; 'paths-ignore'?: string[] } | null>; jobs: Record<string, Job> }
const root = path.resolve(__dirname, '../..');
const read = (name: string): Workflow => parse(readFileSync(path.join(root, '.github/workflows', name), 'utf8')) as Workflow;
const ci = read('ci.yml');
const rc = read('rc-verify.yml');

function applies(job: Job, build: boolean) {
  if (!job.if) return true;
  return Boolean(new Function('needs', `return (${job.if});`)({ changes: { outputs: { build: String(build) } } }));
}
function runSummary(overrides: Record<string, string> = {}, build = false, nix = false) {
  const step = ci.jobs.required_verification.steps![0];
  const script = step.run!.replace(/^node --input-type=module <<'NODE'\n/, '').replace(/\nNODE\s*$/, '');
  const product = build ? 'success' : 'skipped';
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', env: { ...process.env, CLASSIFIER_RESULT: 'success', METADATA_RESULT: 'success',
      BUILD_REQUIRED: String(build), NIX_REQUIRED: String(nix), MATRIX_RESULT: product, LINT_RESULT: product,
      RC_RESULT: product, NIX_RESULT: nix ? 'success' : 'skipped', ...overrides },
  });
}
function assertNoProductBuild(steps: Step[]) {
  for (const step of steps) {
    const command = step.run ?? '';
    expect(command).not.toMatch(/pnpm (?:run build|test|lint|exec tsc)|npm (?:pack|publish)|check:pack-version/);
    if (/\b(?:pnpm|npm) install\b/.test(command)) expect(command).toContain('--ignore-scripts');
  }
}

describe('CI applicability and real verification', () => {
  it('keeps an always-run accurately named required check without path-filter pending traps', () => {
    expect(ci.on.pull_request).toBeDefined();
    expect(ci.on.pull_request?.paths).toBeUndefined();
    expect(ci.on.pull_request?.['paths-ignore']).toBeUndefined();
    expect(ci.jobs.required_verification.name).toBe('Required verification');
    expect(ci.jobs.required_verification.if).toBe('always()');
    expect(ci.jobs.required_verification.needs).toEqual(expect.arrayContaining(['changes', 'metadata', 'test_matrix', 'lint', 'rc_verify', 'nix-flake-validate']));
    expect(ci.jobs.required_verification.needs).not.toContain('specgit-acceptance');
  });

  it.each(['test_matrix', 'lint', 'rc_verify'])('%s runs for product changes and is explicitly skipped for metadata', (id) => {
    expect(applies(ci.jobs[id], false)).toBe(false);
    expect(applies(ci.jobs[id], true)).toBe(true);
  });

  it('preserves every old required product check as actual work with no tolerated failures', () => {
    const matrix = ci.jobs.test_matrix;
    expect(matrix.name).toBe('Test (${{ matrix.label }})');
    expect(matrix.strategy?.matrix?.include?.map((leg) => leg.label)).toEqual(['linux-bash', 'macos-bash', 'windows-pwsh']);
    expect(matrix.strategy?.['fail-fast']).toBe(false);
    expect(ci.jobs.lint.name).toBe('Lint & Type Check');
    const commands = (job: Job) => (job.steps ?? []).map((step) => step.run);
    expect(commands(matrix)).toContain('pnpm test');
    expect(commands(matrix)).toContain('pnpm run build');
    expect(commands(ci.jobs.lint)).toEqual(expect.arrayContaining(['pnpm exec tsc --noEmit', 'pnpm run typecheck:test', 'pnpm lint']));
    for (const job of [matrix, ci.jobs.lint, ci.jobs.changes, ci.jobs.metadata, rc.jobs['rc-verify']]) {
      expect(job['continue-on-error']).toBeUndefined();
      for (const step of job.steps ?? []) expect(step['continue-on-error']).toBeUndefined();
    }
  });

  it('metadata runs real content contracts and installs dependencies without lifecycle builds', () => {
    expect(ci.jobs.metadata.if).toBeUndefined();
    expect(ci.jobs.metadata.needs).toBe('changes');
    expect(ci.jobs.metadata.steps!.some((step) => step.run === 'node scripts/ci-metadata-check.mjs')).toBe(true);
    for (const id of ['changes', 'metadata']) assertNoProductBuild(ci.jobs[id].steps!);
    const config = readFileSync(path.join(root, 'scripts/vitest.metadata.config.mjs'), 'utf8');
    expect(config).not.toMatch(/globalSetup\s*:/);
    expect(config).toContain('metadata-content.test.ts');
    expect(config).toContain('contract.test.ts');
  });

  it('RC is awaited through a reusable workflow and keeps explicit manual verification', () => {
    expect(ci.jobs.rc_verify.uses).toBe('./.github/workflows/rc-verify.yml');
    expect(rc.on).toHaveProperty('workflow_call');
    expect(rc.on).toHaveProperty('workflow_dispatch');
    expect(rc.on).not.toHaveProperty('pull_request');
    expect(rc.jobs['rc-verify'].steps!.some((step) => step.run === 'pnpm run check:pack-version')).toBe(true);
  });

  it.each([false, true])('accepts exactly the applicable passing results (build=%s)', (build) => {
    expect(runSummary({}, build).status).toBe(0);
  });

  it.each(['CLASSIFIER_RESULT', 'METADATA_RESULT'])('never hides a failed, skipped or cancelled %s', (key) => {
    for (const value of ['', 'failure', 'skipped', 'cancelled']) expect(runSummary({ [key]: value }).status).toBe(1);
  });

  it.each(['MATRIX_RESULT', 'LINT_RESULT', 'RC_RESULT'])('rejects incomplete product evidence in %s', (key) => {
    for (const value of ['', 'failure', 'skipped', 'cancelled']) expect(runSummary({ [key]: value }, true).status).toBe(1);
    expect(runSummary({ [key]: 'success' }, false).status).toBe(1);
  });

  it('only permits Nix to skip when the complete classification says it is inapplicable', () => {
    expect(runSummary({}, true, true).status).toBe(0);
    expect(runSummary({ NIX_RESULT: 'skipped' }, true, true).status).toBe(1);
    expect(runSummary({}, false, true).status).toBe(1);
    expect(runSummary({ BUILD_REQUIRED: '' }).status).toBe(1);
  });

  it.each(['BUILD_REQUIRED', 'NIX_REQUIRED'])('rejects unknown applicability in %s rather than accepting a skip', (key) => {
    for (const value of ['', 'TRUE', '0', 'undefined']) expect(runSummary({ [key]: value }).status).toBe(1);
  });
});
