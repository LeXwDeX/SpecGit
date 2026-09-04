import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runInit } from '../../src/cli/commands/init.js';
import { runSetup } from '../../src/cli/commands/setup.js';
import { detectInitInputs } from '../../src/cli/detect-checks.js';
import { parseRepoRef } from '../../src/gitfacts/origin.js';
import { makeCtx, makeGitFacts } from './helpers.js';
import { makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';

vi.mock('@inquirer/prompts', () => ({ select: vi.fn(async () => 'gitlab') }));

describe('init audit: usable platform checks and onboarding', () => {
  let root: string;
  beforeEach(() => { root = makeTempDir('specgit-init-audit-'); });
  afterEach(() => { rmDir(root); });

  function write(name: string, content: string): void {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  it('detects only executable GitLab job names, including pages', async () => {
    write('.gitlab-ci.yml', '.template:\n  script: echo test\nreal-test:\n  extends: .template\npages:\n  script: echo pages\n');
    const result = await detectInitInputs(root, 'git@gitlab.com:team/app.git');
    expect(result.requiredChecks).toEqual(['real-test', 'pages']);
  });

  it('selects the origin platform when both CI configurations exist', async () => {
    write('.github/workflows/ci.yml', 'on: pull_request\njobs:\n  github-only:\n    runs-on: ubuntu-latest\n');
    write('.gitlab-ci.yml', 'gitlab-only:\n  script: echo test\n');
    expect((await detectInitInputs(root, 'git@gitlab.com:team/app.git')).requiredChecks).toEqual(['gitlab-only']);
    expect((await detectInitInputs(root, 'git@github.com:team/app.git')).requiredChecks).toEqual(['github-only']);
  });

  it('uses a new self-managed declaration before detecting CI names', async () => {
    write('.github/workflows/ci.yml', 'on: pull_request\njobs:\n  github-only:\n    runs-on: ubuntu-latest\n');
    write('.gitlab-ci.yml', 'gitlab-only:\n  script: echo test\n');
    const t = makeCtx({ root: { ok: true, value: root }, facts: makeGitFacts({ originUrl: 'git@git.example.com:team/app.git' }) });
    const result = await runInit({ gitlabHost: 'git.example.com', protect: false }, t.ctx);
    expect(result.exit).toBe(0);
    expect(result.policy?.required_checks).toEqual(['gitlab-only']);
  });

  it.each(['github', 'gitlab'] as const)('uses the interactive %s choice for dual-platform CI detection', async (mode) => {
    write('.github/workflows/ci.yml', 'on: pull_request\njobs:\n  github-only:\n    runs-on: ubuntu-latest\n');
    write('.gitlab-ci.yml', 'gitlab-only:\n  script: echo test\n');
    const t = makeCtx({ root: { ok: true, value: root }, stdinIsTTY: true,
      facts: makeGitFacts({ originUrl: 'https://git.example.com:8443/team/app.git' }) });
    const selectPlatform = vi.fn(async () => mode);
    const result = await runInit({ protect: false, automation: 'no' }, t.ctx, { selectPlatform });
    expect(result.exit).toBe(0);
    expect(result.platform?.mode).toBe(mode);
    expect(result.policy?.required_checks).toEqual([`${mode}-only`]);
    expect(selectPlatform).toHaveBeenCalledExactlyOnceWith('git.example.com:8443');
  });

  it('uses the first platform choice for project labels without persisting before selection', async () => {
    const t = makeCtx({ root: { ok: true, value: root }, stdinIsTTY: true,
      facts: makeGitFacts({ originUrl: 'https://git.example.com:8443/team/app.git' }) });
    t.ctx.withGitlabHost = vi.fn((gitlabHost) => ({
      parseRepoRef: (origin: string) => parseRepoRef(origin, { gitlabHost }), gh: t.ghProvider,
    }));
    const answers = ['en', 'yes', 'project'];
    const selectLabels = vi.fn(async (names: string[]) => {
      expect(fs.readdirSync(root)).toEqual([]);
      expect(names).toContain('kind::fix');
      return ['kind::fix'];
    });
    const result = await runInit({ configureRules: true, protect: false, automation: 'no' }, t.ctx, {
      selectPlatform: async () => 'gitlab', selectRule: async () => answers.shift()!, selectLabels,
    });
    expect(result.exit).toBe(0);
    expect(selectLabels).toHaveBeenCalledOnce();
    expect(t.ctx.withGitlabHost).toHaveBeenCalledExactlyOnceWith('git.example.com:8443');
    expect(result.policy?.tags).toEqual([{ name: 'kind::fix' }]);
  });

  it('leaves no writes when a later automation answer is invalid after choosing GitLab', async () => {
    const t = makeCtx({ root: { ok: true, value: root }, stdinIsTTY: true,
      facts: makeGitFacts({ originUrl: 'git@git.example.com:team/app.git' }) });
    const selectPlatform = vi.fn(async () => 'gitlab' as const);
    const result = await runInit({ protect: false }, t.ctx, {
      selectPlatform, promptAutomation: async () => 'invalid',
    });
    expect(result.exit).toBe(2);
    expect(selectPlatform).toHaveBeenCalledOnce();
    expect(t.recordPort.policyWrites).toEqual([]);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('leaves no writes when the platform question is canceled', async () => {
    const t = makeCtx({ root: { ok: true, value: root }, stdinIsTTY: true,
      facts: makeGitFacts({ originUrl: 'git@git.example.com:team/app.git' }) });
    const interrupted = Object.assign(new Error('Interrupted.'), { name: 'ExitPromptError' });
    await expect(runInit({ protect: false, automation: 'no' }, t.ctx, {
      selectPlatform: async () => { throw interrupted; },
    })).rejects.toBe(interrupted);
    expect(t.recordPort.policyWrites).toEqual([]);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it.each([{ detect: false }, { requiredCheck: [' '] }])('refuses invalid explicit check inputs without a platform prompt: %j', async (options) => {
    const t = makeCtx({ root: { ok: true, value: root }, stdinIsTTY: true,
      facts: makeGitFacts({ originUrl: 'git@git.example.com:team/app.git' }) });
    const selectPlatform = vi.fn(async () => 'gitlab' as const);
    const result = await runInit({ ...options, protect: false, automation: 'no' }, t.ctx, { selectPlatform });
    expect(result.exit).toBe(2);
    expect(selectPlatform).not.toHaveBeenCalled();
    expect(t.recordPort.policyWrites).toEqual([]);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('rejects declaring github.com as GitLab before generating files', async () => {
    const t = makeCtx({ root: { ok: true, value: root } });
    const result = await runInit({ gitlabHost: 'github.com', protect: false }, t.ctx);
    expect(result.exit).toBe(2);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('does not require target-only or trigger-less GitHub workflow jobs', async () => {
    write('.github/workflows/target.yml', 'on: pull_request_target\njobs:\n  target:\n    runs-on: ubuntu-latest\n');
    write('.github/workflows/missing.yml', 'jobs:\n  invalid:\n    runs-on: ubuntu-latest\n');
    const result = await detectInitInputs(root, 'git@github.com:team/app.git');
    expect(result.requiredChecks).toEqual([]);
    expect(result.nonPrWorkflows).toEqual(['.github/workflows/missing.yml', '.github/workflows/target.yml']);
  });

  it('installs portable skills after fresh init created only OpenCode guard assets', async () => {
    const t = makeCtx({ root: { ok: true, value: root } });
    expect((await runInit({ protect: false }, t.ctx)).exit).toBe(0);
    const setup = await runSetup({}, t.ctx);
    expect(setup.assets?.tool).toBe('generic');
    expect(fs.existsSync(path.join(root, '.agents/skills/specgit-issue/SKILL.md'))).toBe(true);
  });

  it('includes the GitLab declaration in the adoption commit handoff', async () => {
    const t = makeCtx({ root: { ok: true, value: root }, facts: makeGitFacts({ originUrl: 'git@git.example.com:team/app.git' }) });
    const result = await runInit({ gitlabHost: 'git.example.com', protect: false }, t.ctx);
    expect(result.exit).toBe(0);
    expect(result.nextActions?.find((action) => action.code === 'adoption_commit')?.command).toContain('git add -f spec_git/policy.yaml spec_git/providers.yaml');
  });
});
