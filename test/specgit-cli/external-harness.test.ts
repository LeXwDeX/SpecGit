/**
 * Issue #63 — the portable external acceptance harness template.
 *
 * The template must install and pin the published SpecGit CLI and run in
 * any adopting Node >= 20.19 repository: no pnpm, no `main` assumption, no
 * workspace layout, no `bin/specgit.js` at the adopting repo's root, and no
 * adopting-project build. These tests pin that contract on the pure
 * generator (the wiring into `specgit init` is the assembler's seam).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { parse } from 'yaml';

import {
  externalAcceptanceWorkflowYaml,
  writeExternalHarnessWorkflow,
} from '../../src/cli/external-harness.js';
import { ACCEPTANCE_CHECK_NAME, HARNESS_WORKFLOW_PATH } from '../../src/cli/harness-assets.js';
import { createFakeGh } from '../specgit/helpers/fake-gh.js';
import { makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';

const INPUT = { defaultBranch: 'master', version: '1.2.3' } as const;

describe('external acceptance harness template', () => {
  it('parameterizes the default branch into the pull_request trigger', () => {
    for (const branch of ['master', 'trunk', 'release/1.x']) {
      const yaml = externalAcceptanceWorkflowYaml({ defaultBranch: branch, version: '1.2.3' });
      const parsed = parse(yaml) as {
        on: { pull_request: { branches: string[] } };
      };
      expect(parsed.on.pull_request.branches).toEqual([branch]);
    }
    expect(externalAcceptanceWorkflowYaml(INPUT)).toContain('branches: [master]');
  });

  it('installs and pins the published CLI, independent of the adopting stack', () => {
    const yaml = externalAcceptanceWorkflowYaml(INPUT);
    expect(yaml).toContain('npm install --no-save --no-audit --no-fund specgit@1.2.3');
    expect(yaml).not.toContain('specgit@^');
    expect(yaml).not.toContain('specgit@~');
    // Stack independence: nothing may assume the adopting repository is
    // SpecGit itself (pnpm, local build, repo-root bin, lockfile shape).
    const lower = yaml.toLowerCase();
    for (const banned of [
      'pnpm',
      'bin/specgit.js',
      'frozen-lockfile',
      'cache:',
      'run build',
      'build cli',
    ]) {
      expect(lower).not.toContain(banned);
    }
  });

  it('runs the verdict through the installed CLI, not a workspace path', () => {
    const yaml = externalAcceptanceWorkflowYaml(INPUT);
    expect(yaml).toContain('npx --no-install specgit finish --json');
    expect(yaml).toContain('GH_TOKEN: ${{ github.token }}');
  });

  it('contributes exactly the acceptance check name with read-only permissions', () => {
    const parsed = parse(externalAcceptanceWorkflowYaml(INPUT)) as {
      name: string;
      permissions: { contents: string };
      jobs: Record<string, { name: string; 'runs-on': string; 'timeout-minutes': number }>;
    };
    expect(parsed.name).toBe(ACCEPTANCE_CHECK_NAME);
    expect(parsed.permissions.contents).toBe('read');
    const job = parsed.jobs['specgit-acceptance'];
    expect(job.name).toBe(ACCEPTANCE_CHECK_NAME);
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job['timeout-minutes']).toBe(15);
  });

  it('waits for sibling checks through the gh seam, never raw REST', () => {
    const yaml = externalAcceptanceWorkflowYaml(INPUT);
    expect(yaml).toContain("readFileSync('spec_git/policy.yaml', 'utf8')");
    expect(yaml).toContain('check-runs?per_page=100');
    expect(yaml).toContain('MAX_ATTEMPTS');
    // GitHub evidence flows exclusively through the authenticated gh CLI.
    expect(yaml).not.toContain('api.github.com');
    expect(yaml).not.toContain('authorization');
  });

  it('uses Node at the engine floor and SHA-pinned actions', () => {
    const parsed = parse(externalAcceptanceWorkflowYaml(INPUT)) as {
      jobs: Record<string, { steps: Array<{ name: string; uses?: string; with?: Record<string, string> }> }>;
    };
    const steps = parsed.jobs['specgit-acceptance'].steps;
    const setupNode = steps.find((step) => step.uses?.startsWith('actions/setup-node'));
    expect(setupNode?.with?.['node-version']).toBe('20.19');
    expect(steps.some((step) => /^actions\/checkout@[0-9a-f]{40}$/.test(step.uses ?? ''))).toBe(true);
    expect(steps.some((step) => /^actions\/setup-node@[0-9a-f]{40}$/.test(step.uses ?? ''))).toBe(true);
  });

  it('is byte-deterministic and LF-only', () => {
    const first = externalAcceptanceWorkflowYaml(INPUT);
    const second = externalAcceptanceWorkflowYaml({ defaultBranch: 'master', version: '1.2.3' });
    expect(second).toBe(first);
    expect(first).not.toContain('\r');
  });

  it('rejects non-exact versions and invalid branch names', () => {
    for (const version of ['^1.0.0', '~1.0.0', '1.x', '>=1.0.0', 'latest', '', '1.0', 'v1.0.0']) {
      expect(() => externalAcceptanceWorkflowYaml({ defaultBranch: 'main', version }), version).toThrow();
    }
    for (const defaultBranch of ['', '   ', 'feature x']) {
      expect(() => externalAcceptanceWorkflowYaml({ defaultBranch, version: '1.2.3' }), defaultBranch).toThrow();
    }
  });
});

describe('external wait step truth-run semantics (#119)', () => {
  /**
   * Re-runs keep every same-name run in the Checks API. The generated
   * wait step must decide terminality on the truth run — latest by
   * started_at, ties broken by the higher check-run id (the decision
   * docs/reference.md states once for verdict and wait step alike) —
   * never on response position (last-wins) . The script is executed
   * verbatim through the fake gh seam, from a minimal adopting layout.
   */
  const SIBLING = 'Sibling Check';
  const RULE_SHA = 'a'.repeat(40);

  function waitScript(): string {
    const parsed = parse(externalAcceptanceWorkflowYaml(INPUT)) as {
      jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
    };
    const step = parsed.jobs['specgit-acceptance'].steps.find(
      (s) => s.name === 'Wait for sibling checks'
    );
    const match = /<<'EOF'\n([\s\S]*)\nEOF/.exec(step?.run ?? '');
    if (!match) throw new Error('wait step does not carry a quoted heredoc script');
    return match[1];
  }

  function makeAdoptingLayout(dir: string): void {
    fs.mkdirSync(path.join(dir, 'spec_git'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'spec_git', 'policy.yaml'),
      `version: 1\nrequired_checks:\n  - ${SIBLING}\n`,
      'utf-8'
    );
    // The script resolves `yaml` from the adopting repo's node_modules.
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    fs.symlinkSync(
      path.resolve(__dirname, '..', '..', 'node_modules', 'yaml'),
      path.join(dir, 'node_modules', 'yaml'),
      'dir'
    );
  }

  function runWait(checkRuns: unknown[]): ReturnType<typeof spawnSync> {
    const dir = makeTempDir('specgit-wait-truth-');
    makeAdoptingLayout(dir);
    const gh = createFakeGh(dir, [
      { match: '^--version$', stdout: 'gh version 2.60.0-fixture\n' },
      {
        match: '^api repos/.*/commits/[0-9a-f]+/check-runs',
        stdout: JSON.stringify({ total_count: checkRuns.length, check_runs: checkRuns }),
      },
    ]);
    try {
      return spawnSync(process.execPath, ['--input-type=module'], {
        cwd: dir,
        input: waitScript(),
        encoding: 'utf-8',
        timeout: 15_000,
        env: gh.env({
          WAIT_REPO: 'fixture/adopting',
          WAIT_SHA: RULE_SHA,
        }),
      });
    } finally {
      rmDir(dir);
    }
  }

  it('waits while only the truth run is in flight (old-green/new-red)', { timeout: 30_000 }, () => {
    // Latest-by-started_at run is in_progress; the older run is completed.
    // Last-wins-by-position would read the older terminal run and exit 0.
    const wait = runWait([
      { name: SIBLING, status: 'in_progress', conclusion: null, started_at: '2026-08-20T14:00:00Z', id: 2 },
      { name: SIBLING, status: 'completed', conclusion: 'success', started_at: '2026-08-20T13:00:00Z', id: 1 },
    ]);
    expect(wait.stdout).toContain(`Waiting for: ${SIBLING}`);
    expect(wait.stdout).not.toContain('All required checks are in a terminal state.');
    expect(wait.status).not.toBe(0);
  });

  it('stops waiting once the truth run is terminal (old-red/new-green)', { timeout: 30_000 }, () => {
    // Latest-by-started_at run is completed; the older run is still
    // in_progress. Last-wins-by-position would read the older run and
    // wait on evidence the truth run already superseded.
    const wait = runWait([
      { name: SIBLING, status: 'completed', conclusion: 'success', started_at: '2026-08-20T14:00:00Z', id: 2 },
      { name: SIBLING, status: 'in_progress', conclusion: null, started_at: '2026-08-20T13:00:00Z', id: 1 },
    ]);
    expect(wait.status, wait.stderr).toBe(0);
    expect(wait.stdout).toContain('All required checks are in a terminal state.');
  });

  it('breaks started_at ties by the higher check-run id, order-independent', { timeout: 30_000 }, () => {
    for (const runs of [
      [
        { name: SIBLING, status: 'completed', conclusion: 'success', started_at: '2026-08-20T14:00:00Z', id: 11 },
        { name: SIBLING, status: 'in_progress', conclusion: null, started_at: '2026-08-20T14:00:00Z', id: 1 },
      ],
      [
        { name: SIBLING, status: 'in_progress', conclusion: null, started_at: '2026-08-20T14:00:00Z', id: 1 },
        { name: SIBLING, status: 'completed', conclusion: 'success', started_at: '2026-08-20T14:00:00Z', id: 11 },
      ],
    ]) {
      const wait = runWait(runs);
      expect(wait.status, wait.stderr).toBe(0);
      expect(wait.stdout).toContain('All required checks are in a terminal state.');
    }
  });
});

describe('writeExternalHarnessWorkflow', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir('specgit-external-harness-');
  });

  afterEach(() => {
    rmDir(root);
  });

  it('writes the workflow under the canonical path and repairs drift byte-identically', async () => {
    const written = await writeExternalHarnessWorkflow(root, INPUT);
    expect(written).toBe(HARNESS_WORKFLOW_PATH);
    const target = path.join(root, ...HARNESS_WORKFLOW_PATH.split('/'));
    expect(fs.readFileSync(target, 'utf-8')).toBe(externalAcceptanceWorkflowYaml(INPUT));

    fs.appendFileSync(target, '# drifted local edit\n');
    await writeExternalHarnessWorkflow(root, INPUT);
    expect(fs.readFileSync(target, 'utf-8')).toBe(externalAcceptanceWorkflowYaml(INPUT));
  });
});
