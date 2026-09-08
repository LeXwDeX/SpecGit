import { describe, expect, it } from 'vitest';
import { ReuseProfileSchema, reuseEnvironment } from '../../src/verification/reuse-profile.js';

const profile = {
  id: 'linux', check: 'Test (linux)', max_age_seconds: 3600,
  node: '20.19.0', pnpm: '9.15.9',
  runtime: { package: 'specgit@1.15.1', lockfile: 'ci/runtime-lock.json' },
  commands: [['pnpm', 'test']], fresh_commands: [['node', 'ci/current.mjs']],
  environment: { VITEST_MAX_WORKERS: '4' },
  github: { runner: 'ubuntu-24.04', entry: '.github/workflows/reuse-linux.yml' },
};

describe('explicit verification reuse profiles', () => {
  it('accepts a pinned verification recipe while keeping current checks separate', () => {
    expect(ReuseProfileSchema.safeParse(profile).success).toBe(true);
  });

  it.each([
    { max_age_seconds: 86401 }, { max_age_seconds: 0 }, { node: 'latest' }, { pnpm: '^9' },
    { runtime: { package: 'specgit@latest' } }, { commands: [] }, { commands: ['pnpm test'] },
    { commands: [['sh', '-c', 'echo command interpolation']] },
    { environment: { CI_COMMIT_SHA: 'fake' } }, { environment: { NODE_OPTIONS: '--require ./other.cjs' } },
    { environment: { PATH: '/changed' } }, { environment: { GITHUB_TOKEN: 'not-a-real-token' } },
    { github: { runner: 'ubuntu-latest', entry: '../outside.yml' } },
    { gitlab: { image: 'node:latest', entry: '.gitlab-ci.yml', tags: [] } },
    { check: 'SpecGit Acceptance' }, { deploy: true },
  ])('rejects ambiguous or unpinned execution configuration: %j', (change) => {
    expect(ReuseProfileSchema.safeParse({ ...profile, ...change }).success).toBe(false);
  });

  it.each(['.specgit.yaml', 'spec_git/policy.yaml', 'spec_git/providers.yaml',
    'spec_git/scopes/programme.yaml', '.agents/config.yml', '.specgit-runtime/ci.yml'])
  ('refuses a generated workflow at authoritative or local integration path %s', (entry) => {
    expect(ReuseProfileSchema.safeParse({ ...profile,
      gitlab: { image: 'node@sha256:' + 'a'.repeat(64), entry, tags: [] },
    }).success).toBe(false);
  });

  it('refuses a workflow that overwrites its own runtime inputs', () => {
    expect(ReuseProfileSchema.safeParse({ ...profile,
      runtime: { ...profile.runtime, lockfile: profile.github.entry },
    }).success).toBe(false);
  });

  it.each(['workflow', 'stages', 'variables', 'include', 'default', 'image', 'services',
    'before_script', 'after_script', 'cache', 'types', 'spec', '.hidden'])
  ('refuses the non-executable GitLab job name %s', (check) => {
    expect(ReuseProfileSchema.safeParse({ ...profile, check,
      gitlab: { image: 'node@sha256:' + 'a'.repeat(64), entry: '.gitlab-ci.yml', tags: [] },
    }).success).toBe(false);
  });

  it.each(['SpecGit prepare / linux', 'SpecGit dispatch / linux',
    'SpecGit original / linux / ' + 'a'.repeat(64), 'SpecGit reused / linux',
    'SpecGit uncached / linux', 'SpecGit not applicable / linux', 'Test\n(other)'])
  ('refuses a native producer name or control character in the public check: %s', (check) => {
    expect(ReuseProfileSchema.safeParse({ ...profile, check }).success).toBe(false);
  });

  it('keeps GitLab keyword restrictions local to GitLab integrations', () => {
    expect(ReuseProfileSchema.safeParse({ ...profile, check: 'workflow' }).success).toBe(true);
  });

  it('binds actual runtime and native runner identity and refuses unknown environments', () => {
    const parsed = ReuseProfileSchema.parse(profile);
    const facts = { platform: 'linux', arch: 'x64', node: '20.19.0', pnpm: '9.15.9', image: 'ubuntu24', imageVersion: '20260906.1.0', git: 'git version 2.49.0', systemDigest: 'c'.repeat(64) };
    const first = reuseEnvironment(parsed, 'github', facts);
    expect(first.ok).toBe(true);
    const changed = reuseEnvironment(parsed, 'github', { ...facts, imageVersion: '20260907.1.0' });
    expect(changed.ok && first.ok && changed.value.digest !== first.value.digest).toBe(true);
    expect(reuseEnvironment(parsed, 'github', { ...facts, imageVersion: '' }).ok).toBe(false);
    expect(reuseEnvironment(parsed, 'github', { ...facts, node: '22.0.0' }).ok).toBe(false);
    expect(reuseEnvironment(parsed, 'github', { ...facts, image: 'windows2025' }).ok).toBe(false);
  });

  it('requires the exact GitLab image digest and platform', () => {
    const image = 'node@sha256:' + 'a'.repeat(64);
    const parsed = ReuseProfileSchema.parse({ ...profile, gitlab: { image, entry: '.gitlab-ci.yml', tags: ['runner'] } });
    const facts = { platform: 'linux', arch: 'x64', node: '20.19.0', pnpm: '9.15.9', image, imageVersion: '', git: 'git version 2.49.0', systemDigest: 'c'.repeat(64) };
    expect(reuseEnvironment(parsed, 'gitlab', facts).ok).toBe(true);
    expect(reuseEnvironment(parsed, 'gitlab', { ...facts, image: 'node:20' }).ok).toBe(false);
  });
});
