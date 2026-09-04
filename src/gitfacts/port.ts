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
   * Commit the current state of the given repo-relative files in
   * isolation (`git add -f` + pathspec-limited commit). The force flag
   * is deliberate (#292): the binding commit is the one place the
   * authoritative delivery files (record, policy, providers) enter git
   * on purpose, past the tool-installed local-asset ignore. Unchanged
   * paths are a successful no-op (`committed: false`), which makes the
   * bootstrap idempotent across re-runs.
   */
  commitFile(
    root: string,
    relativePaths: string[],
    message: string
  ): Promise<Evidence<{ committed: boolean }>>;
  /** Push `branch` to origin, setting upstream (`git push -u`). */
  pushBranch(root: string, branch: string): Promise<Evidence<{ pushed: boolean }>>;
  /**
   * The remote's default branch (`origin/HEAD`). Falls back to `main`
   * when the symbolic ref is unset locally — the same default `gh`
   * would resolve server-side for `--base`.
   */
  remoteDefaultBranch(root: string, options?: { requireEvidence?: boolean }): Promise<Evidence<string>>;
  /**
   * The directory git would actually run hooks from, absolute:
   * `git rev-parse --git-path hooks`. Respects linked-worktree layout
   * (hooks live in the common dir) and a configured `core.hooksPath`
   * (husky/lefthook). Fail-closed when git cannot answer (e.g. not a
   * repository): the caller skips installing the git hook.
   */
  hooksPath(root: string): Promise<Evidence<string>>;
}

export interface GitPort extends GitWritePort {
  facts(root: string): Promise<GitFacts>;
  /** Read committed data at the live origin branch, without fetching or modifying local refs. */
  readFileAtRemoteRef(root: string, branch: string, relativePath: string): Promise<Evidence<{ sha: string; content: string | null }>>;
  /** Original target policy from a proven two-parent merge whose second parent is the request head. */
  readFileBeforeMerge(root: string, mergeSha: string, headSha: string, relativePath: string): Promise<Evidence<{ sha: string; content: string | null }>>;
  /**
   * Whether `sha` is contained by local HEAD's history (ancestor-or-equal).
   * The anchor must be a full hex object id — 40 hex chars (sha1) or 64
   * (sha256); anything else (empty, padded, ref-like, abbreviated) fails
   * closed as `merged_lineage_unavailable` without invoking git (#76), so
   * a malformed provider value is classified, never resolved as a ref.
   * Evidence discipline: a decisively resolved answer — git exit 0 means
   * contained, exit 1 means a locally known commit that is not an
   * ancestor — returns ok; anything that leaves the local lineage
   * question unanswered (unknown object, git failure) fails closed for
   * the caller to classify. Never touches the network.
   */
  headContains(root: string, sha: string): Promise<Evidence<{ contained: boolean }>>;
  /**
   * Which of `paths` (repo-relative POSIX) are tracked in the index
   * (`git ls-files --`). The answer is the intersection — paths git does
   * not list are untracked (or absent). Read-only, never touches the
   * network. Used by the merged-delivery lifecycle (#298): a tracked
   * record/policy keeps behaving as a tracked file after deletion or
   * rewrite, and the caller warns instead of leaving silent residue.
   */
  trackedFiles(root: string, paths: string[]): Promise<Evidence<string[]>>;
}

/**
 * Member inventory of `GitPort` (read side plus the inherited
 * `GitWritePort` write side). The `satisfies Record<keyof GitPort, true>`
 * check fails compilation when the port and this inventory drift apart in
 * either direction — a required member added to the port must be
 * reflected here, in every implementation, and in the compatibility
 * policy in one delivery (#80). Docs and contract tests read this list;
 * there is no second copy.
 */
const GIT_PORT_MEMBER_FLAGS = {
  facts: true,
  readFileAtRemoteRef: true,
  readFileBeforeMerge: true,
  headContains: true,
  trackedFiles: true,
  checkoutOrCreateBranch: true,
  commitFile: true,
  pushBranch: true,
  remoteDefaultBranch: true,
  hooksPath: true,
} as const satisfies Record<keyof GitPort, true>;

export const GIT_PORT_MEMBERS: readonly (keyof GitPort)[] = Object.freeze(
  Object.keys(GIT_PORT_MEMBER_FLAGS) as Array<keyof GitPort>
);

// The spawn contract lives once in the kernel (#185); this seam consumes
// it and re-exports it for import-path stability.
export type { SpawnFn, SpawnOptions } from '../kernel/spawn.js';
