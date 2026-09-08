import { describe, expect, it } from 'vitest';
import { PolicySchema } from '../../src/record/policy.js';

describe('approved verification policy', () => {
  const reuse = {
    id: 'linux', check: 'Test (linux)', max_age_seconds: 3600, node: '20.19.0', pnpm: '9.15.9',
    runtime: { package: 'specgit@1.15.1', lockfile: 'ci/runtime-lock.json' }, commands: [['pnpm', 'test']], fresh_commands: [], environment: {},
    github: { runner: 'ubuntu-24.04', entry: '.github/workflows/reuse-linux.yml' },
  };
  it('keeps reuse opt-in and rejects duplicate profile or output identities', () => {
    const policy = { version: 1, required_checks: ['security'], verification: {
      product_checks: ['Test (linux)'], rules: [], reuse: [reuse],
    } };
    expect(PolicySchema.parse(policy)).toEqual(policy);
    for (const second of [reuse, { ...reuse, id: 'other' }, { ...reuse, check: 'other' },
      { ...reuse, id: 'other', check: 'other' }]) {
      expect(PolicySchema.safeParse({ ...policy, verification: { ...policy.verification, reuse: [reuse, second] } }).success).toBe(false);
    }
  });

  it('keeps unconditional checks while declaring a product fallback and explicit path rules', () => {
    const policy = { version: 1, required_checks: ['security'], verification: {
      product_checks: ['build', 'test'],
      rules: [{ paths: ['README.md', 'docs/**'], checks: ['docs'] }],
    } };
    expect(PolicySchema.parse(policy)).toEqual(policy);
    expect(PolicySchema.parse({ version: 1, required_checks: [] })).toEqual({ version: 1, required_checks: [] });
  });

  it.each([
    ...['https://example.com/ci', 'ci.yml@group/project', '../ci', '/ci', 'ci:ref', 'ci%2Fyml', 'ci/**'].map((gitlab_entry) => ({ product_checks: ['build'], rules: [], gitlab_entry })),
    { product_checks: [], rules: [] },
    { product_checks: [' build'], rules: [] },
    { product_checks: ['SpecGit Acceptance'], rules: [] },
    { product_checks: ['build'], rules: [{ paths: ['../src/**'], checks: [] }] },
    { product_checks: ['build'], rules: [{ paths: ['/docs/**'], checks: [] }] },
    { product_checks: ['build'], rules: [{ paths: ['**'], checks: [] }] },
    { product_checks: ['build'], rules: [{ paths: ['docs/**/../src'], checks: [] }] },
    { product_checks: ['build'], rules: [{ paths: ['docs\\**'], checks: [] }] },
    { product_checks: ['build'], rules: [{ paths: ['docs/**'], checks: ['SpecGit Completion'] }] },
    { product_checks: ['build'], rules: [{ paths: [], checks: [] }] },
    { product_checks: ['build'], rules: [], unknown: true },
  ])('rejects unusable or self-waiting declarations: %j', (verification) => {
    expect(PolicySchema.safeParse({ version: 1, required_checks: [], verification }).success).toBe(false);
  });
});
