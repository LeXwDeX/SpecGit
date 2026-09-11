import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// CI-workflow consistency pin for the #85 repair: the Nix Flake Validation
// job must not depend on the deprecated magic-nix-cache action — its upstream
// FlakeHub registration path fails intermittently from external decay and
// red-noises Nix-touching runs without any product regression (#85, failing
// main run 32313535281).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('CI workflow consistency (#85: deprecated Nix cache path)', () => {
  it('no workflow references the deprecated magic-nix-cache action', () => {
    const workflowsDir = path.join(REPO_ROOT, '.github', 'workflows');
    for (const file of fs.readdirSync(workflowsDir)) {
      if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
      const text = fs.readFileSync(path.join(workflowsDir, file), 'utf-8');
      expect(
        text,
        `${file} must not use DeterminateSystems/magic-nix-cache-action (deprecated; #85)`,
      ).not.toContain('magic-nix-cache');
    }
  });
});


describe('fresh self-hosted runner prerequisites', () => {
  it('bootstraps Security audit Node/npm before pnpm without enabling an unused store cache', () => {
    const workflow = parse(fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/security.yml'), 'utf8'));
    const steps = workflow.jobs.audit.steps as { uses?: string; run?: string; with?: Record<string, unknown> }[];
    const node = steps.findIndex((step) => step.uses?.startsWith('actions/setup-node@'));
    const pnpm = steps.findIndex((step) => step.uses?.startsWith('pnpm/action-setup@'));
    const audits = steps.map((step, index) => ({ step, index })).filter(({ step }) => step.run?.startsWith('pnpm audit'));
    expect(node).toBeGreaterThanOrEqual(0);
    expect(pnpm).toBeGreaterThan(node);
    expect(steps[node].with?.['package-manager-cache']).toBe(false);
    expect(steps[node].with?.cache).toBeUndefined();
    expect(steps[pnpm].with?.cache).not.toBe(true);
    expect(audits.map(({ step }) => step.run)).toEqual(['pnpm audit --prod --audit-level high', 'pnpm audit --audit-level high']);
    expect(audits.every(({ index }) => index > pnpm)).toBe(true);
    const review = workflow.jobs['dependency-review'].steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/dependency-review-action@'));
    expect(review.with['fail-on-severity']).toBe('high');
  });

  it('provides Node and npm before installing pnpm in both product verification jobs', () => {
    const workflow = parse(fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'));
    for (const name of ['test_matrix', 'lint']) {
      const steps = workflow.jobs[name].steps as { uses?: string; with?: Record<string, unknown> }[];
      const node = steps.findIndex((step) => step.uses?.startsWith('actions/setup-node@'));
      const pnpm = steps.findIndex((step) => step.uses?.startsWith('pnpm/action-setup@'));
      expect(node).toBeGreaterThanOrEqual(0);
      expect(pnpm).toBeGreaterThan(node);
      expect(steps[node].with?.cache).toBeUndefined();
      expect(steps[pnpm].with?.cache).toBe(true);
    }
  });
});
