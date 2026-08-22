import { makeFailure, type GateContext, type GateFailure } from './types.js';

/**
 * Gate 8 — sequence: with ordered_issues on, no open issue may precede
 * the delivery's smallest bound issue — deliveries merge in ascending
 * issue order. Off (the default), the gate passes without any provider
 * call so the verdict stays complete.
 */
export async function sequenceGate(ctx: GateContext): Promise<GateFailure[]> {
  if (ctx.policy?.ordered_issues !== true) {
    return [];
  }
  const open = await ctx.input.gh!.getOpenIssueNumbers(ctx.repoRef!);
  if (!open.ok) {
    return [makeFailure(open.code)];
  }
  const first = Math.min(...ctx.binding!.issues);
  const earlier = open.value.filter((n) => n < first).sort((a, b) => a - b);
  if (earlier.length > 0) {
    return [
      makeFailure('issue_out_of_order', {
        earliestBound: first,
        openEarlier: earlier.slice(0, 20),
      }),
    ];
  }
  return [];
}
