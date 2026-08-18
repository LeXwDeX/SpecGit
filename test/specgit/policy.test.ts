import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { POLICY_FILENAME, SPEC_GIT_DIR } from '../../src/record/schema.js';
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
  });

  it('rejects an empty required_checks list', async () => {
    fs.mkdirSync(path.dirname(policyPath()), { recursive: true });
    fs.writeFileSync(policyPath(), 'version: 1\nrequired_checks: []\n');
    const read = await readPolicy(root);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe('policy_invalid');
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
});
