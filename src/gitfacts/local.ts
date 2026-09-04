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

/** A full git object id: 40 hex chars (sha1) or 64 (sha256), lowercase. */
const HEX_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

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
 * Local git facts and delivery-scoped writes. Fact probes are read-only
 * and null-on-failure; explicit write methods handle branch, commit and
 * push operations through git.
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

    const toplevel = (await probe(['rev-parse', '--show-toplevel']))?.replace(/\r?\n$/, '');
    if (!toplevel) {
      return { ...empty, gitAvailable };
    }

    const branch = (await probe(['symbolic-ref', '--quiet', '--short', 'HEAD']))?.trim() || null;
    const headSha = (await probe(['rev-parse', 'HEAD']))?.trim() || null;

    const status = await probe(['status', '--porcelain']);
    const dirty = status === null ? null : status.trim().length > 0;

    const absoluteGitDir = (await probe(['rev-parse', '--absolute-git-dir']))?.replace(/\r?\n$/, '') || null;
    const commonDir = (await probe(['rev-parse', '--git-common-dir']))?.replace(/\r?\n$/, '') || null;
    let isLinkedWorktree: boolean | null = null;
    if (absoluteGitDir && commonDir) {
      const resolvedCommon = path.isAbsolute(commonDir)
        ? path.resolve(commonDir)
        : path.resolve(toplevel, commonDir);
      isLinkedWorktree = path.resolve(absoluteGitDir) !== resolvedCommon;
    }
    const worktreeLabel = isLinkedWorktree ? path.basename(toplevel) : null;

    const worktrees = await this.listWorktrees(probe);

    // Raw config value, not `git remote get-url`: url.<x>.insteadOf
    // rewrites apply to the latter, which would mask the GitHub origin
    // this harness binds to.
    const originUrl = (await probe(['config', '--get', 'remote.origin.url']))?.trim() || null;

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
    relativePaths: string[],
    message: string
  ): Promise<Evidence<{ committed: boolean }>> {
    // #292: -f stages past the tool-installed local-asset ignore — the
    // binding commit is the authoritative files' intended entry into git.
    const add = await this.write('commit', ['-C', root, 'add', '-f', '--', ...relativePaths]);
    if (!add.ok) {
      return add;
    }
    // Locale-independent emptiness probe: `git diff --cached --quiet`
    // exits 1 exactly when a path has staged changes. (git's own
    // "nothing to commit" text is localized and must not be parsed.)
    const hasStagedChanges = await this.spawn(
      'git',
      ['-C', root, 'diff', '--cached', '--quiet', '--', ...relativePaths],
      { timeoutMs: GIT_WRITE_TIMEOUT_MS, maxBuffer: GIT_PROBE_MAX_BUFFER, env: this.env }
    ).then(
      () => false,
      () => true
    );
    if (!hasStagedChanges) {
      return ok({ committed: false });
    }
    const commit = await this.write('commit', [
      '-C',
      root,
      'commit',
      '-m',
      message,
      '--',
      ...relativePaths,
    ]);
    if (commit.ok) {
      return ok({ committed: true });
    }
    return commit;
  }

  async pushBranch(root: string, branch: string): Promise<Evidence<{ pushed: boolean }>> {
    const push = await this.write('push', ['-C', root, 'push', '-u', 'origin', branch]);
    return push.ok ? ok({ pushed: true }) : push;
  }

  async remoteDefaultBranch(root: string, options: { requireEvidence?: boolean } = {}): Promise<Evidence<string>> {
    const resolved = await this.write('branch', [
      '-C',
      root,
      'rev-parse',
      '--abbrev-ref',
      'origin/HEAD',
    ]);
    if (resolved.ok) {
      const name = resolved.value.trim().replace(/^origin\//, '');
      if (name && (!options.requireEvidence || (resolved.value.trim().startsWith('origin/') && name !== 'HEAD'))) {
        return ok(name);
      }
    }
    if (options.requireEvidence) {
      return fail(
        'git_default_branch_unknown',
        'The local origin/HEAD does not prove a remote default branch.',
        'Resolve origin/HEAD from the remote, or explicitly choose the intended target branch.'
      );
    }
    // origin/HEAD is a local convenience ref and is often unset in fresh
    // clones; `gh` would resolve the default branch server-side. `main`
    // is the documented fallback so PR creation stays deterministic.
    return ok('main');
  }

  /** #298: which of `paths` the index tracks (`git ls-files --`). */
  async trackedFiles(root: string, paths: string[]): Promise<Evidence<string[]>> {
    if (paths.length === 0) {
      return ok([]);
    }
    try {
      const { stdout } = await this.spawn('git', ['-C', root, 'ls-files', '--', ...paths], {
        timeoutMs: GIT_PROBE_TIMEOUT_MS,
        maxBuffer: GIT_PROBE_MAX_BUFFER,
        env: this.env,
      });
      const listed = new Set(
        stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      );
      // `git ls-files` echoes paths in its own normalized form; match the
      // caller's spelling against the listing (both repo-relative POSIX).
      return ok(paths.filter((p) => listed.has(p)));
    } catch (error) {
      if (isSpawnNotFoundError(error)) {
        return fail(
          'git_unavailable',
          'The git executable could not be found on PATH.',
          'Install git and ensure it is on PATH.'
        );
      }
      const detail = error instanceof Error ? sanitizeGitText(error.message) : '';
      return fail(
        'tracked_probe_failed',
        `git ls-files failed: ${detail || 'unknown error'}`,
        'Re-run once git answers in this repository (specgit doctor probes it).'
      );
    }
  }

  async headContains(root: string, sha: string): Promise<Evidence<{ contained: boolean }>> {    // The anchor is provider-derived text; only a full hex object id may
    // reach git. Anything else — empty, padded, ref-like, abbreviated —
    // would either ride git's opaque exit-128 path or be resolved as a
    // ref instead of rejected as an object id (#76), so it is classified
    // here without invoking git at all.
    if (!HEX_OBJECT_ID.test(sha)) {
      const shown = sanitizeGitText(sha);
      return fail(
        'merged_lineage_unavailable',
        `The merged-delivery anchor '${shown}' is not a hex object id (40 or 64 hex chars); local git was not invoked.`,
        'The merge anchor arrived malformed from the provider evidence; a ref-like or empty anchor is never resolved by local git. Re-run once the pull request reports a valid merge commit sha.'
      );
    }
    try {
      await this.spawn('git', ['-C', root, 'merge-base', '--is-ancestor', sha, 'HEAD'], {
        timeoutMs: GIT_PROBE_TIMEOUT_MS,
        maxBuffer: GIT_PROBE_MAX_BUFFER,
        env: this.env,
      });
      return ok({ contained: true });
    } catch (error) {
      if (isSpawnNotFoundError(error)) {
        return fail(
          'git_unavailable',
          'The git executable could not be found on PATH.',
          'Install git and ensure it is on PATH.'
        );
      }
      const err = error as { code?: unknown; killed?: boolean };
      // Exit 1 is git's decisive answer: both commits are locally known
      // and the first is not an ancestor of HEAD.
      if (!err.killed && err.code === 1) {
        return ok({ contained: false });
      }
      // Any other failure — unknown object (exit 128), timeout, repo
      // problems — leaves the lineage question unanswered: fail closed.
      const detail = error instanceof Error ? sanitizeGitText(error.message) : '';
      return fail(
        'merged_lineage_unavailable',
        `Local git could not verify whether HEAD contains ${sanitizeGitText(sha)}` +
          (detail ? `: ${detail}` : '.'),
        'Fetch the remote (git fetch) and pull the base branch that received the merge, then re-run.'
      );
    }
  }

  async hooksPath(root: string): Promise<Evidence<string>> {
    // One probe covers the three layouts: plain repo (.git/hooks), linked
    // worktree (the common dir's hooks), and core.hooksPath overrides
    // (husky/lefthook). Relative results resolve against the worktree
    // root — the CWD git would use for `-C root`.
    const resolved = await this.write('hooks', ['-C', root, 'rev-parse', '--git-path', 'hooks']);
    if (!resolved.ok) {
      return resolved;
    }
    const raw = resolved.value.replace(/\r?\n$/, '');
    if (!raw) {
      return fail('git_hooks_failed', 'git rev-parse --git-path hooks returned an empty path.');
    }
    // git emits forward slashes even on Windows; normalize so the value
    // matches the platform's path.join-produced expectations everywhere.
    return ok(path.normalize(path.isAbsolute(raw) ? raw : path.resolve(root, raw)));
  }

  /**
   * Runs one write-side git invocation and maps failures to Evidence.
   * `kind` picks the stable diagnostic code (git_checkout_failed, …).
   */
  private write(
    kind: 'checkout' | 'commit' | 'push' | 'branch' | 'hooks',
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
    const raw = await probe(['worktree', 'list', '--porcelain', '-z']);
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

    for (const line of raw.split('\0')) {
      if (line.startsWith('worktree ')) {
        flush();
        currentPath = line.slice('worktree '.length);
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
