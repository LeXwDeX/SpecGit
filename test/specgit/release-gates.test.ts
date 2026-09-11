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

describe('native release build gates (#514)', () => {
  const raw = readWorkflow('release-prepare.yml');
  const workflow = parse(raw);
  const jobs = Object.values(workflow.jobs) as Array<{ permissions?: Record<string, string>; steps: Array<{ uses?: string; run?: string; with?: Record<string, unknown> }> }>;

  it('requires an explicit stable-version dispatch and performs no publication on pushes', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.on.workflow_dispatch.inputs.release_version).toMatchObject({ required: true, default: '2.0.0' });
    expect(raw).not.toContain('head_commit');
    expect(raw).not.toMatch(/npm publish|changeset publish|gh release (create|edit|upload)|git push|--npm|--github/);
  });

  it('keeps all jobs read-only and checkouts free of persisted credentials', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    for (const job of jobs) {
      expect(job.permissions ?? workflow.permissions).toEqual({ contents: 'read' });
      for (const step of job.steps.filter(step => step.uses?.startsWith('actions/checkout@'))) expect(step.with?.['persist-credentials']).toBe(false);
    }
    expect(raw).not.toContain('RELEASE_BOT_TOKEN');
    expect(raw).not.toContain('NODE_AUTH_TOKEN');
  });

  it('builds exactly the three actually supported targets on owned runners', () => {
    const entries = workflow.jobs.build.strategy.matrix.include;
    expect(entries.map((entry: { target: string }) => entry.target).sort()).toEqual(['aarch64-apple-darwin', 'x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu']);
    expect(entries.every((entry: { os: string[] }) => entry.os.includes('self-hosted'))).toBe(true);
    expect(workflow.jobs.build.strategy['fail-fast']).toBe(false);
    expect(workflow.jobs.assemble['runs-on']).toEqual(['self-hosted', 'Linux', 'X64']);
  });

  it('installs real staged packages and accounts for all installed test executables', () => {
    const steps = workflow.jobs.build.steps as Array<{ name?: string; run?: string; 'timeout-minutes'?: number | string }>;
    const install = steps.findIndex(step => step.run?.includes('node distribution/verify-install.mjs'));
    const profile = steps.findIndex(step => step.run?.includes('node scripts/profile-tests.mjs'));
    expect(install).toBeGreaterThan(-1);
    expect(profile).toBeGreaterThan(install);
    expect(steps[profile]['timeout-minutes']).toBe("${{ matrix.label == 'windows' && 60 || 15 }}");
    expect(steps[profile].run).toContain('/profile.json');
    expect(steps.some(step => step.run?.includes('node distribution/release-version.mjs'))).toBe(true);
  });

  it('aggregates only successful platform jobs and refuses missing or mismatched artifacts', () => {
    expect(workflow.jobs.assemble.needs).toBe('build');
    expect(workflow.jobs.assemble.if).toBeUndefined();
    const steps = workflow.jobs.assemble.steps as Array<{ uses?: string; run?: string; with?: Record<string, unknown> }>;
    expect(steps.find(step => step.uses?.startsWith('actions/download-artifact@'))?.with).toMatchObject({ pattern: 'release-platform-*', 'digest-mismatch': 'error' });
    expect(steps.find(step => step.run?.includes('release-artifacts.mjs'))?.run).toContain('--source "$GITHUB_SHA"');
    expect(steps.find(step => step.uses?.startsWith('actions/upload-artifact@'))?.with).toMatchObject({ name: 'specgit-release-${{ github.sha }}', 'if-no-files-found': 'error' });
  });
});

describe('rc-verify is a safe RC path (#71)', () => {
  const raw = readWorkflow('rc-verify.yml');
  const parsed = parse(raw) as {
    permissions?: Record<string, string>;
    on?: Record<string, unknown>;
    jobs?: Record<
      string,
      { permissions?: Record<string, string>; steps?: Array<{ run?: string; if?: string }> }
    >;
  };

  it('runs through the required CI caller or explicit manual dispatch', () => {
    expect(Object.keys(parsed.on ?? {}).sort()).toEqual(['workflow_call', 'workflow_dispatch']);
    const ci = parse(readWorkflow('ci.yml'));
    expect(ci.jobs.rc_verify.uses).toBe('./.github/workflows/rc-verify.yml');
    expect(ci.jobs.required_verification.needs).toContain('rc_verify');
  });

  it('never publishes: every npm publish is a dry-run over a staged RC version', () => {
    const publishes = (raw.match(/^.*npm publish.*$/gm) ?? []).filter(
      (line) => !line.trim().startsWith('#')
    );
    expect(publishes.length).toBeGreaterThan(0);
    for (const line of publishes) {
      expect(line).toContain('--dry-run');
      expect(line).toContain('--tag rc');
    }
    // The dry-run target is a workspace-only RC version, so it can never
    // collide with (or shadow) a published release.
    expect(raw).toContain('npm pkg set');
    expect(raw).toMatch(/-rc\.\$\{?GITHUB_RUN_ID\}?|-rc\./);
  });

  it('cannot mutate registry, tags, or releases', () => {
    expect(raw).not.toContain('NODE_AUTH_TOKEN');
    expect(raw).not.toContain('changeset publish');
    expect(raw).not.toContain('gh release create');
    expect(raw).not.toMatch(/git push/);
    expect(raw).not.toMatch(/npm (dist-tag|access|owner add|deprecate)/);
  });

  it('proves OIDC provenance with the narrowest permissions', () => {
    const perms = parsed.jobs?.['rc-verify']?.permissions ?? parsed.permissions;
    expect(perms).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(raw).toContain('--provenance');
    expect(raw).toContain('npmjs.org');
  });

  it('skips provenance on forks visibly, never silently', () => {
    const skip = (parsed.jobs?.['rc-verify']?.steps ?? []).find((step) =>
      (step.run ?? '').includes('fork')
    );
    expect(skip).toBeDefined();
    expect(skip?.run).toContain('::warning');
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
