import { formatRepoRef, parsePrUrl, sameRepoRef } from '../../gitfacts/origin.js';
import { makeFailure, type GateContext, type GateFailure } from './types.js';
import { checkTitleConvention } from '../../record/conventions.js';
import { checkBodyConvention } from '../../record/templates.js';
import { findIssueOccupancy } from '../../github/issue-occupancy.js';

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
    // pr_not_found keeps the registry prose (the bound-ref detail carries
    // the specifics); any other failure forwards the provider's account.
    if (pr.code === 'pr_not_found') {
      return [makeFailure('pr_not_found', { pr: bound })];
    }
    return [makeFailure(pr, { pr: bound })];
  }
  ctx.prFact = pr.value;
  const fact = pr.value;
  ctx.evidence.pr = fact.number;
  ctx.evidence.prHead = fact.headSha || null;

  const failures: GateFailure[] = [];
  const title = checkTitleConvention(ctx.policy!, fact.title);
  if (!title.ok) failures.push(makeFailure(title, { pr: fact.number }));
  const body = checkBodyConvention(ctx.policy!, 'pr', fact.body);
  if (!body.ok) failures.push(makeFailure(body, { pr: fact.number }));
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
  if (fact.state === 'open' && failures.length === 0) {
    const occupancy = await findIssueOccupancy(ctx.input.gh!, ctx.repoRef!, ctx.binding!.issues, {
      pr: fact.number, host: ctx.input.gitlabHost,
    });
    if (!occupancy.ok) {
      failures.push(makeFailure({ ...occupancy, code: 'issue_occupancy_unknown' }, { cause: occupancy.code }));
    } else if (occupancy.value.length > 0) {
      failures.push(makeFailure('issue_already_claimed', occupancy.value));
    }
  }
  return failures;
}
