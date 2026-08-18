import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { fail, ok, type Evidence } from '../kernel/evidence.js';
import type { BranchCheckout, GitFacts, GitPort, SpawnFn } from './port.js';

export type { SpawnFn, SpawnOptions } from './port.js';

const execFileAsync = promisify(execFile);

const GIT_PROBE_TIMEOUT_MS = 10_000;
const GIT_PROBE_MAX_BUFFER = 1024 * 1024;
const GIT_WRITE_TIMEOUT_MS = 60_000;
const GIT_WRITE_MAX_BUFFER = 4 * 1024 * 1024;
const MAX_EMBEDDED_TEXT = 400;

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

/** Git stderr can carry ANSI or hostile bytes; embedded text is stripped and capped. */
function sanitizeGitText(text: string): string {
  const stripped = text
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\u001b./g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  const flat = stripped.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_EMBEDDED_TEXT ? `${flat.slice(0, MAX_EMBEDDED_TEXT)}…` : flat;
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

  async checkoutOrCreateBranch(root: string, branch: string): Promise<Evidence<BranchCheckout>> {
    const create = await this.write('checkout', ['-C', root, 'checkout', '-b', branch]);
    if (create.ok) {
      return ok({ branch, created: true });
    }
    if (/already exists/i.test(create.message)) {
      const checkout = await this.write('checkout', ['-C', root, 'checkout', branch]);
      if (checkout.ok) {
        return ok({ branch, created: false });
      }
      return checkout;
    }
    return create;
  }

  async commitFile(
    root: string,
    relativePath: string,
    message: string
  ): Promise<Evidence<{ committed: boolean }>> {
    const add = await this.write('commit', ['-C', root, 'add', '--', relativePath]);
    if (!add.ok) {
      return add;
    }
    const commit = await this.write('commit', [
      '-C',
      root,
      'commit',
      '-m',
      message,
      '--',
      relativePath,
    ]);
    if (commit.ok) {
      return ok({ committed: true });
    }
    if (/nothing to commit|no changes added/i.test(commit.message)) {
      return ok({ committed: false });
    }
    return commit;
  }

  async pushBranch(root: string, branch: string): Promise<Evidence<{ pushed: boolean }>> {
    const push = await this.write('push', ['-C', root, 'push', '-u', 'origin', branch]);
    return push.ok ? ok({ pushed: true }) : push;
  }

  async remoteDefaultBranch(root: string): Promise<Evidence<string>> {
    const resolved = await this.write('branch', [
      '-C',
      root,
      'rev-parse',
      '--abbrev-ref',
      'origin/HEAD',
    ]);
    if (resolved.ok) {
      const name = resolved.value.trim().replace(/^origin\//, '');
      if (name) {
        return ok(name);
      }
    }
    // origin/HEAD is a local convenience ref and is often unset in fresh
    // clones; `gh` would resolve the default branch server-side. `main`
    // is the documented fallback so PR creation stays deterministic.
    return ok('main');
  }

  /**
   * Runs one write-side git invocation and maps failures to Evidence.
   * `kind` picks the stable diagnostic code (git_checkout_failed, …).
   */
  private write(
    kind: 'checkout' | 'commit' | 'push' | 'branch',
    args: string[]
  ): Promise<Evidence<string>> {
    return this.spawn('git', args, {
      timeoutMs: GIT_WRITE_TIMEOUT_MS,
      maxBuffer: GIT_WRITE_MAX_BUFFER,
      env: this.env,
    }).then(
      (result) => ok(result.stdout),
      (error: unknown) => {
        if (isSpawnNotFoundError(error)) {
          return fail(
            'git_unavailable',
            'The git executable could not be found on PATH.',
            'Install git and ensure it is on PATH.'
          );
        }
        const err = error as { killed?: boolean; stderr?: unknown; message?: unknown };
        if (err.killed) {
          return fail(
            `git_${kind}_failed`,
            `git ${kind} timed out after ${GIT_WRITE_TIMEOUT_MS} ms.`
          );
        }
        const detail =
          (typeof err.stderr === 'string' && err.stderr.trim()) ||
          (error instanceof Error ? error.message : String(error));
        return fail(`git_${kind}_failed`, `git ${kind} failed: ${sanitizeGitText(detail)}`);
      }
    );
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
