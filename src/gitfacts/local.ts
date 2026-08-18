import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';

import type { GitFacts, GitPort, SpawnFn } from './port.js';

export type { SpawnFn, SpawnOptions } from './port.js';

const execFileAsync = promisify(execFile);

const GIT_PROBE_TIMEOUT_MS = 10_000;
const GIT_PROBE_MAX_BUFFER = 1024 * 1024;

const defaultSpawn: SpawnFn = async (command, args, options) => {
  const { stdout, stderr } = await execFileAsync(command, args, {
    timeout: options.timeoutMs,
    maxBuffer: options.maxBuffer,
    env: options.env,
    cwd: options.cwd,
    encoding: 'utf-8',
  });
  return { stdout, stderr };
};

function isSpawnNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

export interface LocalGitAdapterOptions {
  env?: NodeJS.ProcessEnv;
  spawnImpl?: SpawnFn;
}

/**
 * Read-only local git facts. Every probe is null-on-failure; the adapter
 * never writes to git and never touches the network.
 */
export class LocalGitAdapter implements GitPort {
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly spawn: SpawnFn;

  constructor(options: LocalGitAdapterOptions = {}) {
    this.env = options.env;
    this.spawn = options.spawnImpl ?? defaultSpawn;
  }

  async facts(root: string): Promise<GitFacts> {
    let gitAvailable = true;

    const probe = async (args: string[]): Promise<string | null> => {
      try {
        const { stdout } = await this.spawn('git', ['-C', root, ...args], {
          timeoutMs: GIT_PROBE_TIMEOUT_MS,
          maxBuffer: GIT_PROBE_MAX_BUFFER,
          env: this.env,
        });
        return stdout;
      } catch (error) {
        if (isSpawnNotFoundError(error)) {
          gitAvailable = false;
        }
        return null;
      }
    };

    const empty: GitFacts = {
      repo: false,
      toplevel: null,
      branch: null,
      headSha: null,
      dirty: null,
      isLinkedWorktree: null,
      worktreeLabel: null,
      worktrees: [],
      originUrl: null,
      upstreamDrift: null,
      gitAvailable,
    };

    const toplevel = (await probe(['rev-parse', '--show-toplevel']))?.trim();
    if (!toplevel) {
      return { ...empty, gitAvailable };
    }

    const branch = (await probe(['symbolic-ref', '--quiet', '--short', 'HEAD']))?.trim() || null;
    const headSha = (await probe(['rev-parse', 'HEAD']))?.trim() || null;

    const status = await probe(['status', '--porcelain']);
    const dirty = status === null ? null : status.trim().length > 0;

    const absoluteGitDir = (await probe(['rev-parse', '--absolute-git-dir']))?.trim() || null;
    const commonDir = (await probe(['rev-parse', '--git-common-dir']))?.trim() || null;
    let isLinkedWorktree: boolean | null = null;
    if (absoluteGitDir && commonDir) {
      const resolvedCommon = path.isAbsolute(commonDir)
        ? path.resolve(commonDir)
        : path.resolve(toplevel, commonDir);
      isLinkedWorktree = path.resolve(absoluteGitDir) !== resolvedCommon;
    }
    const worktreeLabel = isLinkedWorktree ? path.basename(toplevel) : null;

    const worktrees = await this.listWorktrees(probe);

    const originUrl = (await probe(['remote', 'get-url', 'origin']))?.trim() || null;

    const upstreamDrift = await this.trackingDrift(probe);

    return {
      repo: true,
      toplevel,
      branch,
      headSha,
      dirty,
      isLinkedWorktree,
      worktreeLabel,
      worktrees,
      originUrl,
      upstreamDrift,
      gitAvailable,
    };
  }

  private async listWorktrees(
    probe: (args: string[]) => Promise<string | null>
  ): Promise<Array<{ label: string; branch: string | null }>> {
    const raw = await probe(['worktree', 'list', '--porcelain']);
    if (raw === null) return [];

    const worktrees: Array<{ label: string; branch: string | null }> = [];
    let currentPath: string | null = null;
    let currentBranch: string | null = null;

    const flush = () => {
      if (currentPath !== null) {
        worktrees.push({ label: path.basename(currentPath), branch: currentBranch });
      }
      currentPath = null;
      currentBranch = null;
    };

    for (const line of raw.split('\n')) {
      if (line.startsWith('worktree ')) {
        flush();
        currentPath = line.slice('worktree '.length).trim();
      } else if (line.startsWith('branch ')) {
        currentBranch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
      } else if (line.trim() === 'detached') {
        currentBranch = null;
      }
    }
    flush();

    return worktrees;
  }

  private async trackingDrift(
    probe: (args: string[]) => Promise<string | null>
  ): Promise<{ ahead: number; behind: number } | null> {
    const raw = await probe(['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
    if (raw === null) return null;
    const match = raw.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) return null;
    return { behind: Number(match[1]), ahead: Number(match[2]) };
  }
}
