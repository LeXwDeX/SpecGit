import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeNormalizedVerification, executeVerificationCommands } from '../../src/verification/reuse-runner.js';
import { collectReuseInputs } from '../../src/verification/reuse-inputs.js';
import { ReuseProfileSchema } from '../../src/verification/reuse-profile.js';
import { commitFile, git, initRepo, makeTempDir, rmDir } from './helpers/temp-repo.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(rmDir));
const profile = ReuseProfileSchema.parse({
  id: 'linux', check: 'Test', max_age_seconds: 3600, node: '20.19.0', pnpm: '9.15.9',
  runtime: { package: 'specgit@1.15.1', lockfile: 'ci/runtime-lock.json' }, commands: [['node', 'check.mjs']], fresh_commands: [],
  environment: { EXAMPLE_INPUT: 'fixed' }, github: { runner: 'ubuntu-24.04', entry: '.github/workflows/reuse.yml' },
});

describe('actual normalized verification command execution', () => {
  it('runs the committed program without binding, Git metadata or undeclared event input', async () => {
    const dir = makeTempDir('specgit-reuse-runner-'); dirs.push(dir);
    const { root, env } = initRepo(dir);
    const baseSha = git(root, ['rev-parse', 'HEAD'], env).trim();
    commitFile(root, '.specgit.yaml', 'version: 1\ndelivery: example\ncontext: {kind: branch, branch: feature}\nissues: [1]\npr: 2\n', env);
    const sourceSha = commitFile(root, 'check.mjs', `import fs from 'node:fs';
if (fs.existsSync('.specgit.yaml') || fs.existsSync('.git') || process.env.GITHUB_EVENT_NAME || process.env.CI_COMMIT_SHA || process.env.EXAMPLE_INPUT !== 'fixed') process.exit(1);
console.log('normalized-command-passed');\n`, env);
    const inputs = await collectReuseInputs(root, { sourceSha, checkoutSha: sourceSha, baseSha, policySha: baseSha,
      recipeDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64) });
    if (!inputs.ok) throw new Error('Expected inputs');
    fs.writeFileSync(path.join(root, 'check.mjs'), 'process.exit(2);');
    const output: string[] = [];
    const result = await executeNormalizedVerification(root, inputs.value, profile, {
      env: { ...process.env, GITHUB_EVENT_NAME: 'synthetic-event', CI_COMMIT_SHA: 'synthetic-sha' },
      log: (chunk) => output.push(chunk),
    });
    expect(result.ok).toBe(true);
    expect(output.join('')).toContain('normalized-command-passed');
    expect(fs.readFileSync(path.join(root, 'check.mjs'), 'utf8')).toBe('process.exit(2);');
  });

  it('stops after a failed command and never reports verification success', async () => {
    const root = makeTempDir('specgit-reuse-failure-'); dirs.push(root);
    const output: string[] = [];
    const result = await executeVerificationCommands(root, [
      ['node', '-e', 'process.exit(7)'], ['node', '-e', 'console.log("must-not-run")'],
    ], {}, { log: (chunk) => output.push(chunk) });
    expect(result.ok).toBe(false);
    expect(output.join('')).not.toContain('must-not-run');
  });

  it('executes fresh commands in the actual checkout so metadata validation is retained', async () => {
    const root = makeTempDir('specgit-reuse-current-'); dirs.push(root);
    fs.writeFileSync(path.join(root, '.specgit.yaml'), 'current-binding');
    const result = await executeVerificationCommands(root, [['node', '-e',
      'const fs=require("node:fs");if(fs.readFileSync(".specgit.yaml","utf8")!=="current-binding")process.exit(1);']], {}, { log: () => {} });
    expect(result.ok).toBe(true);
  });
});
