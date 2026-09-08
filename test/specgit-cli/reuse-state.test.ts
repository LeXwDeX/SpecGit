import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { githubReuseWorkflow } from '../../src/verification/reuse-workflow.js';
import { ReuseProfileSchema } from '../../src/verification/reuse-profile.js';
import { createFakeGh, readFakeGhCalls } from '../specgit/helpers/fake-gh.js';
import { commitFile, git, initRepo, makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(rmDir));

function fixture() {
  const directory = makeTempDir('specgit-reuse-observer-'); directories.push(directory);
  const { root, env } = initRepo(directory);
  const runner = process.platform === 'win32' ? 'windows-2025' : process.platform === 'darwin' ? 'macos-15' : 'ubuntu-24.04';
  const image = process.platform === 'win32' ? 'win25' : process.platform === 'darwin' ? 'macos15' : 'ubuntu24';
  const profile = ReuseProfileSchema.parse({ id: 'native', check: 'Test', max_age_seconds: 3600,
    node: process.versions.node, pnpm: '9.15.9',
    runtime: { package: 'specgit@1.15.1', lockfile: 'ci/runtime-lock.json' },
    commands: [['node', 'verify.mjs']], fresh_commands: [],
    github: { runner, entry: '.github/workflows/reuse.yml' },
  });
  commitFile(root, profile.runtime.lockfile, '{}\n', env);
  commitFile(root, profile.github!.entry, githubReuseWorkflow(profile), env);
  const base = commitFile(root, 'spec_git/policy.yaml', YAML.stringify({ version: 1, required_checks: ['Test'],
    verification: { product_checks: ['Test'], rules: [], reuse: [profile] },
  }), env);
  const remote = path.join(directory, 'origin.git');
  git(root, ['clone', '--bare', root, remote], env);
  git(root, ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], env);
  git(root, ['config', `url.${remote.replaceAll('\\', '/')}.insteadOf`, 'https://github.com/owner/project.git'], env);
  git(root, ['fetch', 'origin'], env);
  git(root, ['switch', '-c', 'feature'], env);
  commitFile(root, '.specgit.yaml', YAML.stringify({ version: 1, delivery: 'native',
    context: { kind: 'branch', branch: 'feature' }, issues: [7], pr: 7,
  }), env);
  let head = commitFile(root, 'verify.mjs', 'console.log("verified");\n', env);
  const observe = (nativeChange: object = {}) => {
    const fake = createFakeGh(directory, [
      { match: '/actions/runs/11/attempts/1/jobs', stdout: JSON.stringify({ total_count: 1, jobs: [{
        name: 'SpecGit prepare / native', status: 'in_progress', run_id: 11, run_attempt: 1, head_sha: head,
      }] }) },
      { match: '/actions/runs/11(?: |$)', stdout: JSON.stringify({ id: 11, head_sha: head, run_attempt: 1,
        repository: { full_name: 'owner/project' }, head_repository: { full_name: 'owner/project' },
        path: profile.github!.entry, event: 'pull_request', ...nativeChange,
      }) },
      { match: '/pulls/7(?: |$)', stdout: JSON.stringify({ number: 7, state: 'open', draft: true,
        head: { ref: 'feature', sha: head }, base: { ref: 'main', sha: base }, body: 'Closes #7',
      }) },
    ]);
    fs.writeFileSync(path.join(fake.binDir, 'pnpm'), '#!/usr/bin/env node\nconsole.log("9.15.9");\n', { mode: 0o755 });
    fs.writeFileSync(path.join(fake.binDir, 'pnpm.cmd'), '@echo 9.15.9\r\n');
    const module = new URL('../../dist/cli/reuse-state.js', import.meta.url).href;
    const source = `const {readReuseCiState}=await import(${JSON.stringify(module)}); const state=await readReuseCiState(process.cwd(),'native',process.env,Date.now()); console.log(JSON.stringify({context:state.context,applicable:state.applicable,nativeJob:state.verifyJobName?await state.verifyJobName('SpecGit prepare / native'):null}));`;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', source], { cwd: root,
      env: fake.env({ ...env, GITLAB_CI: 'false', GITHUB_REPOSITORY: 'owner/project', GITHUB_RUN_ID: '11',
        GITHUB_RUN_ATTEMPT: '1', ImageOS: image, ImageVersion: '20260908.1.0' }), encoding: 'utf8', timeout: 30_000,
    });
    return { result: JSON.parse(output), calls: readFakeGhCalls(fake.logPath) };
  };
  return { root, env, profile, base, observe, changeProducer: () => {
    head = commitFile(root, profile.github!.entry, githubReuseWorkflow(profile) + '# changed producer\n', env);
  } };
}

describe('native CI state composition with real Git and deterministic forge CLI', () => {
  it('combines current native execution, approved policy, producer bytes and observed inputs', () => {
    const f = fixture();
    const { result, calls } = f.observe();
    expect(result.context.ok, JSON.stringify(result)).toBe(true);
    expect(result.context.value.inputs.baseSha).toBe(f.base);
    expect(result.context.value.inputs.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.applicable).toBe(true);
    expect(result.nativeJob).toBe(true);
    expect(calls.some((call) => call.includes('/actions/runs/11'))).toBe(true);
    expect(calls.some((call) => call.includes('/pulls/7'))).toBe(true);
    expect(f.observe({ id: 99 }).result.context.code).toBe('verification_reuse_native_run_unavailable');
    f.changeProducer();
    expect(f.observe().result.context.code).toBe('verification_reuse_producer_files_unavailable');
  });
});
