import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { harnessWorkflowYaml } from '../../src/cli/harness-content.js';
import { externalAcceptanceWorkflowYaml } from '../../src/cli/external-harness.js';
import { makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';

const workflows = [
  ['self', harnessWorkflowYaml],
  ['adopting project', () => externalAcceptanceWorkflowYaml({ defaultBranch: 'main', version: '1.13.0' })],
] as const;

function runWait(workflow: string, terminalAfterMinutes: number) {
  const root = makeTempDir('specgit-wait-budget-');
  try {
    const policy = join(root, 'policy.yaml');
    writeFileSync(policy, 'required_checks:\n  - Windows tests\n');
    const job = parse(workflow).jobs['specgit-acceptance'];
    const step = job.steps.find((item: { name?: string }) => item.name === 'Wait for sibling checks');
    const script = step.run.replace(/^node --input-type=module <<'EOF'\n/, '').replace(/\nEOF\s*$/, '')
      .replace("import { execFileSync } from 'node:child_process';", `
        let elapsed = 0;
        Date.now = () => elapsed;
        globalThis.setTimeout = (callback, milliseconds) => { elapsed += milliseconds; callback(); };
        process.on('exit', () => console.log('elapsed=' + elapsed));
        const execFileSync = (command, args) => {
          if (command !== 'gh' || args[0] !== 'api') throw new Error('Unexpected external command.');
          if (args[1] === 'repos/owner/repo/issues/437/timeline') return JSON.stringify([]);
          if (args[1] !== 'repos/owner/repo/commits/${'a'.repeat(40)}/check-runs') throw new Error('Unexpected evidence identity.');
          const completed = elapsed >= ${terminalAfterMinutes} * 60 * 1000;
          return JSON.stringify({ check_runs: [{ id: 1, name: 'Windows tests', started_at: '2026-09-04T15:00:00Z',
            status: completed ? 'completed' : 'in_progress', conclusion: completed ? 'success' : null }] });
        };
      `);
    return { ...spawnSync(process.execPath, ['--input-type=module', '-'], { input: script, encoding: 'utf8', env: {
      ...process.env, WAIT_POLICY: policy, WAIT_REPO: 'owner/repo', WAIT_SHA: 'a'.repeat(40), WAIT_PR: '437', SPECGIT_CLI_DIR: '',
    } }), timeoutMinutes: job['timeout-minutes'] };
  } finally {
    rmDir(root);
  }
}

describe('bounded acceptance waiting', () => {
  it.each(workflows)('lets a successful sibling at minute 18 reach the %s workflow verdict', (_name, generate) => {
    const result = runWait(generate(), 18);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('All required checks are in a terminal state.');
    expect(result.stdout).toContain('elapsed=1080000');
  });

  it.each(workflows)('rejects a sibling still pending after 25 minutes in the %s workflow', (_name, generate) => {
    const result = runWait(generate(), 26);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Timed out waiting for sibling checks.');
    expect(result.stdout).toContain('elapsed=1500000');
    expect(result.stdout).not.toContain('All required checks are in a terminal state.');
  });

  it.each(workflows)('leaves preparation and verdict headroom in the %s job', (_name, generate) => {
    const result = runWait(generate(), 26);
    expect(result.timeoutMinutes).toBe(30);
    expect(result.timeoutMinutes).toBeGreaterThan(25);
  });
});
