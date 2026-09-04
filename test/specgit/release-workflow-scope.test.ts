import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

interface Workflow {
  on: { workflow_dispatch?: { inputs?: Record<string, { required?: boolean }> } };
  jobs: Record<string, {
    needs?: string;
    if?: string;
    permissions?: Record<string, string>;
    outputs?: Record<string, string>;
    steps: Array<{ id?: string; run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, unknown> }>;
  }>;
}

const workflow = (name: string): Workflow => parse(readFileSync(
  fileURLToPath(new URL(`../../.github/workflows/${name}.yml`, import.meta.url)), 'utf8'
)) as Workflow;

describe('release and dependency workflow scope (#423)', () => {
  it('resolves release intent before lifecycle builds or registry writes', () => {
    const release = workflow('release-prepare');
    const scope = release.jobs.scope;
    expect(scope).toBeDefined();
    expect(scope.permissions).toEqual({ contents: 'read' });
    expect(scope.steps.some((step) => step.run === 'node scripts/ci-change-scope.mjs')).toBe(true);
    expect(scope.steps.some((step) => step.run === 'node scripts/release-state.mjs --plan')).toBe(true);
    expect(scope.steps.find((step) => step.uses?.startsWith('actions/checkout@'))?.with?.['fetch-depth']).toBe(0);
    for (const step of scope.steps) {
      if (step.run?.includes('pnpm install')) expect(step.run).toContain('--ignore-scripts');
      expect(step.run ?? '').not.toMatch(/npm publish|run build/);
    }
    expect(release.jobs.release.needs).toBe('scope');
    expect(release.jobs.release.if).toContain("needs.scope.outputs.eligible == 'true'");
    expect(release.jobs.release.if).toContain("github.ref == 'refs/heads/main'");
    expect(release.on.workflow_dispatch?.inputs?.release_version?.required).toBe(false);
    const plan = scope.steps.find((step) => step.run === 'node scripts/release-state.mjs --plan');
    expect(plan?.env?.SPECGIT_RELEASE_VERSION).toBe('${{ inputs.release_version }}');
    expect(plan?.env?.SPECGIT_RELEASE_INTENT).toBe('${{ steps.changes.outputs.release_intent }}');
  });

  it('audits dependencies only for dependency changes or explicit scheduled/manual checks', () => {
    const security = workflow('security');
    const scope = security.jobs.scope;
    expect(scope).toBeDefined();
    expect(scope.steps.some((step) => step.run === 'node scripts/ci-change-scope.mjs')).toBe(true);
    expect(security.jobs.audit.needs).toBe('scope');
    expect(security.jobs.audit.if).toContain("needs.scope.outputs.dependencies == 'true'");
    expect(security.jobs.audit.if).toContain("github.event_name == 'schedule'");
    expect(security.jobs.audit.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(security.jobs['dependency-review'].needs).toBe('scope');
    expect(security.jobs['dependency-review'].if).toContain("needs.scope.outputs.dependencies == 'true'");
    expect(Object.values(security.jobs).flatMap((job) => job.steps).map((step) => step.run ?? '').join('\n'))
      .not.toMatch(/run build|npm publish/);
    for (const step of scope.steps) {
      if (step.run?.includes('pnpm install')) expect(step.run).toContain('--ignore-scripts');
    }
  });

  it('fails closed when dependency classification is missing or malformed', () => {
    const scope = workflow('security').jobs.scope;
    const guard = scope.steps.find((step) => step.env?.DEPENDENCIES !== undefined);
    expect(guard?.env?.DEPENDENCIES).toBe('${{ steps.changes.outputs.dependencies }}');
    const source = guard?.run?.match(/^node -e "(.*)"$/)?.[1];
    expect(source).toBeDefined();
    for (const value of ['', 'TRUE', '0', 'undefined', 'true', 'false']) {
      const result = spawnSync(process.execPath, ['-e', source ?? ''], {
        env: { ...process.env, DEPENDENCIES: value }, encoding: 'utf8',
      });
      expect(result.status, value).toBe(value === 'true' || value === 'false' ? 0 : 1);
    }
  });
});
