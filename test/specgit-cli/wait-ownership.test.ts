import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { harnessWorkflowYaml } from '../../src/cli/harness-content.js';
import { externalAcceptanceWorkflowYaml } from '../../src/cli/external-harness.js';
import { makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';

const HEAD = 'a'.repeat(40);
const oldWorkflow = { id: 33894441940, check_suite_id: 91858960293, workflow_id: 336627220, event: 'pull_request',
  head_sha: HEAD, run_attempt: 1, run_started_at: '2026-09-04T16:19:01Z', status: 'completed' };
const newWorkflow = { ...oldWorkflow, id: 33894442102, check_suite_id: 91858960778, status: 'in_progress' };
const oldCheck = { id: 10, name: 'Required verification', app: { slug: 'github-actions', id: 15368 },
  check_suite: { id: oldWorkflow.check_suite_id }, started_at: '2026-09-04T16:19:04Z', status: 'completed', conclusion: 'failure' };
const newCheck = { ...oldCheck, id: 11, check_suite: { id: newWorkflow.check_suite_id }, started_at: '2026-09-04T16:19:10Z', conclusion: 'success' };
interface Frame { checks: unknown[]; workflows: unknown[]; total?: number; pages?: unknown[] }

function executeWait(generate: () => string, frames: Frame[]) {
  const root = makeTempDir('specgit-wait-ownership-');
  try {
    const policy = join(root, 'policy.yaml');
    const evidence = join(root, 'evidence.json');
    writeFileSync(policy, 'required_checks: [Required verification]\n');
    writeFileSync(evidence, JSON.stringify(frames));
    const job = parse(generate()).jobs['specgit-acceptance'];
    const step = job.steps.find((item: { name?: string }) => item.name === 'Wait for sibling checks');
    const script = step.run.replace(/^node --input-type=module <<'EOF'\n/, '').replace(/\nEOF\s*$/, '')
      .replace("import { execFileSync } from 'node:child_process';", `
        const frames = JSON.parse(readFileSync(process.env.TEST_EVIDENCE, 'utf8'));
        let elapsed = 0;
        let workflowReads = 0;
        Date.now = () => elapsed;
        globalThis.setTimeout = (callback, milliseconds) => { elapsed += milliseconds; callback(); };
        process.on('exit', () => console.log(JSON.stringify({elapsed, workflowReads})));
        const execFileSync = (command, args) => {
          if (command !== 'gh' || args[0] !== 'api') throw new Error('Unexpected external command.');
          const frame = frames[Math.min(Math.floor(elapsed / 10000), frames.length - 1)];
          if (args[1].endsWith('/timeline')) return JSON.stringify([{ event: 'ready_for_review', created_at: '2026-09-04T16:19:01Z' }]);
          if (args[1].endsWith('/check-runs')) return JSON.stringify({ check_runs: frame.checks });
          if (args[1] === 'repos/owner/repo/actions/runs') {
            if (!args.includes('head_sha=${HEAD}')) throw new Error('Missing exact head filter.');
            workflowReads++;
            const page = Number(args.find((arg) => arg.startsWith('page=')).slice(5));
            return JSON.stringify({ total_count: frame.total ?? frame.workflows.length,
              workflow_runs: frame.pages ? frame.pages[page - 1] : page === 1 ? frame.workflows : [] });
          }
          throw new Error('Unexpected API endpoint.');
        };
      `);
    return spawnSync(process.execPath, ['--input-type=module', '-'], { input: script, encoding: 'utf8', env: {
      ...process.env, TEST_EVIDENCE: evidence, WAIT_POLICY: policy, WAIT_REPO: 'owner/repo', WAIT_SHA: HEAD,
      WAIT_PR: '436', SPECGIT_CLI_DIR: '',
    } });
  } finally { rmDir(root); }
}

const workflows = [
  ['self', harnessWorkflowYaml],
  ['external', () => externalAcceptanceWorkflowYaml({ defaultBranch: 'main', version: '1.13.0' })],
] as const;

describe('required Actions checks belong to the current workflow execution', () => {
  it.each(workflows)('waits past a cancelled run aggregate while its successor has no aggregate yet: %s', (_name, generate) => {
    expect(parse(generate()).permissions.actions).toBe('read');
    const result = executeWait(generate, [
      { checks: [oldCheck], workflows: [oldWorkflow, newWorkflow] },
      { checks: [oldCheck, newCheck], workflows: [oldWorkflow, { ...newWorkflow, status: 'completed' }] },
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Waiting for: Required verification');
    expect(result.stdout).toContain('"elapsed":10000');
  });

  it.each(workflows)('does not reuse completed jobs while their same run is rerunning: %s', (_name, generate) => {
    const rerun = { ...oldWorkflow, run_attempt: 2, status: 'queued' };
    const result = executeWait(generate, [
      { checks: [{ ...oldCheck, conclusion: 'success' }], workflows: [rerun] },
      { checks: [{ ...oldCheck, conclusion: 'success' }], workflows: [{ ...rerun, status: 'completed' }] },
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"elapsed":10000');
  });

  it('waits for the current failed aggregate, then leaves its rejection to the verdict', () => {
    const result = executeWait(harnessWorkflowYaml, [
      { checks: [oldCheck, { ...newCheck, conclusion: 'failure' }], workflows: [oldWorkflow, newWorkflow] },
      { checks: [oldCheck, { ...newCheck, conclusion: 'failure' }], workflows: [oldWorkflow, { ...newWorkflow, status: 'completed' }] },
    ]);
    // This step proves terminality; finish still evaluates the real failed conclusion.
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"elapsed":10000');
  });

  it('keeps its finite deadline when only an obsolete aggregate exists', () => {
    const result = executeWait(harnessWorkflowYaml, [{ checks: [oldCheck], workflows: [oldWorkflow, newWorkflow] }]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Timed out waiting for sibling checks.');
    expect(result.stdout).toContain('"elapsed":1500000');
  });

  it('does not wait for its own or unrelated workflow once the required owner is terminal', () => {
    const ownRun = { ...newWorkflow, id: 50, check_suite_id: 60, workflow_id: 70 };
    const result = executeWait(harnessWorkflowYaml, [{
      checks: [newCheck, { ...newCheck, id: 90, name: 'SpecGit Acceptance', check_suite: { id: 60 } }],
      workflows: [{ ...newWorkflow, status: 'completed' }, ownRun],
    }]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"elapsed":0');
  });

  it('keeps workflow events separate when choosing the current owner', () => {
    const result = executeWait(harnessWorkflowYaml, [{ checks: [oldCheck],
      workflows: [oldWorkflow, { ...newWorkflow, event: 'push' }],
    }]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"elapsed":0');
  });

  it('preserves an external app check without requiring any Actions API calls', () => {
    const result = executeWait(harnessWorkflowYaml, [{
      checks: [{ ...newCheck, app: { id: 42, slug: 'external-ci' }, check_suite: undefined }], workflows: [],
    }]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"workflowReads":0');
  });

  it('uses the Actions app ID when its slug is absent', () => {
    const result = executeWait(harnessWorkflowYaml, [{
      checks: [{ ...oldCheck, app: { id: 15368 }, check_suite: undefined }], workflows: [oldWorkflow],
    }]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no verified workflow owner');
  });

  const unrelated = (i: number) => ({ ...oldWorkflow, id: i + 1000, check_suite_id: i + 2000, workflow_id: i + 3000 });
  it('finds a successor owner on the second page before releasing the required check', () => {
    const first = [oldWorkflow, ...Array.from({ length: 99 }, (_, i) => unrelated(i))];
    const result = executeWait(harnessWorkflowYaml, [
      { checks: [oldCheck], workflows: [], total: 101, pages: [first, [newWorkflow]] },
      { checks: [oldCheck, newCheck], workflows: [], total: 101, pages: [first, [{ ...newWorkflow, status: 'completed' }]] },
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"workflowReads":4');
    expect(result.stdout).toContain('"elapsed":10000');
  });

  it.each([
    ['missing suite', { checks: [{ ...oldCheck, check_suite: undefined }], workflows: [oldWorkflow] }],
    ['missing owner', { checks: [oldCheck], workflows: [] }],
    ['missing workflow identity', { checks: [oldCheck], workflows: [{ ...oldWorkflow, workflow_id: undefined }] }],
    ['missing attempt', { checks: [oldCheck], workflows: [{ ...oldWorkflow, run_attempt: undefined }] }],
    ['wrong head', { checks: [oldCheck], workflows: [{ ...oldWorkflow, head_sha: 'b'.repeat(40) }] }],
    ['invalid start', { checks: [oldCheck], workflows: [{ ...oldWorkflow, run_started_at: 'yesterday' }] }],
    ['duplicate run', { checks: [oldCheck], workflows: [oldWorkflow, oldWorkflow] }],
    ['ambiguous suite', { checks: [oldCheck], workflows: [oldWorkflow, { ...oldWorkflow, id: 2 }] }],
    ['truncated page', { checks: [oldCheck], workflows: [oldWorkflow], total: 2 }],
    ['invalid page', { checks: [oldCheck], workflows: [], total: 1, pages: [null] }],
    ['API cap exceeded', { checks: [oldCheck], workflows: [oldWorkflow], total: 1001 }],
    ['full final page at cap', { checks: [oldCheck], workflows: [], total: 1000,
      pages: Array.from({ length: 10 }, (_, page) => Array.from({ length: 100 }, (_, i) => unrelated(page * 100 + i))) }],
  ] satisfies Array<[string, Frame]>)('fails closed for %s', (_name, frame) => {
    const result = executeWait(harnessWorkflowYaml, [frame]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/workflow|pagination|API limit/);
    expect(result.stdout).not.toContain('All required checks are in a terminal state.');
  });
});
