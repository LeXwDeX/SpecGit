import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

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
