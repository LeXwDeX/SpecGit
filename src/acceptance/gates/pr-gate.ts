import { formatRepoRef, parsePrUrl, sameRepoRef } from '../../gitfacts/origin.js';
import { makeFailure, type GateContext, type GateFailure } from './types.js';

/**
 * Gate 9 — pr: the bound pull request exists, is mergeable (not closed
 * unmerged, not draft), and its head is the delivery branch. Publishes
 * the PR fact and the PR evidence.
 */
export async function prGate(ctx: GateContext): Promise<GateFailure[]> {
  let queryRef: number | string;
  const bound = ctx.binding!.pr!;
  if (typeof bound === 'number') {
    queryRef = bound;
  } else {
    const parsedUrl = parsePrUrl(bound);
    if (parsedUrl.ok) {
      if (!sameRepoRef(parsedUrl.value.repo, ctx.repoRef!)) {
        return [
          makeFailure('pr_repo_mismatch', {
            prRepo: formatRepoRef(parsedUrl.value.repo),
            originRepo: formatRepoRef(ctx.repoRef!),
          }),
        ];
      }
      queryRef = parsedUrl.value.pr;
    } else {
      queryRef = bound;
    }
  }

  const pr = await ctx.input.gh!.getPr(ctx.repoRef!, queryRef);
  if (!pr.ok) {
    return [makeFailure(pr.code === 'pr_not_found' ? 'pr_not_found' : pr.code, { pr: bound })];
  }
  ctx.prFact = pr.value;
  const fact = pr.value;
  ctx.evidence.pr = fact.number;
  ctx.evidence.prHead = fact.headSha || null;

  const failures: GateFailure[] = [];
  if (fact.state === 'closed') {
    failures.push(makeFailure('pr_closed_unmerged', { pr: fact.number }));
  }
  // A draft is a platform-level unmergeable state that never
  // auto-transitions: green checks over a draft are still not done.
  if (fact.draft) {
    failures.push(makeFailure('pr_draft', { pr: fact.number }));
  }
  if (fact.headBranch !== ctx.binding!.context.branch) {
    failures.push(
      makeFailure('pr_head_mismatch', {
        prHead: fact.headBranch,
        boundBranch: ctx.binding!.context.branch,
      })
    );
  }
  return failures;
}
