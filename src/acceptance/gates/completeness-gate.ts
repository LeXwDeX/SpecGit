import { makeFailure, type GateContext, type GateFailure } from './types.js';

/**
 * Gate 3 — completeness: the binding must name at least one issue and a
 * pull request. Collects every missing piece in one pass.
 */
export function completenessGate(ctx: GateContext): GateFailure[] {
  const failures: GateFailure[] = [];
  const binding = ctx.binding;
  if (!binding || binding.issues.length === 0) {
    failures.push(makeFailure('issues_empty'));
  }
  if (!binding || binding.pr === undefined) {
    failures.push(makeFailure('pr_missing'));
  }
  return failures;
}
