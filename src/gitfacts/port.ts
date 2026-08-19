import type { Evidence } from '../kernel/evidence.js';

export interface GitFacts {
  repo: boolean;
  toplevel: string | null;
  branch: string | null;
  headSha: string | null;
  dirty: boolean | null;
  isLinkedWorktree: boolean | null;
  worktreeLabel: string | null;
  worktrees: Array<{ label: string; branch: string | null }>;
  originUrl: string | null;
  upstreamDrift: { ahead: number; behind: number } | null;
  gitAvailable: boolean;
}

export interface BranchCheckout {
  branch: string;
  created: boolean;
}

/**
 * Local git write operations for the delivery bootstrap (`specgit
 * issue`). Like the read side, everything goes through real local git —
 * there is no other transport and no network except the push itself.
 */
export interface GitWritePort {
  /** Check out `branch`, creating it from the current HEAD if absent. */
  checkoutOrCreateBranch(root: string, branch: string): Promise<Evidence<BranchCheckout>>;
  /**
   * Commit the current state of one repo-relative file in isolation
   * (`git add` + pathspec-limited commit). An unchanged file is a
   * successful no-op (`committed: false`), which makes the bootstrap
   * idempotent across re-runs.
   */
  commitFile(
    root: string,
    relativePath: string,
    message: string
  ): Promise<Evidence<{ committed: boolean }>>;
  /** Push `branch` to origin, setting upstream (`git push -u`). */
  pushBranch(root: string, branch: string): Promise<Evidence<{ pushed: boolean }>>;
  /**
   * The remote's default branch (`origin/HEAD`). Falls back to `main`
   * when the symbolic ref is unset locally — the same default `gh`
   * would resolve server-side for `--base`.
   */
  remoteDefaultBranch(root: string): Promise<Evidence<string>>;
}

export interface GitPort extends GitWritePort {
  facts(root: string): Promise<GitFacts>;
  /**
   * Whether `sha` is contained by local HEAD's history (ancestor-or-equal).
   * Evidence discipline: a decisively resolved answer — git exit 0 means
   * contained, exit 1 means a locally known commit that is not an
   * ancestor — returns ok; anything that leaves the local lineage
   * question unanswered (unknown object, git failure) fails closed for
   * the caller to classify. Never touches the network.
   */
  headContains(root: string, sha: string): Promise<Evidence<{ contained: boolean }>>;
}

export interface SpawnOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions
) => Promise<{ stdout: string; stderr: string }>;
