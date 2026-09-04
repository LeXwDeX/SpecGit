import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { POLICY_FILENAME, SPEC_GIT_DIR } from '../../src/record/schema.js';
import { PolicySchema } from '../../src/record/policy.js';
import { readPolicy, writePolicy } from '../../src/record/io.js';
import { makeTempDir, rmDir } from './helpers/temp-repo.js';

describe('policy io', () => {
  let tempDir: string;
  let root: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-policy-');
    root = path.join(tempDir, 'repo');
    fs.mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  const policyPath = () => path.join(root, SPEC_GIT_DIR, POLICY_FILENAME);

  it('fails closed with policy_missing when the file is absent', async () => {
    const read = await readPolicy(root);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe('policy_missing');
  });

  it('round-trips a valid policy', async () => {
    await writePolicy(root, { version: 1, required_checks: ['All checks passed'] });
    const read = await readPolicy(root);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.required_checks).toEqual(['All checks passed']);
    expect(read.value.ordered_issues).toBeUndefined();
  });

  it('round-trips an explicitly authorized merge target and issue closure', async () => {
    const policy = {
      version: 1 as const,
      required_checks: ['All checks passed'],
      automation: { merge: true, target_branch: 'main', close_issues: true },
    };
    await writePolicy(root, policy);
    expect(await readPolicy(root)).toEqual({ ok: true, value: policy });
  });

  it('round-trips ordered_issues: true', async () => {
    fs.mkdirSync(path.dirname(policyPath()), { recursive: true });
    fs.writeFileSync(
      policyPath(),
      'version: 1\nrequired_checks: [a]\nordered_issues: true\n'
    );
    const read = await readPolicy(root);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.ordered_issues).toBe(true);
  });

  it('rejects a non-boolean ordered_issues', async () => {
    fs.mkdirSync(path.dirname(policyPath()), { recursive: true });
    fs.writeFileSync(
      policyPath(),
      'version: 1\nrequired_checks: [a]\nordered_issues: yes-please\n'
    );
    const read = await readPolicy(root);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe('policy_invalid');
  });

  it('accepts an empty required_checks list (no-CI policy, #63)', async () => {
    fs.mkdirSync(path.dirname(policyPath()), { recursive: true });
    fs.writeFileSync(policyPath(), 'version: 1\nrequired_checks: []\n');
    const read = await readPolicy(root);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.required_checks).toEqual([]);
  });

  it('rejects unknown keys (strict schema)', async () => {
    fs.mkdirSync(path.dirname(policyPath()), { recursive: true });
    fs.writeFileSync(policyPath(), 'version: 1\nrequired_checks: [a]\nextra: 1\n');
    const read = await readPolicy(root);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe('policy_invalid');
  });

  it('rejects corrupt YAML and wrong version', async () => {
    fs.mkdirSync(path.dirname(policyPath()), { recursive: true });
    fs.writeFileSync(policyPath(), '[unclosed flow sequence\n');
    expect((await readPolicy(root)).ok).toBe(false);
    fs.writeFileSync(policyPath(), 'version: 2\nrequired_checks: [a]\n');
    const second = await readPolicy(root);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('policy_invalid');
  });

  it('round-trips language: zh (#118) and defaults to absent', async () => {
    await writePolicy(root, { version: 1, required_checks: ['Test'], language: 'zh' });
    const read = await readPolicy(root);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.language).toBe('zh');
  });

  it('rejects an unsupported language value (fail closed, strict schema)', async () => {
    fs.mkdirSync(path.dirname(policyPath()), { recursive: true });
    fs.writeFileSync(
      policyPath(),
      'version: 1\nrequired_checks: [a]\nlanguage: fr\n'
    );
    const read = await readPolicy(root);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe('policy_invalid');
  });
});

describe('policy automation authorization', () => {
  const parse = (automation?: unknown) => PolicySchema.safeParse({
    version: 1,
    required_checks: [],
    ...(automation === undefined ? {} : { automation }),
  });

  it('does not introduce automation when the section is absent', () => {
    expect(parse()).toEqual({ success: true, data: { version: 1, required_checks: [] } });
  });

  it.each([
    { merge: false },
    { merge: false, close_issues: false },
    { merge: true, target_branch: 'main' },
    { merge: true, target_branch: 'release/1.2', close_issues: true },
    { merge: true, target_branch: '发布/稳定版', close_issues: false },
  ])('preserves valid explicit configuration %j', (automation) => {
    expect(parse(automation)).toEqual({
      success: true,
      data: { version: 1, required_checks: [], automation },
    });
  });

  it.each([
    {},
    { merge: 'true', target_branch: 'main' },
    { merge: true },
    { merge: true, target_branch: '' },
    { merge: false, close_issues: true },
    { close_issues: true, target_branch: 'main' },
    { merge: true, target_branch: 'main', close_issues: 'true' },
    { merge: true, target_branch: 'main', bypass_checks: true },
  ])('rejects incomplete or contradictory authorization %j', (automation) => {
    expect(parse(automation).success).toBe(false);
  });

  it.each([
    '--all', '-main', 'HEAD', '@', 'refs/heads/main', 'main~1', 'main^',
    'main:other', 'feature?x', 'feature*', 'feature[x', 'feature\\x',
    '/main', 'main/', 'feature//main', '.hidden', 'feature/.hidden',
    'main.', 'main.lock', 'feature.lock/main', 'main..old', 'main@{1}',
    'main branch', ' main', 'main\n', 'main\tbranch', 'main\u0000',
    'main\u007f', 'main\u202eother',
  ])('rejects unsafe target branch %j', (target_branch) => {
    expect(parse({ merge: true, target_branch }).success).toBe(false);
  });
});
