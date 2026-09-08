import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildReuseAssetSteps, REUSE_ASSET_MANIFEST } from '../../src/cli/reuse-assets.js';
import { reconcileManagedAssets } from '../../src/cli/managed-reconcile.js';
import { ReuseProfileSchema } from '../../src/verification/reuse-profile.js';
import { githubReuseWorkflow, gitlabReuseWorkflow } from '../../src/verification/reuse-workflow.js';
import { GITLAB_BUSINESS_WORKFLOW_PATH, gitlabRoutingWorkflowYaml } from '../../src/cli/completion-workflow.js';
import { completionWorkflowYaml } from '../../src/cli/completion-workflow.js';
import { buildHarnessDesiredState } from '../../src/cli/harness-placement.js';
import { acceptanceScript } from '../../src/cli/acceptance-step.js';
import YAML from 'yaml';

const profile = ReuseProfileSchema.parse({ id: 'linux', check: 'Test (linux)', max_age_seconds: 3600,
  node: '20.19.0', pnpm: '9.15.9', runtime: { package: 'specgit@1.15.1', lockfile: 'ci/runtime-lock.json' },
  commands: [['pnpm', 'test']], fresh_commands: [],
  github: { runner: 'ubuntu-24.04', entry: '.github/workflows/reuse-linux.yml' },
  gitlab: { image: 'node@sha256:' + 'a'.repeat(64), entry: '.gitlab-ci.yml', tags: [] },
});

describe('derived verification workflow lifecycle', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'specgit-reuse-assets-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const apply = async (platform: 'github' | 'gitlab', profiles = [profile], routingYaml: string | null = null) =>
    reconcileManagedAssets(root, { steps: await buildReuseAssetSteps(root, { platform, profiles, routingYaml }) });

  it('creates the selected platform only, refreshes drift, and retires a removed profile', async () => {
    await apply('github');
    const target = path.join(root, profile.github!.entry);
    expect(await readFile(target, 'utf8')).toBe(githubReuseWorkflow(profile));
    await writeFile(target, githubReuseWorkflow(profile) + '# drift\n');
    await apply('github');
    expect(await readFile(target, 'utf8')).toBe(githubReuseWorkflow(profile));
    const report = await apply('github', []);
    expect(report.removed).toContain(profile.github!.entry);
    await expect(readFile(path.join(root, REUSE_ASSET_MANIFEST))).rejects.toThrow();
  });

  it('refuses an existing business workflow without changing it', async () => {
    await writeFile(path.join(root, '.gitlab-ci.yml'), 'deploy: {script: ship}\n');
    await expect(apply('gitlab')).rejects.toThrow(/owned|conflict|preserv/i);
    expect(await readFile(path.join(root, '.gitlab-ci.yml'), 'utf8')).toBe('deploy: {script: ship}\n');
  });

  it.each(['off', 'close-only', 'merge'] as const)
  ('installs independent GitLab acceptance with automation %s', async (mode) => {
    const input = { platform: 'gitlab' as const, selfHosted: false, defaultBranch: 'main', version: '1.15.1', targetBranch: 'preview' };
    const completion = mode === 'off' ? null : { platform: 'gitlab' as const, defaultBranch: 'main',
      yaml: completionWorkflowYaml(input), routingYaml: gitlabRoutingWorkflowYaml(input),
    };
    const policy = { automation: { merge: mode === 'merge', close_issues: mode !== 'off', target_branch: 'preview' } };
    const desired = await buildHarnessDesiredState(root, { platform: 'gitlab', workflowYaml: null,
      reuseProfiles: [profile], completion: policy.automation.merge || policy.automation.close_issues ? completion : null,
    });
    await reconcileManagedAssets(root, { steps: desired.steps });
    expect(await readFile(path.join(root, '.gitlab/specgit-accept.mjs'), 'utf8')).toBe(acceptanceScript());
    const entry = mode === 'off' ? '.gitlab-ci.yml' : GITLAB_BUSINESS_WORKFLOW_PATH;
    const config = YAML.parse(await readFile(path.join(root, entry), 'utf8'));
    expect(config['SpecGit Acceptance'].needs).toEqual([{ job: profile.check, artifacts: false }]);
    expect(config['SpecGit Acceptance'].script.at(-1)).toBe('node .gitlab/specgit-accept.mjs');
    expect(config['SpecGit Acceptance'].allow_failure).toBeUndefined();
  });

  it('composes with completion routing and restores its managed business root when disabled', async () => {
    const router = gitlabRoutingWorkflowYaml({ platform: 'gitlab', selfHosted: false, defaultBranch: 'main', version: '1.15.1', targetBranch: 'preview' });
    await apply('gitlab', [profile], router);
    expect(await readFile(path.join(root, '.gitlab-ci.yml'), 'utf8')).toBe(router);
    expect(await readFile(path.join(root, GITLAB_BUSINESS_WORKFLOW_PATH), 'utf8')).toBe(gitlabReuseWorkflow([profile]));
    await apply('gitlab');
    expect(await readFile(path.join(root, '.gitlab-ci.yml'), 'utf8')).toBe(gitlabReuseWorkflow([profile]));
    await expect(readFile(path.join(root, GITLAB_BUSINESS_WORKFLOW_PATH))).rejects.toThrow();
  });

  it('refuses retirement of authoritative policy even with a copied generated marker', async () => {
    await apply('github');
    const policy = '# Managed by SpecGit: verified-input execution.\nversion: 1\n';
    await writeFile(path.join(root, 'spec_git/policy.yaml'), policy);
    const manifest = JSON.parse(await readFile(path.join(root, REUSE_ASSET_MANIFEST), 'utf8'));
    manifest.paths.push('spec_git/policy.yaml');
    await writeFile(path.join(root, REUSE_ASSET_MANIFEST), JSON.stringify(manifest));
    await expect(apply('github', [])).rejects.toThrow();
    expect(await readFile(path.join(root, 'spec_git/policy.yaml'), 'utf8')).toBe(policy);
  });

  it('never treats a forged manifest path as ownership of user content', async () => {
    await apply('github');
    await mkdir(path.join(root, 'ci'), { recursive: true });
    await writeFile(path.join(root, 'ci/manual.yml'), 'keep: {script: preserve}\n');
    const manifest = JSON.parse(await readFile(path.join(root, REUSE_ASSET_MANIFEST), 'utf8'));
    manifest.paths.push('ci/manual.yml');
    await writeFile(path.join(root, REUSE_ASSET_MANIFEST), JSON.stringify(manifest));
    await apply('github', []);
    expect(await readFile(path.join(root, 'ci/manual.yml'), 'utf8')).toBe('keep: {script: preserve}\n');
  });
});
