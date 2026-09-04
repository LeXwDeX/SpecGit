import type { GitFacts } from '../gitfacts/port.js';
import type { ExecutionContext } from './schema.js';

/** Identity only: callers own environment diagnostics and merged-history recovery. */
export function bindingContextMismatch(
  context: ExecutionContext,
  facts: Pick<GitFacts, 'branch' | 'isLinkedWorktree' | 'worktreeLabel' | 'worktrees'>
): 'branch_mismatch' | 'worktree_mismatch' | null {
  if (context.branch !== facts.branch) return 'branch_mismatch';
  if (context.kind === 'worktree' && (
    facts.isLinkedWorktree !== true ||
    facts.worktreeLabel !== context.label ||
    !facts.worktrees.some((entry) => entry.label === context.label && entry.branch === context.branch)
  )) return 'worktree_mismatch';
  return null;
}
