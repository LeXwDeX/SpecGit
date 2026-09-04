import { makeFailure, type GateContext, type GateFailure } from './types.js';
import { checkLabelConvention, checkTitleConvention } from '../../record/conventions.js';

/**
 * Gate 7 — issues: every bound issue exists and is an issue, not a pull
 * request. A missing issue is collected per issue; any other provider
 * failure short-circuits — the list beyond it is not evidence.
 */
export async function issuesGate(ctx: GateContext): Promise<GateFailure[]> {
  const failures: GateFailure[] = [];
  for (const issueNumber of ctx.binding!.issues) {
    const issue = await ctx.input.gh!.getIssue(ctx.repoRef!, issueNumber);
    if (!issue.ok) {
      if (issue.code === 'issue_not_found') {
        failures.push(makeFailure('issue_not_found', { issue: issueNumber }));
        continue;
      }
      failures.push(makeFailure(issue));
      break;
    }
    if (issue.value.pullRequest) {
      failures.push(makeFailure('issue_is_pull_request', { issue: issueNumber }));
      continue;
    }
    for (const result of [checkTitleConvention(ctx.policy!, issue.value.title),
      checkLabelConvention(ctx.policy!, issue.value.labels)]) {
      if (!result.ok) failures.push(makeFailure(result, { issue: issueNumber }));
    }
  }
  return failures;
}
