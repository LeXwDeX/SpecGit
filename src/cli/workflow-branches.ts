import { isAutomationTargetBranch } from '../record/policy.js';

/** GitHub branch filters are glob patterns even when YAML quotes their values. */
export function literalBranchPattern(branch: string): string {
  if (!isAutomationTargetBranch(branch)) throw new Error(`"${branch}" is not a usable branch name.`);
  return branch.replace(/[\\+!(){}|@]/g, '\\$&');
}
