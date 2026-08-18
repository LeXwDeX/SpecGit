import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { discoverRepoRoot } from '../../src/record/root.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'specgit-cli-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('specgit root resolution seam (real git)', () => {
  it('resolves the repository toplevel from inside a git repository', async () => {
    const dir = await makeTempDir();
    await execFileAsync('git', ['init', '-q', dir]);
    const result = await discoverRepoRoot(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(await realpath(dir));
    }
  });

  it('resolves the toplevel from a nested subdirectory', async () => {
    const dir = await makeTempDir();
    await execFileAsync('git', ['init', '-q', dir]);
    const nested = path.join(dir, 'a', 'b');
    await mkdir(nested, { recursive: true });
    const result = await discoverRepoRoot(nested);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(await realpath(dir));
    }
  });

  it('fails closed with not_a_git_repo outside a repository', async () => {
    const dir = await makeTempDir();
    const result = await discoverRepoRoot(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_a_git_repo');
    }
  });
});
