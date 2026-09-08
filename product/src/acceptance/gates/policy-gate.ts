import { makeFailure, type GateContext, type GateFailure } from './types.js';

/** Gate 2 — policy: the acceptance policy must load. */
export function policyGate(ctx: GateContext): GateFailure[] {
  const { policy } = ctx.input;
  if (!policy.ok) {
    return [makeFailure(policy)];
  }
  return [];
}
