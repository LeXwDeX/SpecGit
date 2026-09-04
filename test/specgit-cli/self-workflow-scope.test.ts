import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { harnessWorkflowYaml } from '../../src/cli/harness-content.js';

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
  it('classifies the complete checkout with the locked Changesets parser and no lifecycle scripts', () => {
    const all = steps();
    const checkout = all.find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.['fetch-depth']).toBe(0);
    expect(checkout?.with?.['persist-credentials']).toBe(false);
    const classify = all.findIndex((step) => step.id === 'scope');
    expect(classify).toBeGreaterThan(0);
    expect(all[classify]?.run).toBe('node scripts/ci-change-scope.mjs');
    expect(all[classify]?.if).toBeUndefined();
    const install = all.findIndex((step) => step.run?.includes('pnpm install'));
    expect(install).toBeLessThan(classify);
    expect(all[install].run).toContain('--ignore-scripts');
  });

  it('metadata-only changes verify their scope and use only the isolated published CLI', () => {
    const selected = selectedSteps('false');
    const commands = selected.map((step) => step.run ?? '').join('\n');
    expect(commands).toContain('npm install --prefix "$RUNNER_TEMP/specgit-cli" --no-save --ignore-scripts');
    expect(commands).toContain('require(\'./package.json\').version');
    expect(commands).toContain('"$RUNNER_TEMP/specgit-cli/node_modules/.bin/specgit" finish --json');
    expect(commands).not.toMatch(/pnpm run build|node bin\/specgit\.js/);
    expect(commands).toContain('pnpm install --frozen-lockfile --ignore-scripts');
    expect(commands).toContain('node "$SPECGIT_POLICY_ENTRY"');
  });

  it('product changes install and build the CLI under review', () => {
    const commands = selectedSteps('true').map((step) => step.run ?? '').join('\n');
    expect(commands).toContain('pnpm install --frozen-lockfile');
    expect(commands).toContain('pnpm run build');
    expect(commands).toContain('node bin/specgit.js finish --json');
    expect(commands).not.toContain('npm install --prefix');
    expect(commands).not.toContain('--assert-metadata');
  });

  it('an absent classification cannot select either verdict path', () => {
    const selected = selectedSteps('');
    expect(selected.filter((step) => step.run?.includes('finish --json'))).toEqual([]);
    const validation = selected.find((step) => step.name === 'Validate CI scope');
    expect(validation?.env?.CI_BUILD).toBe('${{ steps.scope.outputs.build }}');
    expect(validation?.run).toBe('test "$CI_BUILD" = true || test "$CI_BUILD" = false');
    for (const step of steps().filter((candidate) => candidate.run?.includes('finish --json'))) {
      expect(step.if).toMatch(/^steps\.scope\.outputs\.build == '(?:true|false)'$/);
      expect(step.env?.GH_TOKEN).toBe('${{ github.token }}');
    }
  });

  it('both paths wait on exact-head evidence with the matching YAML dependency source', () => {
    const wait = steps().find((step) => step.name === 'Wait for sibling checks');
    expect(wait?.if).toBeUndefined();
    expect(wait?.env?.WAIT_SHA).toBe('${{ github.event.pull_request.head.sha || github.sha }}');
    expect(wait?.env?.SPECGIT_CLI_DIR).toBe("${{ steps.scope.outputs.build == 'false' && format('{0}/specgit-cli', runner.temp) || '' }}");
    expect(wait?.run).toContain("createRequire(process.env.SPECGIT_CLI_DIR + '/node_modules/specgit/package.json')('yaml')");
    expect(wait?.run).toContain("await import('yaml')");
    expect(wait?.run).toContain("'gh',");
    expect(wait?.run).toContain('Waiting for a fresh run after ready for review: ');
  });
});
