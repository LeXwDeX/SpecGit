import type { Diagnostic } from '../kernel/diagnostics.js';
import { CODE_INFO, type SpecGitCode } from './codes.js';
import { GATE_FNS } from './gates/index.js';
import type {
  EvaluateInput,
  GateContext,
  GateFailure,
  GateId,
  VerdictEvidence,
} from './gates/types.js';

// The gate contract types live with the gate modules (#276); they are
// re-exported here so this module's public surface is unchanged.
export type { EvaluateInput, GateFailure, GateId, VerdictEvidence } from './gates/types.js';

export type DeliveryState =
  | 'unbound'
  | 'draft'
  | 'bound'
  | 'accepted'
  | 'closure_pending'
  | 'completed'
  | 'rejected'
  | 'unknown';
export type VerdictClassification = 'accepted' | 'rejected' | 'unknown';

/**
 * The gate registry (#69): eleven gates in evaluation order, `sequence`
 * included. Contract tests pin this against help, docs, and the generated
 * agent surface. The driver below walks this order; the implementations
 * live one per file under `gates/` (#276).
 */
export const GATE_ORDER: GateId[] = [
  'record',
  'policy',
  'completeness',
  'context',
  'origin',
  'provider',
  'issues',
  'sequence',
  'pr',
  'closing',
  'checks',
];

export interface GateResult {
  id: GateId;
  status: 'pass' | 'fail' | 'skipped';
  failures: GateFailure[];
}

export interface Verdict {
  accepted: boolean;
  state: DeliveryState;
  classification: VerdictClassification;
  exitCode: 0 | 1 | 3;
  complete: boolean;
  gates: GateResult[];
  evidence: VerdictEvidence;
  warnings: Diagnostic[];
}

function isEvidenceKind(code: string): boolean {
  return (CODE_INFO[code as SpecGitCode]?.kind ?? 'evidence') === 'evidence';
}

/**
 * Pure acceptance evaluation. States are derived per invocation, never
 * persisted. Gates short-circuit across gates and collect all failures within
 * a gate. Acceptance derives only from git, PR, and check evidence — spec
 * artifacts and task lists are never read. Fail-closed axiom: any evidence
 * failure yields `unknown` (exit 3); a decisive finding with complete evidence
 * yields `rejected` (exit 1).
 *
 * The evaluator is a driver (#276): it walks `GATE_ORDER`, threads the
 * explicit typed `GateContext` through the gate modules, and stops at
 * the first failing gate. Gate implementations never live here.
 */
export async function evaluate(input: EvaluateInput): Promise<Verdict> {
  const results = new Map<GateId, GateFailure[]>();

  const evidence: VerdictEvidence = {
    root: input.root.ok ? input.root.value : null,
    repo: null,
    delivery: null,
    branch: null,
    headSha: null,
    dirty: null,
    upstreamDrift: null,
    context: null,
    issues: null,
    pr: null,
    prHead: null,
  };
  const warnings: Diagnostic[] = [];

  const ctx: GateContext = {
    input,
    binding: input.record.ok ? input.record.value : null,
    policy: input.policy.ok ? input.policy.value : null,
    evidence,
    warnings,
    facts: null,
    mergedRecord: false,
    repoRef: null,
    prFact: null,
  };

  // The walk: each gate reads the context prior gates published and
  // publishes its own findings back onto it. The first failure halts the
  // walk; a gate that does not apply (no forge provider present) ends it
  // unrecorded, so later gates read as skipped.
  let halted = false;
  for (const id of GATE_ORDER) {
    if (halted) {
      break;
    }
    const gate = GATE_FNS[id];
    if (gate.applies !== undefined && !gate.applies(ctx)) {
      break;
    }
    const failures = await gate.run(ctx);
    results.set(id, failures);
    if (failures.length > 0) {
      halted = true;
    }
  }

  const gates: GateResult[] = GATE_ORDER.map((id) => {
    const failures = results.get(id);
    if (failures === undefined) {
      return { id, status: 'skipped', failures: [] };
    }
    return { id, status: failures.length > 0 ? 'fail' : 'pass', failures };
  });

  const allFailures = [...results.values()].flat();
  const evaluatedAll = GATE_ORDER.every((id) => results.has(id));
  const evidenceBlocked = allFailures.some((f) => isEvidenceKind(f.code));
  const classification: VerdictClassification = evidenceBlocked
    ? 'unknown'
    : allFailures.length > 0
      ? 'rejected'
      : evaluatedAll && input.gh !== undefined
        ? 'accepted'
        : 'unknown';

  const recordComplete =
    ctx.binding !== null && ctx.binding.issues.length > 0 && ctx.binding.pr !== undefined;

  let state: DeliveryState;
  if (!input.record.ok) {
    state = input.record.code === 'record_missing' ? 'unbound' : 'unknown';
  } else if (!recordComplete) {
    state = 'draft';
  } else if (classification === 'accepted') {
    // #351: a record judged at its merged history is completed, not
    // merely accepted — the delivery is done and the record rides the
    // trunk until the next bootstrap atomically replaces it.
    state = ctx.mergedRecord
      ? evidence.openIssues?.length === 0 ? 'completed' : 'closure_pending'
      : 'accepted';
  } else if (classification === 'rejected') {
    state = 'rejected';
  } else {
    state = 'bound';
  }

  const exitCode: 0 | 1 | 3 = classification === 'accepted' ? 0 : classification === 'rejected' ? 1 : 3;

  if (ctx.mergedRecord && classification === 'accepted') {
    warnings.push({
      severity: 'warning',
      code: 'record_of_merged_delivery',
      message: state === 'completed'
        ? 'This record is the completed history of a delivery whose PR/MR is merged and bound issues are closed.'
        : 'The PR/MR is merged; bound issue closure is still pending.',
      fix: state === 'completed'
        ? 'Start the next delivery: specgit issue "<type>: <title>" atomically replaces this record.'
        : 'Resume the configured completion runner or close the remaining bound issues, then run specgit finish again.',
    });
  }

  return {
    accepted: classification === 'accepted',
    state,
    classification,
    exitCode,
    complete: evaluatedAll && input.gh !== undefined,
    gates,
    evidence,
    warnings,
  };
}
