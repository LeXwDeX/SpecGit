import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { harnessWorkflowYaml, selfAcceptanceJobYaml } from '../../src/cli/harness-content.js';

interface Step {
  name: string;
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}

const steps = (): Step[] => (parse(harnessWorkflowYaml()) as {
  jobs: { 'specgit-acceptance': { steps: Step[] } };
}).jobs['specgit-acceptance'].steps;

const selectedSteps = (build: 'true' | 'false' | ''): Step[] => steps().filter((step) => {
  if (step.if === undefined) return true;
  // These scope scenarios model pull_request runs; branch restoration is
  // unconditional for that event and is exercised with real git separately.
  if (step.if === "github.event_name == 'pull_request' || github.ref_type == 'branch'") return true;
  if (step.if === "steps.scope.outputs.build == 'true'") return build === 'true';
  if (step.if === "steps.scope.outputs.build == 'false'") return build === 'false';
  throw new Error(`Unverified workflow condition: ${step.if}`);
});

describe('self acceptance CI scope', () => {
  it('reads the trusted pnpm manifest before isolation using the action workspace-relative path contract', () => {
    const root = mkdtempSync(join(tmpdir(), 'specgit-engineering-pnpm-'));
    try {
      const selected = selectedSteps('false');
      const setupIndex = selected.findIndex((step) => step.name === 'Setup engineering pnpm');
      const checkoutIndex = selected.findIndex((step) => step.name === 'Checkout trusted engineering source for metadata validation');
      const isolateIndex = selected.findIndex((step) => step.name === 'Isolate trusted engineering source');
      expect(setupIndex).toBeGreaterThan(checkoutIndex);
      expect(setupIndex).toBeLessThan(isolateIndex);
      mkdirSync(join(root, '.specgit-engineering'));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@1.0.0' }));
      writeFileSync(join(root, '.specgit-engineering', 'package.json'), JSON.stringify({ packageManager: 'pnpm@9.15.9' }));
      const manifest = selected[setupIndex].with?.package_json_file;
      expect(typeof manifest).toBe('string');
      // The pinned action joins its input to GITHUB_WORKSPACE, including absolute inputs.
      const observed = JSON.parse(readFileSync(join(root, String(manifest)), 'utf8'));
      expect(observed.packageManager).toBe('pnpm@9.15.9');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses existing engineering destinations before any subsequent build can execute', () => {
    const root = mkdtempSync(join(tmpdir(), 'specgit-engineering-isolation-'));
    try {
      const script = steps().find((step) => step.name === 'Isolate trusted engineering source')?.run;
      expect(script).toBeDefined();
      for (const kind of ['directory', 'dangling-symlink', 'fresh']) {
        const checkout = join(root, kind, 'checkout');
        const runner = join(root, kind, 'runner');
        const source = join(checkout, '.specgit-engineering');
        const destination = join(runner, 'specgit-cli');
        mkdirSync(source, { recursive: true });
        mkdirSync(runner, { recursive: true });
        writeFileSync(join(source, 'source-marker'), 'new');
        if (kind === 'directory') {
          mkdirSync(destination);
          writeFileSync(join(destination, 'source-marker'), 'old');
        } else if (kind === 'dangling-symlink') {
          symlinkSync(join(runner, 'missing'), destination, 'junction');
        }
        const result = spawnSync('bash', ['-e', '-c', `${script}\nprintf executed > "$RUNNER_TEMP/executed"`], {
          cwd: checkout, env: { ...process.env, RUNNER_TEMP: runner.replace(/\\/g, '/') }, encoding: 'utf8',
        });
        expect(result.error).toBeUndefined();
        if (kind === 'fresh') {
          expect(result.status).toBe(0);
          expect(readFileSync(join(destination, 'source-marker'), 'utf8')).toBe('new');
          expect(existsSync(source)).toBe(false);
          expect(existsSync(join(runner, 'executed'))).toBe(true);
        } else {
          expect(result.status).toBe(1);
          expect(result.stderr).toContain('destination already exists');
          expect(readFileSync(join(source, 'source-marker'), 'utf8')).toBe('new');
          expect(existsSync(join(runner, 'executed'))).toBe(false);
          expect(existsSync(join(destination, '.specgit-engineering'))).toBe(false);
          if (kind === 'directory') expect(readFileSync(join(destination, 'source-marker'), 'utf8')).toBe('old');
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('classifies the complete checkout before installing the product toolchain', () => {
    const all = steps();
    const checkout = all.find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.['fetch-depth']).toBe(0);
    expect(checkout?.with?.['persist-credentials']).toBe(false);
    const classify = all.findIndex((step) => step.id === 'scope');
    expect(classify).toBeGreaterThan(0);
    expect(all[classify]?.run).toBe('node scripts/ci-change-scope.mjs --verification-only');
    expect(all[classify]?.if).toBeUndefined();
    const install = all.findIndex((step) => step.run?.includes('pnpm install'));
    expect(install).toBeGreaterThan(classify);
    expect(all[install].if).toBe("steps.scope.outputs.build == 'true'");
    expect(all[install].run).toContain('--ignore-scripts');
  });

  it('metadata-only changes use isolated trusted engineering source independently of public v2', () => {
    const selected = selectedSteps('false');
    const commands = selected.map((step) => step.run ?? '').join('\n');
    expect(commands).toContain('node build.js');
    const trusted = selected.find((step) => step.name === 'Checkout trusted engineering source for metadata validation');
    expect(trusted?.with?.ref).toBe('${{ github.event.repository.default_branch }}');
    expect(trusted?.with?.['persist-credentials']).toBe(false);
    expect(commands).not.toMatch(/(?:^|\n)\s*npm install/);
    expect(commands).toContain('await acceptanceMain()');
    expect(commands).not.toMatch(/pnpm run build|node bin\/specgit\.js/);
    expect(selected.find((step) => step.name === 'specgit finish with trusted CLI')?.env?.SPECGIT_ACCEPT_RUNTIME).toBe('${{ runner.temp }}/specgit-cli');
    expect(commands).toContain('pnpm install --frozen-lockfile --ignore-scripts');
    expect(selected.some((step) => step.uses?.startsWith('pnpm/action-setup@'))).toBe(true);
    expect(commands).toContain('node "$SPECGIT_POLICY_ENTRY"');
  });

  it('product changes install and build the CLI under review', () => {
    const commands = selectedSteps('true').map((step) => step.run ?? '').join('\n');
    expect(commands).toContain('pnpm install --frozen-lockfile');
    expect(commands).toContain('pnpm run build');
    expect(commands).toContain('await acceptanceMain()');
    expect(commands).not.toContain('npm install --prefix');
    expect(commands).not.toContain('--assert-metadata');
  });

  it('an absent classification cannot select either verdict path', () => {
    const selected = selectedSteps('');
    expect(selected.filter((step) => step.run?.includes('await acceptanceMain()'))).toEqual([]);
    const validation = selected.find((step) => step.name === 'Validate CI scope');
    expect(validation?.env?.CI_BUILD).toBe('${{ steps.scope.outputs.build }}');
    expect(validation?.run).toBe('test "$CI_BUILD" = true || test "$CI_BUILD" = false');
    for (const step of steps().filter((candidate) => candidate.run?.includes('await acceptanceMain()'))) {
      expect(step.if).toMatch(/^steps\.scope\.outputs\.build == '(?:true|false)'$/);
      expect(step.env?.GH_TOKEN).toBe('${{ github.token }}');
    }
  });

  it('orders both verdict paths after verification without waiting on the occupied runner', () => {
    const job = parse(selfAcceptanceJobYaml(true))['specgit-acceptance'];
    expect(job.needs).toBe('required_verification');
    expect(steps().some((step) => step.name === 'Wait for sibling checks')).toBe(false);
    const checkout = job.steps.find((step: Step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout.with.ref).toBe('${{ github.event.pull_request.head.sha || github.sha }}');
    const policy = steps().find((step) => step.name === 'Prepare approved policy for acceptance');
    expect(policy?.env?.SPECGIT_POLICY_ENTRY).toContain("steps.scope.outputs.build == 'false'");
    expect(policy?.run).toContain('node "$SPECGIT_POLICY_ENTRY"');
  });
});
