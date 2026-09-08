import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GUARD_SCRIPT, mergeGitPrePush } from '../../src/cli/harness-content.js';
import { commitFile, git, initRepo, makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';

const hasShell = spawnSync('sh', ['-c', 'exit 0']).status === 0;

describe.skipIf(!hasShell)('default-branch push guards in a real Git repository', () => {
  let temp: string;
  let root: string;
  let env: NodeJS.ProcessEnv;
  let oldHead: string;
  let head: string;

  beforeEach(() => {
    temp = makeTempDir('specgit-default-guards-');
    ({ root, env } = initRepo(temp));
    oldHead = git(root, ['rev-parse', 'HEAD'], env).trim();
    commitFile(root, 'change.txt', 'new delivery', env);
    head = git(root, ['rev-parse', 'HEAD'], env).trim();
  });

  afterEach(() => rmDir(temp));

  function setDefault(branch: string) {
    git(root, ['update-ref', `refs/remotes/origin/${branch}`, oldHead], env);
    git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`], env);
  }

  function prePush(branch: string, sha = head) {
    const script = path.join(temp, 'pre-push');
    fs.writeFileSync(script, mergeGitPrePush(null));
    return spawnSync('sh', [script, 'origin'], {
      cwd: root, env: { ...process.env, ...env }, encoding: 'utf8',
      input: `refs/heads/main ${sha} refs/heads/${branch} ${oldHead}\n`,
    });
  }

  function agentPush(command: string) {
    const script = path.join(temp, 'agent-guard');
    fs.writeFileSync(script, GUARD_SCRIPT);
    return spawnSync('sh', [script], {
      cwd: root, env: { ...process.env, ...env }, encoding: 'utf8',
      input: JSON.stringify({ tool_input: { command } }),
    });
  }

  it.each(['master', 'trunk', 'release/stable', 'main'])(
    'blocks a new direct push to the proved default %s, and permits delivery branches', (branch) => {
      setDefault(branch);
      expect(prePush(branch).status).toBe(1);
      expect(prePush(`${branch}-feature`).status).toBe(0);
      expect(prePush('feat/1-new').status).toBe(0);
      expect(agentPush(`git push origin ${branch}`).status).toBe(2);
      expect(agentPush(`git push origin +${branch}`).status).toBe(2);
      expect(agentPush(`git push origin HEAD:${branch}`).status).toBe(2);
      expect(agentPush(`git push origin ${branch}-feature`).status).toBe(0);
    }
  );

  it('allows a non-default branch named main and mirroring accepted master history', () => {
    setDefault('master');
    expect(prePush('main').status).toBe(0);
    expect(agentPush('git push origin main').status).toBe(0);
    expect(prePush('master', oldHead).status).toBe(0);
  });

  it('reports missing or dangling default evidence instead of assuming main', () => {
    expect(prePush('master').status).toBe(1);
    expect(agentPush('git push origin master').status).toBe(2);
    git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/absent'], env);
    expect(prePush('master').status).toBe(1);
  });
});
