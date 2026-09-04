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

describe('release-prepare gates (#71)', () => {
  const raw = readWorkflow('release-prepare.yml');
  const parsed = parse(raw) as {
    on?: Record<string, unknown>;
    jobs?: Record<
      string,
      {
        if?: string;
        steps?: Array<{
          name?: string;
          id?: string;
          if?: string;
          run?: string;
          env?: Record<string, string>;
        }>;
      }
    >;
  };

  it('publishes only on push to main or a manual retry, with explicit provenance', () => {
    expect(Object.keys(parsed.on ?? {}).sort()).toEqual(['push', 'workflow_dispatch']);
    const publish = raw.match(/^.*npm publish.*$/gm) ?? [];
    expect(publish.length).toBeGreaterThan(0);
    for (const line of publish) {
      expect(line).toContain('--provenance');
      expect(line).not.toContain('--dry-run');
    }
  });

  it('refuses release dispatches from unmerged branches or tags (#411)', () => {
    expect(parsed.jobs?.scope?.if).toBe("github.repository == 'LeXwDeX/SpecGit' && github.ref == 'refs/heads/main'");
    expect(parsed.jobs?.release?.if).toBe("github.repository == 'LeXwDeX/SpecGit' && github.ref == 'refs/heads/main' && needs.scope.outputs.eligible == 'true'");
  });

  it('gates publish on an unpublished version, never on the head commit message (#227)', () => {
    // A merge-commit merge strategy makes the head commit message "Merge
    // pull request #N...", so a publish gated on startsWith(...,
    // 'chore(release): v') can never fire — and workflow_dispatch has no
    // head_commit at all. The gate is the registry/tag evidence instead.
    expect(raw).not.toContain('head_commit');
    const steps = parsed.jobs?.release?.steps ?? [];
    const probe = steps.find((step) => step.id === 'unpublished');
    expect(probe).toBeDefined();
    expect(probe?.if).toBe("steps.pending.outputs.count == '0'");
    expect(probe?.run).toBe('node scripts/release-state.mjs');
    for (const name of ['Build', 'Publish to npm']) {
      const step = steps.find((candidate) => candidate.name === name);
      expect(step, name).toBeDefined();
      expect(step?.if, name).toBe("steps.unpublished.outputs.needs_publish == 'true'");
    }
    const finalize = steps.find((step) => step.name === 'Tag and create GitHub Release');
    expect(finalize?.if).toBe("steps.unpublished.outputs.needs_finalize == 'true'");
    expect(finalize?.run).toBe('node scripts/release-state.mjs --finalize');
  });

  it('pushes the version branch with a write-access token when configured', () => {
    // PR #61 root cause: a head pushed by github-actions[bot] leaves the
    // pull_request runs action_required with zero jobs. The workflow must
    // be able to push as an actor whose events run without approval.
    expect(raw).toContain('RELEASE_BOT_TOKEN');
  });

  it('fails loudly when version-PR workflows are action_required', () => {
    const watchdog = (parsed.jobs?.release?.steps ?? []).find((step) =>
      (step.run ?? '').includes('action_required')
    );
    expect(watchdog).toBeDefined();
    expect(watchdog?.run).toContain('::error');
  });

  it('the watchdog decides from workflow runs, never check-runs (#265)', () => {
    // Approval-waiting runs complete as action_required with ZERO jobs:
    // they never create check-runs, so a check-runs poll sees only the
    // independently triggered runs and reports started while the version
    // PR blocks silently (observed live during the v1.4.0 cut). The
    // evidence source must cover exactly the failure mode it names.
    const watchdog = (parsed.jobs?.release?.steps ?? []).find((step) =>
      (step.run ?? '').includes('action_required')
    );
    expect(watchdog).toBeDefined();
    expect(watchdog?.run).toContain('actions/runs');
    expect(watchdog?.run).not.toContain('check-runs');
    // The error text names the recovery: the approve API.
    expect(watchdog?.run).toMatch(/runs\/\$\{?[A-Za-z_]+\}?\/approve|approve/);
  });

  it('supersedes an existing version PR explicitly, with a recorded rationale', () => {
    const openPrStep = (parsed.jobs?.release?.steps ?? []).find((step) =>
      (step.run ?? '').includes('changeset-release/main')
    );
    expect(openPrStep).toBeDefined();
    expect(openPrStep?.run).toContain('gh pr comment');
    expect(openPrStep?.run).toMatch(/[Ss]uperseded/);
  });

  it('runs the configured version merge gate after preparation with the release actor (#382)', () => {
    const steps = parsed.jobs?.release?.steps ?? [];
    const mergeStep = steps.find((step) => (step.run ?? '').includes('node scripts/merge-version-pr.mjs'));
    expect(mergeStep).toBeDefined();
    expect(mergeStep?.if).toBe("steps.pending.outputs.count != '0'");
    expect(mergeStep?.run).toContain('pnpm run build');
    expect(mergeStep?.env?.GH_TOKEN).toBe('${{ secrets.RELEASE_BOT_TOKEN || github.token }}');
    expect(steps.indexOf(mergeStep!)).toBeGreaterThan(steps.findIndex((step) => step.name === 'Open version pull request'));
    expect(raw).not.toContain('--admin');
    expect(raw).not.toMatch(/gh pr merge .*--auto/);
  });

  it('documents the opt-in gate replacing the historical batch hold', () => {
    expect(raw).toContain('#382');
    expect(raw).toContain('automation.merge');
    expect(raw).toContain('target_branch: main');
    expect(raw).not.toContain('manual batch-decision point');
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
