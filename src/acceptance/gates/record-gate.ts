import { makeFailure, type GateContext, type GateFailure } from './types.js';

/**
 * Gate 1 — record: the delivery binding must load. Publishes the
 * delivery name, execution context, and bound issue list into the
 * verdict evidence.
 */
export function recordGate(ctx: GateContext): GateFailure[] {
  const { record } = ctx.input;
  if (!record.ok) {
    return [makeFailure(record.code)];
  }
  const binding = record.value;
  ctx.evidence.delivery = binding.delivery;
  ctx.evidence.context = binding.context.kind === 'branch' ? { kind: 'branch' } : { kind: 'worktree' };
  ctx.evidence.issues = [...binding.issues];
  return [];
}
