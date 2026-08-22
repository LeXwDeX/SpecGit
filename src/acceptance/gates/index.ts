import { checksGate } from './checks-gate.js';
import { closingGate } from './closing-gate.js';
import { completenessGate } from './completeness-gate.js';
import { contextGate } from './context-gate.js';
import { issuesGate } from './issues-gate.js';
import { originGate } from './origin-gate.js';
import { policyGate } from './policy-gate.js';
import { prGate } from './pr-gate.js';
import { providerGate } from './provider-gate.js';
import { recordGate } from './record-gate.js';
import { sequenceGate } from './sequence-gate.js';
import type { GateContext, GateFn, GateId } from './types.js';

/**
 * The gate registry the driver walks (#276): every gate id maps to its
 * module and, where a gate has a precondition beyond "prior gates
 * passed", an applicability probe. The `Record<GateId, …>` shape fails
 * compilation when `GATE_ORDER` and the modules drift apart.
 */
export interface GateRegistration {
  run: GateFn;
  /**
   * Whether this gate applies at this point in the walk. An inapplicable
   * gate ends the walk unrecorded — later gates then read as skipped
   * (or passed-by-history for a merged record), never as failures.
   */
  applies?: (context: GateContext) => boolean;
}

export const GATE_FNS: Record<GateId, GateRegistration> = {
  record: { run: recordGate },
  policy: { run: policyGate },
  completeness: { run: completenessGate },
  context: { run: contextGate },
  origin: { run: originGate },
  provider: { run: providerGate, applies: (ctx) => ctx.input.gh !== undefined },
  issues: { run: issuesGate },
  sequence: { run: sequenceGate },
  pr: { run: prGate },
  closing: { run: closingGate },
  checks: { run: checksGate, applies: (ctx) => ctx.input.gh !== undefined },
};
