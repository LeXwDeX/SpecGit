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
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as path from 'node:path';
import { parse } from 'yaml';

import {
  externalAcceptanceWorkflowYaml,
  writeExternalHarnessWorkflow,
} from '../../src/cli/external-harness.js';
import { ACCEPTANCE_CHECK_NAME, harnessWorkflowYaml } from '../../src/cli/harness-content.js';
import { HARNESS_WORKFLOW_PATH } from '../../src/cli/harness-placement.js';
import { createFakeGh, type FakeGhRule } from '../specgit/helpers/fake-gh.js';
import { makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';

const INPUT = { defaultBranch: 'master', version: '1.2.3' } as const;
const WAIT_PROCESS_TIMEOUT_MS = 2_000;

/** The heredoc body of the generated wait step, executable verbatim. */
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

/** A minimal adopting layout: policy with one required check + `yaml` resolvable. */
function makeAdoptingLayout(dir: string): void {
  fs.mkdirSync(path.join(dir, 'spec_git'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'spec_git', 'policy.yaml'),
    `version: 1\nrequired_checks:\n  - Sibling Check\n`,
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

describe('external acceptance harness template', () => {
  it('parameterizes the default branch into the pull_request trigger', () => {
    for (const branch of ['master', 'trunk', 'release/1.x', 'release,stable', '!release']) {
      const yaml = externalAcceptanceWorkflowYaml({ defaultBranch: branch, version: '1.2.3' });
      const parsed = parse(yaml) as {
        on: { pull_request: { branches: string[]; types: string[] } };
      };
      expect(parsed.on.pull_request.branches).toEqual([branch]);
      expect(parsed.on.pull_request.types).toEqual([
        'opened',
        'synchronize',
        'reopened',
        'ready_for_review',
        'edited',
      ]);
    }
    expect(externalAcceptanceWorkflowYaml(INPUT)).toContain('branches: ["master"]');
  });

  it('installs in runner storage without interpreting the adopting workspace manifest', () => {
    const root = makeTempDir('specgit-isolated-install-');
    try {
      const runner = path.join(root, 'runner');
      const fixture = path.join(root, 'fixture-cli');
      fs.mkdirSync(fixture, { recursive: true });
      fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'specgit', version: '1.2.3' }));
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
        name: 'adopter', private: true, dependencies: { '@example/local': 'workspace:*' },
      }));
      const parsed = parse(externalAcceptanceWorkflowYaml(INPUT)) as {
        jobs: Record<string, { steps: Array<{ name: string; run?: string }> }>;
      };
      const command = parsed.jobs['specgit-acceptance'].steps.find((step) => step.name === 'Install pinned SpecGit CLI')?.run;
      expect(command).toBeDefined();
      const quotedFixture = `'${fixture.replace(/'/g, `'\\''`)}'`;
      const install = spawnSync('sh', ['-c', command!.replace('specgit@1.2.3', quotedFixture)], {
        cwd: root, encoding: 'utf8', timeout: 15_000,
        env: { ...process.env, RUNNER_TEMP: runner, npm_config_cache: path.join(root, 'cache'), npm_config_offline: 'true' },
      });
      expect(install.status, install.stderr).toBe(0);
      expect(fs.existsSync(path.join(runner, 'specgit-cli/node_modules/specgit/package.json'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'node_modules'))).toBe(false);
      expect(fs.existsSync(path.join(root, 'package-lock.json'))).toBe(false);
    } finally { rmDir(root); }
  });

  it('installs and pins the published CLI, independent of the adopting stack', () => {
    const yaml = externalAcceptanceWorkflowYaml(INPUT);
    expect(yaml).toContain('npm install --prefix "$RUNNER_TEMP/specgit-cli" --no-save --no-audit --no-fund specgit@1.2.3');
    expect(yaml).not.toContain('specgit@^');
    expect(yaml).not.toContain('specgit@~');
    // Stack independence: nothing may assume the adopting repository is
    // SpecGit itself (pnpm, local build, repo-root bin, lockfile shape).
    const lower = yaml.toLowerCase();
    for (const banned of [
      'pnpm',
      'bin/specgit.js',
      'frozen-lockfile',
      'run build',
      'build cli',
    ]) {
      expect(lower).not.toContain(banned);
    }
    expect(lower).not.toMatch(/^\s+cache:/m);
    expect(lower).toContain('package-manager-cache: false');
  });

  it('runs the verdict through the installed CLI, not a workspace path', () => {
    const yaml = externalAcceptanceWorkflowYaml(INPUT);
    expect(yaml).toContain('"$RUNNER_TEMP/specgit-cli/node_modules/.bin/specgit" finish --json');
    expect(yaml).toContain('GH_TOKEN: ${{ github.token }}');
  });

  it('loads the wait parser from the isolated CLI when the adopter has no node_modules', () => {
    const root = makeTempDir('specgit-isolated-wait-');
    try {
      makeAdoptingLayout(root);
      fs.writeFileSync(path.join(root, 'spec_git/policy.yaml'), 'version: 1\nrequired_checks: []\n');
      const cliDir = path.join(root, 'runner storage', 'specgit-cli');
      fs.mkdirSync(cliDir, { recursive: true });
      fs.renameSync(path.join(root, 'node_modules'), path.join(cliDir, 'node_modules'));
      fs.mkdirSync(path.join(cliDir, 'node_modules/specgit'));
      const gh = createFakeGh(root, [{ match: '^api repos/.*/commits/.*/check-runs', stdout: JSON.stringify({ check_runs: [] }) }]);
      const result = spawnSync(process.execPath, ['--input-type=module'], {
        cwd: root, input: waitScript(), encoding: 'utf8', timeout: 5_000,
        env: gh.env({ SPECGIT_CLI_DIR: cliDir, WAIT_REPO: 'test/adopter', WAIT_SHA: 'a'.repeat(40), WAIT_PR: '' }),
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('All required checks are in a terminal state.');
    } finally { rmDir(root); }
  });

  it('contributes exactly the acceptance check name with read-only permissions', () => {
    const parsed = parse(externalAcceptanceWorkflowYaml(INPUT)) as {
      name: string;
      permissions: { contents: string; issues: string; 'pull-requests': string };
      concurrency: { group: string; 'cancel-in-progress': boolean };
      jobs: Record<string, { name: string; 'runs-on': string; 'timeout-minutes': number }>;
    };
    expect(parsed.name).toBe(ACCEPTANCE_CHECK_NAME);
    expect(parsed.permissions.contents).toBe('read');
    expect(parsed.permissions.issues).toBe('read');
    expect(parsed.permissions['pull-requests']).toBe('read');
    // #319: a newer trigger event cancels the superseded run instead of
    // leaving parallel copies burning identical wait budgets.
    expect(parsed.concurrency.group).toBe('specgit-accept-${{ github.ref }}');
    expect(parsed.concurrency['cancel-in-progress']).toBe(true);
    const job = parsed.jobs['specgit-acceptance'];
    expect(job.name).toBe(ACCEPTANCE_CHECK_NAME);
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job['timeout-minutes']).toBe(15);
  });

  it('waits for sibling checks through the gh seam, never raw REST', () => {
    const yaml = externalAcceptanceWorkflowYaml(INPUT);
    const parsed = parse(yaml) as {
      jobs: Record<string, { steps: Array<{ name?: string; run?: string; env?: Record<string, string> }> }>;
    };
    const steps = parsed.jobs['specgit-acceptance'].steps;
    const prepare = steps.findIndex((step) => step.name === 'Prepare approved policy for acceptance');
    const wait = steps.findIndex((step) => step.name === 'Wait for sibling checks');
    expect(prepare).toBeGreaterThan(-1);
    expect(wait).toBeGreaterThan(prepare);
    expect(steps[prepare].run).toContain('$RUNNER_TEMP/specgit-cli/node_modules/specgit/dist/automation/workflow-policy.js');
    expect(steps[prepare].env?.SPECGIT_WAIT_POLICY).toBe('${{ runner.temp }}/specgit-policy.yaml');
    expect(steps[wait].env?.WAIT_POLICY).toBe(steps[prepare].env?.SPECGIT_WAIT_POLICY);
    expect(yaml).toContain("readFileSync(policyPath, 'utf8')");
    // The query rides --field args (gh builds the query string itself):
    // a raw "?a=1&b=2" URL would be split by cmd.exe's "&" separator on
    // Windows, where gh.cmd needs a shell (#300).
    expect(yaml).toContain("'--field', 'per_page=' + PER_PAGE");
    expect(yaml).toContain("'--field', 'page=' + page");
    expect(yaml).not.toContain('?per_page=');
    expect(yaml).toContain('MAX_ATTEMPTS');
    // #300: the listing pages to exhaustion like the self template.
    expect(yaml).toContain('fetchAllCheckRuns');
    // GitHub evidence flows exclusively through the authenticated gh CLI.
    expect(yaml).not.toContain('api.github.com');
    expect(yaml).not.toContain('authorization');
  });

  it.each([true, false])('honors the resolved policy path without silently falling back when present=%s', (present) => {
    const root = makeTempDir('specgit-approved-wait-');
    try {
      makeAdoptingLayout(root);
      const approvedPath = path.join(root, 'approved-policy.yaml');
      if (present) fs.writeFileSync(approvedPath, 'version: 1\nrequired_checks: [Approved Check]\n');
      const gh = createFakeGh(root, [{
        match: '^api repos/.*/commits/.*/check-runs',
        stdout: JSON.stringify({ check_runs: [{
          name: present ? 'Approved Check' : 'Sibling Check',
          status: 'completed', conclusion: 'success', started_at: '2026-09-04T00:00:00Z', id: 1,
        }] }),
      }]);
      const result = spawnSync(process.execPath, ['--input-type=module'], {
        cwd: root, input: waitScript(), encoding: 'utf8', timeout: WAIT_PROCESS_TIMEOUT_MS,
        env: gh.env({ WAIT_POLICY: approvedPath, WAIT_REPO: 'test/adopter', WAIT_SHA: 'a'.repeat(40), WAIT_PR: '' }),
      });
      expect(result.status, result.stderr).toBe(present ? 0 : 1);
      if (present) expect(result.stdout).toContain('All required checks are in a terminal state.');
      else expect(result.stderr).toContain('policy.yaml is absent');
    } finally { rmDir(root); }
  });

  it('renders both wait steps through authenticated gh with the shared evidence rules', () => {
    const external = externalAcceptanceWorkflowYaml(INPUT);
    const self = harnessWorkflowYaml();
    // The shared skeleton (pagination, truth-run rule, absent-policy
    // diagnosis) and transport are shared by both templates.
    for (const shared of [
      'fetchAllCheckRuns',
      'const truth = new Map();',
      'policy.yaml is absent at this head',
      "const terminal = new Set(['completed']);",
    ]) {
      expect(external).toContain(shared);
      expect(self).toContain(shared);
    }
    expect(external).toContain("'gh',");
    expect(self).not.toContain('api.github.com');
    expect(self).toContain("'gh',");
    expect(external).not.toContain('api.github.com');
  });

  it('waits on anchored freshness through the timeline seam, never gh pr checks text (#315)', () => {
    const yaml = externalAcceptanceWorkflowYaml(INPUT);
    // The anchor rides the issue-timeline endpoint through the same gh
    // seam; the PR number arrives via workflow context, defaulting to
    // empty on non-PR events (no anchor, no freshness bound).
    expect(yaml).toContain('ready_for_review');
    expect(yaml).toContain('/timeline');
    expect(yaml).toContain("WAIT_PR: ${{ github.event.pull_request.number || '' }}");
    // Human-readable `gh pr checks` output is never a parse surface.
    expect(yaml).not.toContain('pr checks');
  });

  it('fails with a diagnosis, not a crash, when the policy is absent at the head (#297)', () => {
    const yaml = externalAcceptanceWorkflowYaml(INPUT);
    // The adoption story: a hand-made PR (no binding commit) must see an
    // actionable message instead of an unreadable ENOENT stack.
    expect(yaml).toContain('policy.yaml is absent at this head');
    expect(yaml).toContain('existsSync');
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

  function runWait(checkRuns: unknown[]): SpawnSyncReturns<string> {
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
        timeout: WAIT_PROCESS_TIMEOUT_MS,
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

  it('orders truth runs by parsed time when offsets differ', { timeout: 30_000 }, () => {
    const wait = runWait([
      { name: SIBLING, status: 'in_progress', conclusion: null, started_at: '2026-08-20T15:00:00-01:00', id: 2 },
      { name: SIBLING, status: 'completed', conclusion: 'success', started_at: '2026-08-20T15:30:00Z', id: 1 },
    ]);
    expect(wait.status, wait.stderr).not.toBe(0);
    expect(wait.stdout).toContain(`Waiting for: ${SIBLING}`);
  });
});

describe('external wait step check freshness (#315, #316)', () => {
  /**
   * Anchored freshness: once the delivery became reviewable (the latest
   * ready_for_review transition on the PR timeline), a green truth run
   * that PREDATES the transition is stale — the wait keeps going until a
   * fresh run (started at/after the anchor) registers and terminates.
   * The anchor rides the same gh api timeline seam as the check-runs
   * listing; `gh pr checks` human text is never parsed. Without a
   * pull-request context (empty WAIT_PR) there is no anchor and the
   * legacy terminality rule decides alone.
   */
  const SIBLING = 'Sibling Check';
  const RULE_SHA = 'a'.repeat(40);
  const READY_AT = '2026-08-20T15:00:00Z';

  interface WaitScenario {
    checkRuns: unknown[];
    /** Timeline events for the pull request; absent means "no PR context". */
    timeline?: unknown;
    /** Defaults to '9' when a timeline is supplied, '' otherwise. */
    waitPr?: string;
  }

  function runWaitScenario(scenario: WaitScenario): SpawnSyncReturns<string> {
    const dir = makeTempDir('specgit-wait-fresh-');
    makeAdoptingLayout(dir);
    const rules: FakeGhRule[] = [
      {
        match: '^api repos/.*/commits/[0-9a-f]+/check-runs',
        stdout: JSON.stringify({ total_count: scenario.checkRuns.length, check_runs: scenario.checkRuns }),
      },
    ];
    if (scenario.timeline !== undefined) {
      rules.push({
        match: '^api repos/.*/issues/9/timeline',
        stdout: JSON.stringify(scenario.timeline),
      });
    }
    const gh = createFakeGh(dir, rules);
    try {
      return spawnSync(process.execPath, ['--input-type=module'], {
        cwd: dir,
        input: waitScript(),
        encoding: 'utf-8',
        timeout: WAIT_PROCESS_TIMEOUT_MS,
        env: gh.env({
          WAIT_REPO: 'fixture/adopting',
          WAIT_SHA: RULE_SHA,
          WAIT_PR: scenario.waitPr ?? (scenario.timeline !== undefined ? '9' : ''),
        }),
      });
    } finally {
      rmDir(dir);
    }
  }

  it('keeps waiting when the only green truth run predates the ready-for-review anchor (stale green)', { timeout: 30_000 }, () => {
    const wait = runWaitScenario({
      checkRuns: [
        { name: SIBLING, status: 'completed', conclusion: 'success', started_at: '2026-08-20T14:00:00Z', id: 1 },
      ],
      timeline: [{ event: 'ready_for_review', created_at: READY_AT }],
    });
    expect(wait.status, wait.stderr).not.toBe(0);
    expect(wait.stdout).not.toContain('All required checks are in a terminal state.');
    // The stale check is named as awaiting a fresh run, not silently passed.
    expect(wait.stdout).toContain(SIBLING);
  });

  it('keeps waiting while the fresh run is registered but still pending', { timeout: 30_000 }, () => {
    const wait = runWaitScenario({
      checkRuns: [
        { name: SIBLING, status: 'in_progress', conclusion: null, started_at: '2026-08-20T15:30:00Z', id: 2 },
      ],
      timeline: [{ event: 'ready_for_review', created_at: READY_AT }],
    });
    expect(wait.status, wait.stderr).not.toBe(0);
    expect(wait.stdout).toContain(`Waiting for: ${SIBLING}`);
  });

  it('stops once a fresh terminal run exists (started after the anchor)', { timeout: 30_000 }, () => {
    const wait = runWaitScenario({
      checkRuns: [
        { name: SIBLING, status: 'completed', conclusion: 'success', started_at: '2026-08-20T15:30:00Z', id: 2 },
      ],
      timeline: [{ event: 'ready_for_review', created_at: READY_AT }],
    });
    expect(wait.status, wait.stderr).toBe(0);
    expect(wait.stdout).toContain('All required checks are in a terminal state.');
  });

  it('treats a truth run started exactly at the anchor as fresh (>= boundary)', { timeout: 30_000 }, () => {
    const wait = runWaitScenario({
      checkRuns: [
        { name: SIBLING, status: 'completed', conclusion: 'success', started_at: READY_AT, id: 2 },
      ],
      timeline: [{ event: 'ready_for_review', created_at: READY_AT }],
    });
    expect(wait.status, wait.stderr).toBe(0);
    expect(wait.stdout).toContain('All required checks are in a terminal state.');
  });

  it('without a pull-request context the anchor stays unset and legacy terminality decides alone', { timeout: 30_000 }, () => {
    // The same stale green as the first case, but no WAIT_PR: no anchor,
    // no timeline call, byte-legacy behavior (a push/dispatch run).
    const wait = runWaitScenario({
      checkRuns: [
        { name: SIBLING, status: 'completed', conclusion: 'success', started_at: '2026-08-20T14:00:00Z', id: 1 },
      ],
    });
    expect(wait.status, wait.stderr).toBe(0);
    expect(wait.stdout).toContain('All required checks are in a terminal state.');
  });

   it('fails closed when a ready_for_review event has no valid timestamp', { timeout: 30_000 }, () => {
     // A missing timestamp is malformed evidence, not proof that no
     // transition occurred. Never silently remove the freshness boundary.
    const wait = runWaitScenario({
      checkRuns: [
        { name: SIBLING, status: 'completed', conclusion: 'success', started_at: '2026-08-20T14:00:00Z', id: 1 },
      ],
      timeline: [{ event: 'ready_for_review' }],
    });
     expect(wait.status, wait.stderr).not.toBe(0);
     expect(wait.stdout).not.toContain('All required checks are in a terminal state.');
   });

   it('fails closed when the timeline payload is not an array', { timeout: 30_000 }, () => {
     const wait = runWaitScenario({
       checkRuns: [
         { name: SIBLING, status: 'completed', conclusion: 'success', started_at: '2026-08-20T15:30:00Z', id: 2 },
       ],
       timeline: 'malformed timeline payload',
     });
     expect(wait.status, wait.stderr).not.toBe(0);
     expect(wait.stdout).not.toContain('All required checks are in a terminal state.');
   });

  it('fails loudly when the anchor cannot be read, never silently unbounds freshness', { timeout: 30_000 }, () => {
    const dir = makeTempDir('specgit-wait-anchor-err-');
    makeAdoptingLayout(dir);
    const gh = createFakeGh(dir, [
      {
        match: '^api repos/.*/commits/[0-9a-f]+/check-runs',
        stdout: JSON.stringify({
          total_count: 1,
          check_runs: [
            { name: SIBLING, status: 'completed', conclusion: 'success', started_at: '2026-08-20T15:30:00Z', id: 2 },
          ],
        }),
      },
      {
        match: '^api repos/.*/issues/9/timeline',
        exit: 1,
        stderr: 'gh: Not Found (HTTP 404)\n',
      },
    ]);
    try {
      const wait = spawnSync(process.execPath, ['--input-type=module'], {
        cwd: dir,
        input: waitScript(),
        encoding: 'utf-8',
        timeout: WAIT_PROCESS_TIMEOUT_MS,
        env: gh.env({ WAIT_REPO: 'fixture/adopting', WAIT_SHA: RULE_SHA, WAIT_PR: '9' }),
      });
      expect(wait.status, wait.stderr).not.toBe(0);
      expect(wait.stdout).not.toContain('All required checks are in a terminal state.');
    } finally {
      rmDir(dir);
    }
  });

  it('anchors at the LATEST transition when the timeline carries several', { timeout: 30_000 }, () => {
    // draft → ready → draft → ready: the newest ready_for_review wins,
    // so a run started between the two transitions is stale.
    const wait = runWaitScenario({
      checkRuns: [
        { name: SIBLING, status: 'completed', conclusion: 'success', started_at: '2026-08-20T16:00:00Z', id: 3 },
      ],
      timeline: [
        { event: 'ready_for_review', created_at: '2026-08-20T15:00:00Z' },
        { event: 'convert_to_draft', created_at: '2026-08-20T15:30:00Z' },
        { event: 'ready_for_review', created_at: '2026-08-20T17:00:00Z' },
      ],
    });
    expect(wait.status, wait.stderr).not.toBe(0);
    expect(wait.stdout).not.toContain('All required checks are in a terminal state.');
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
