import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildReuseAssetSteps, REUSE_ASSET_MANIFEST } from '../../src/cli/reuse-assets.js';
import { reconcileManagedAssets } from '../../src/cli/managed-reconcile.js';
import { ReuseProfileSchema } from '../../src/verification/reuse-profile.js';
import { githubReuseWorkflow, gitlabReuseWorkflow } from '../../src/verification/reuse-workflow.js';
import { GITLAB_BUSINESS_WORKFLOW_PATH, gitlabRoutingWorkflowYaml } from '../../src/cli/completion-workflow.js';

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
