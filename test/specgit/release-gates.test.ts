import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { GUARD_SCRIPT, mergeHooksJson } from '../../src/cli/harness-content.js';

/**
 * #71 + #68 workflow wiring locks. YAML has no unit-test seam, so the
 * falsifier medium here is content: the invariants that make the release
 * gates safe are asserted directly against the workflow files (and the
 * regenerated guard wiring), the same way init.test.ts byte-locks the
 * harness workflow template.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function readWorkflow(name: string): string {
  return fs.readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf8');
}

describe('native GitHub release workflow (#559)', () => {
  const raw = readWorkflow('release-prepare.yml');
  const workflow = parse(raw);

  it('publishes only after explicit main-branch release intent', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.on.workflow_dispatch.inputs.release_version).toMatchObject({ required: true, default: '2.0.0' });
    expect(workflow.jobs.build.if).toBe("github.repository == 'LeXwDeX/SpecGit' && github.ref == 'refs/heads/main'");
    expect(raw).not.toMatch(/npm publish|changeset publish|git push|--npm/);
  });

  it('keeps builds read-only and gives only the final publication job write permission', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.build.permissions ?? workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.assemble.permissions).toEqual({ contents: 'write', actions: 'read' });
    for (const job of Object.values(workflow.jobs) as Array<{ steps: Array<{ uses?: string; with?: Record<string, unknown> }> }>) {
      for (const step of job.steps.filter(step => step.uses?.startsWith('actions/checkout@'))) expect(step.with?.['persist-credentials']).toBe(false);
    }
    expect(raw).not.toContain('RELEASE_BOT_TOKEN');
    expect(raw).not.toContain('NODE_AUTH_TOKEN');
  });

  it('compiles and smoke-tests exactly three native targets without npm qualification', () => {
    const entries = workflow.jobs.build.strategy.matrix.include;
    expect(entries.map((entry: { target: string }) => entry.target).sort()).toEqual(['aarch64-apple-darwin', 'x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu']);
    expect(entries.every((entry: { os: string[] }) => entry.os.includes('self-hosted'))).toBe(true);
    expect(workflow.jobs.build.strategy['fail-fast']).toBe(false);
    expect(raw).toContain('native-release.mjs --build');
    expect(raw).not.toMatch(/native-resume|profile-tests|verify-install|npm pack/);
  });

  it('publishes the assembled bytes only after all build jobs succeed', () => {
    expect(workflow.jobs.assemble.needs).toBe('build');
    expect(workflow.jobs.assemble.if).toBeUndefined();
    expect(workflow.jobs.assemble['runs-on']).toEqual(['self-hosted', 'Linux', 'X64']);
    const steps = workflow.jobs.assemble.steps as Array<{ uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }>;
    expect(steps.find(step => step.uses?.startsWith('actions/download-artifact@'))?.with).toMatchObject({ pattern: 'release-platform-*', 'digest-mismatch': 'error' });
    expect(steps.find(step => step.uses?.startsWith('actions/upload-artifact@'))?.with?.name).toBe('specgit-release-${{ github.sha }}-${{ github.run_attempt }}');
    const assemble = steps.findIndex(step => step.run?.includes('native-release.mjs --assemble'));
    const publish = steps.findIndex(step => step.run?.includes('distribution/publish.mjs'));
    expect(assemble).toBeGreaterThan(-1);
    expect(publish).toBeGreaterThan(assemble);
    expect(steps[publish].run).toContain('--source "$GITHUB_SHA" --build-run "$GITHUB_RUN_ID" --github');
    expect(steps[publish].env?.GH_TOKEN).toBe('${{ github.token }}');
  });
});

describe('offline engineering package verification', () => {
  const raw = readWorkflow('rc-verify.yml');
  const workflow = parse(raw);
  it('retains the existing required package check without registry or publishing access', () => {
    const ci = parse(readWorkflow('ci.yml'));
    expect(ci.jobs.rc_verify.uses).toBe('./.github/workflows/rc-verify.yml');
    expect(ci.jobs.required_verification.needs).toContain('rc_verify');
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(raw).toContain('check:pack-version');
    expect(raw).toContain('npm pack --json --silent --ignore-scripts');
    expect(raw).not.toMatch(/npm (publish|view|dist-tag)|ACTIONS_ID_TOKEN_REQUEST|id-token:|NODE_AUTH_TOKEN/);
  });
});

describe('guard wiring (#68)', () => {
  it('the hook runner budget is not shorter than the configured gh timeout', () => {
    const hooksJson = JSON.parse(
      fs.readFileSync(path.join(ROOT, '.opencode', 'hooks.json'), 'utf8')
    ) as { PreToolUse?: Array<{ hooks?: Array<{ timeout?: number }> }> };
    const timeouts = (hooksJson.PreToolUse ?? []).flatMap((entry) =>
      (entry.hooks ?? []).map((hook) => hook.timeout)
    );
    expect(timeouts.length).toBeGreaterThan(0);
    for (const timeout of timeouts) {
      // Default gh budget is 15s per call and the verdict makes several
      // calls: the runner must outlive at least one full gh budget.
      expect(timeout).toBeGreaterThanOrEqual(60);
    }
  });

  it('the checked-in guard is exactly the managed template', () => {
    // Windows checkouts may convert LF to CRLF; normalize before locking.
    const checkedIn = fs
      .readFileSync(path.join(ROOT, '.opencode', 'hooks', 'specgit-merge-guard.sh'), 'utf8')
      .replace(/\r\n/g, '\n');
    expect(checkedIn).toBe(GUARD_SCRIPT);
  });

  it('the checked-in hooks.json is exactly a fresh template install', () => {
    const checkedIn = fs
      .readFileSync(path.join(ROOT, '.opencode', 'hooks.json'), 'utf8')
      .replace(/\r\n/g, '\n');
    expect(checkedIn).toBe(mergeHooksJson(null).json);
  });
});
