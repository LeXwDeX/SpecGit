import { makeFailure, type GateContext, type GateFailure } from './types.js';

/**
 * Gate 1 — record: the delivery binding must load. Publishes the
 * delivery name, execution context, and bound issue list into the
 * verdict evidence.
 */
export function recordGate(ctx: GateContext): GateFailure[] {
  const { record } = ctx.input;
  if (!record.ok) {
    // #277: the record reader already knows the path it missed — its
    // account reaches the operator instead of the generic registry line.
    return [makeFailure(record)];
  }
  const binding = record.value;
  ctx.evidence.delivery = binding.delivery;
  ctx.evidence.context = binding.context.kind === 'branch' ? { kind: 'branch' } : { kind: 'worktree' };
  ctx.evidence.issues = [...binding.issues];
  return [];
}
