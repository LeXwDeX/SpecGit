import { describe, expect, it } from 'vitest';

import type {
  SpawnFn as KernelSpawnFn,
  SpawnOptions as KernelSpawnOptions,
} from '../../src/kernel/spawn.js';
import type {
  SpawnFn as GitSpawnFn,
  SpawnOptions as GitSpawnOptions,
} from '../../src/gitfacts/port.js';
import type { SpawnFn as LocalSpawnFn } from '../../src/gitfacts/local.js';
import type {
  SpawnFn as ProviderSpawnFn,
  SpawnOptions as ProviderSpawnOptions,
} from '../../src/providers/cli-spawn.js';
import type { SpawnFn as GhSpawnFn } from '../../src/providers/github/gh-cli.js';
import { defaultSpawn } from '../../src/providers/cli-spawn.js';

/**
 * Shape lock for #185: both subprocess seams (local git facts and the
 * forge CLI providers) must consume exactly the kernel spawn contract, so
 * one test double can satisfy both and the transports cannot drift. The
 * assertions below fail compilation — not just the test run — when any
 * seam grows a divergent definition.
 */
describe('kernel spawn contract (#185)', () => {
  /** Bidirectional assignability: two type slots holding the same contract. */
  type SameShape<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

  it('the gitfacts seam is the kernel contract', () => {
    const fnLock: SameShape<GitSpawnFn, KernelSpawnFn> = true;
    const optionsLock: SameShape<GitSpawnOptions, KernelSpawnOptions> = true;
    const localLock: SameShape<LocalSpawnFn, KernelSpawnFn> = true;
    expect(fnLock).toBe(true);
    expect(optionsLock).toBe(true);
    expect(localLock).toBe(true);
  });

  it('the provider seam is the kernel contract', () => {
    const fnLock: SameShape<ProviderSpawnFn, KernelSpawnFn> = true;
    const optionsLock: SameShape<ProviderSpawnOptions, KernelSpawnOptions> = true;
    const ghLock: SameShape<GhSpawnFn, KernelSpawnFn> = true;
    expect(fnLock).toBe(true);
    expect(optionsLock).toBe(true);
    expect(ghLock).toBe(true);
  });

  it('a single test double satisfies both seams', () => {
    const calls: string[] = [];
    const double: KernelSpawnFn = async (command) => {
      calls.push(command);
      return { stdout: '', stderr: '' };
    };
    const asGitSeam: GitSpawnFn = double;
    const asProviderSeam: ProviderSpawnFn = double;
    void asGitSeam;
    void asProviderSeam;
    expect(typeof double).toBe('function');
    // The shipped provider transport honors the same contract.
    const shipped: KernelSpawnFn = defaultSpawn;
    expect(typeof shipped).toBe('function');
    expect(calls).toEqual([]);
  });
});
