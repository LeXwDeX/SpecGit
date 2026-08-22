import { parseRepoRef, type RepoRef } from '../../gitfacts/origin.js';
import { makeFailure, type GateContext, type GateFailure } from './types.js';

function repoRefForMergedCheck(originUrl: string | null, gitlabHost?: string): RepoRef | null {
  if (!originUrl) return null;
  const parsed = parseRepoRef(originUrl, gitlabHost !== undefined ? { gitlabHost } : {});
  return parsed.ok ? parsed.value : null;
}

/**
 * Gate 4 — context: local git facts must load and the checkout must be
 * the bound execution context. Publishes the git facts and the local
 * evidence (branch, head, dirt, drift) into the verdict evidence.
 */
export async function contextGate(ctx: GateContext): Promise<GateFailure[]> {
  const { input, binding } = ctx;
  if (!input.root.ok) {
    return [makeFailure(input.root)];
  }
  const facts = await input.git.facts(input.root.value);
  ctx.facts = facts;
  if (!facts.gitAvailable) {
    return [makeFailure('git_unavailable')];
  }
  if (!facts.repo) {
    return [makeFailure('not_a_git_repo')];
  }
  if (facts.headSha === null) {
    return [makeFailure('no_commits')];
  }

  ctx.evidence.branch = facts.branch;
  ctx.evidence.headSha = facts.headSha;
  ctx.evidence.dirty = facts.dirty;
  ctx.evidence.upstreamDrift = facts.upstreamDrift;

  if (facts.branch === null) {
    return [makeFailure('detached_head')];
  }
  if (facts.branch !== binding!.context.branch) {
    // The record may belong to a delivery whose PR already merged —
    // running finish on main afterwards is then a completed history,
    // not a mismatch. Historical acceptance still requires proof that
    // local HEAD contains the merged delivery: GitHub's
    // merge_commit_sha is a commit on the base branch under every
    // merge method (merge commit, squash, rebase), so containment of
    // that one anchor in local HEAD is the lineage proof. A provider
    // failure keeps the fail-closed mismatch (never upgrades on
    // missing evidence), and unresolved lineage never turns green.
    const repoForMerged = repoRefForMergedCheck(facts.originUrl, input.gitlabHost);
    if (repoForMerged && binding!.pr !== undefined && input.gh) {
      const prEv = await input.gh.getPr(repoForMerged, binding!.pr);
      if (prEv.ok && prEv.value.state === 'merged') {
        ctx.evidence.prHead = prEv.value.headSha;
        const mergeCommitSha = prEv.value.mergeCommitSha;
        if (!mergeCommitSha) {
          // No anchor means no proof. The PR head is not a substitute:
          // squash and rebase never put it on the base branch.
          return [
            makeFailure('merged_lineage_unavailable', {
              source: 'provider',
              pr: prEv.value.number,
            }),
          ];
        }
        const containment = await input.git.headContains(input.root.value, mergeCommitSha);
        if (!containment.ok) {
          // #277: the containment Evidence's own message carries the
          // reason; the detail keeps the anchor for attribution.
          return [makeFailure(containment, { mergeCommitSha })];
        }
        if (!containment.value.contained) {
          return [
            makeFailure('merged_delivery_not_contained', {
              mergeCommitSha,
              headSha: facts.headSha,
            }),
          ];
        }
        ctx.mergedRecord = true;
        return [];
      }
    }
    return [makeFailure('branch_mismatch')];
  }
  if (binding!.context.kind === 'worktree') {
    const expectedLabel = binding!.context.label;
    if (facts.isLinkedWorktree !== true || facts.worktreeLabel !== expectedLabel) {
      return [makeFailure('worktree_mismatch')];
    }
    const entry = facts.worktrees.find((w) => w.label === expectedLabel);
    if (!entry || entry.branch !== binding!.context.branch) {
      return [makeFailure('worktree_mismatch')];
    }
  }
  return [];
}
