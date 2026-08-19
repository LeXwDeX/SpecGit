import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SPEC_GIT_DIR } from '../../src/record/schema.js';
import { readProviders, writeProviders, providersPath } from '../../src/record/io.js';
import { makeTempDir, rmDir } from './helpers/temp-repo.js';

describe('providers io', () => {
  let tempDir: string;
  let root: string;

  beforeEach(() => {
    tempDir = makeTempDir('specgit-providers-');
    root = path.join(tempDir, 'repo');
    fs.mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmDir(tempDir);
  });

  const filePath = () => providersPath(root);

  it('providers_missing when the file is absent', async () => {
    const read = await readProviders(root);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe('providers_missing');
  });

  it('round-trips a gitlab host with insecure ssl', async () => {
    await writeProviders(root, {
      gitlab: { host: 'git.ycgame.com', insecure_ssl: true },
    });
    const read = await readProviders(root);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.gitlab).toEqual({ host: 'git.ycgame.com', insecure_ssl: true });
    expect(fs.existsSync(path.join(root, SPEC_GIT_DIR, 'providers.yaml'))).toBe(true);
  });

  it('accepts gitlab host without insecure_ssl (defaults false)', async () => {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), 'gitlab:\n  host: git.example.com\n');
    const read = await readProviders(root);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.gitlab).toEqual({ host: 'git.example.com', insecure_ssl: false });
  });

  it('rejects invalid shapes (strict schema)', async () => {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), 'gitlab:\n  host: 42\n');
    const read = await readProviders(root);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe('providers_invalid');
  });

  it('rejects a scheme or slash inside the host (bare hostname only)', async () => {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), 'gitlab:\n  host: https://git.example.com/\n');
    const read = await readProviders(root);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.code).toBe('providers_invalid');
  });
});
