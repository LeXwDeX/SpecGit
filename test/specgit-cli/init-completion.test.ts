import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../../src/cli/commands/init.js';
import { inspectGeneratedAssets } from '../../src/cli/asset-drift.js';
import { COMPLETION_WORKFLOW_PATH, GITLAB_COMPLETION_WORKFLOW_PATH } from '../../src/cli/completion-workflow.js';
import { fail, ok } from '../../src/kernel/evidence.js';
import { parseRepoRef } from '../../src/gitfacts/origin.js';
import { makeCtx, makeGitFacts } from './helpers.js';
import { makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';

describe('configured completion installation', () => {
  let root: string;
  beforeEach(() => { root = makeTempDir('specgit-init-completion-'); });
  afterEach(() => { rmDir(root); });
  const options = { requiredCheck: ['test'], protect: false, automation: 'yes', mergeTarget: 'Dev' };
  it.each([null, '.gitlab-ci.yml', 'ci/custom.yml'])('proves GitLab ci_config_path %j before writing on a fresh custom host', async (configuration) => {
    fs.writeFileSync(path.join(root, '.gitlab-ci.yml'), 'test:\n  script: echo test\n');
    const t = makeCtx({ root: ok(root), facts: makeGitFacts({ originUrl: 'https://git.example.com:8443/owner/repo.git' }) });
    const getCiConfigPath = vi.fn(async () => {
      expect(fs.readdirSync(root)).toEqual(['.gitlab-ci.yml']);
      return ok(configuration);
    });
    Object.assign(t.ghProvider, { getCiConfigPath });
    t.ctx.withGitlabHost = vi.fn((gitlabHost) => ({
      parseRepoRef: (origin: string) => parseRepoRef(origin, { gitlabHost }), gh: t.ghProvider,
    }));
    const outcome = await runInit({ ...options, gitlabHost: 'git.example.com:8443' }, t.ctx);
    expect(outcome.exit).toBe(configuration === 'ci/custom.yml' ? 2 : 0);
    expect(getCiConfigPath).toHaveBeenCalledOnce();
    expect(t.ctx.withGitlabHost).toHaveBeenCalledWith('git.example.com:8443');
    if (outcome.exit !== 0) {
      expect(outcome.errors?.[0]?.code).toBe('gitlab_ci_config_unsupported');
      expect(fs.readdirSync(root)).toEqual(['.gitlab-ci.yml']);
      expect(t.recordPort.policyWrites).toEqual([]);
    }
  });
  it.each(['github', 'gitlab'] as const)('installs %s completion only with configured authorization and refreshes by the same desired state', async (platform) => {
    const facts = makeGitFacts({ originUrl: platform === 'github' ? 'git@github.com:owner/repo.git' : 'git@gitlab.com:owner/repo.git' });
    const t = makeCtx({ root: ok(root), facts, gitWrites: { remoteDefaultBranch: () => ok('trunk') },
      parseRepoRef: (url) => parseRepoRef(url, { gitlabHost: 'gitlab.com' }),
    });
    const getCiConfigPath = vi.fn(async () => ok(null));
    Object.assign(t.ghProvider, { getCiConfigPath });
    const result = await runInit(options, t.ctx);
    expect(result.exit).toBe(0);
    const location = platform === 'github' ? COMPLETION_WORKFLOW_PATH : GITLAB_COMPLETION_WORKFLOW_PATH;
    expect(result.reconciled?.created).toContain(location);
    const bytes = fs.readFileSync(path.join(root, location), 'utf8');
    expect(bytes).toContain('trunk');
    expect(bytes).toContain(`specgit@${t.ctx.version}`);
    expect(bytes).toContain('remote-entry.js');
    const report = await inspectGeneratedAssets({ root, ctx: t.ctx, facts, policy: ok(result.policy!) });
    expect(getCiConfigPath).toHaveBeenCalledTimes(platform === 'gitlab' ? 1 : 0);
    expect(report.surfaces.find((surface) => surface.surface === 'init')?.assets)
      .toContainEqual({ path: location, state: 'current' });
    const refresh = makeCtx({ root: ok(root), facts, policy: result.policy!, gitWrites: { remoteDefaultBranch: () => ok('trunk') } });
    const disabled = await runInit({ force: true, protect: false, automation: 'no' }, refresh.ctx);
    expect(disabled.exit).toBe(0);
    expect(disabled.reconciled?.removed).toContain(location);
    expect(fs.existsSync(path.join(root, location))).toBe(false);
  });

  it('rejects an unproven default branch before writes even when the merge target is explicit', async () => {
    const t = makeCtx({ root: ok(root), gitWrites: {
      remoteDefaultBranch: () => fail('git_default_branch_unknown', 'No origin HEAD'),
    } });
    const result = await runInit(options, t.ctx);
    expect(result.exit).toBe(3);
    expect(result.errors?.[0]?.code).toBe('automation_default_branch_unknown');
    expect(fs.readdirSync(root)).toEqual([]);
    expect(t.recordPort.policyWrites).toEqual([]);
  });

  it('preserves an unowned completion workflow and refuses an authorized collision before writes', async () => {
    const target = path.join(root, COMPLETION_WORKFLOW_PATH);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'name: User completion\n');
    const t = makeCtx({ root: ok(root) });
    const refused = await runInit(options, t.ctx);
    expect(refused.exit).toBe(3);
    expect(t.recordPort.policyWrites).toEqual([]);
    expect(fs.readFileSync(target, 'utf8')).toBe('name: User completion\n');
    const disabled = await runInit({ ...options, automation: 'no' }, t.ctx);
    expect(disabled.exit).toBe(0);
    expect(disabled.reconciled?.preserved).toContain(COMPLETION_WORKFLOW_PATH);
    expect(fs.readFileSync(target, 'utf8')).toBe('name: User completion\n');
  });
});
