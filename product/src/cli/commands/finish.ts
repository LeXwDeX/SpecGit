/**
 * `specgit finish` — the verdict command of the human story
 * (issue → work → finish). Delegates to exactly the same evaluation as
 * `specgit accept`: the eleven-gate, fail-closed evaluator in
 * `src/acceptance/**`. `accept` remains as the script/CI alias; only
 * the envelope's `command` field differs.
 */

import { runAccept, type AcceptOptions } from './accept.js';
import type { AcceptOutcome, FinishOutcome } from '../output.js';
import type { CommandContext } from '../types.js';
import { runScope } from './scope.js';
import { runVerificationPlan } from './verification.js';

export interface FinishOptions extends AcceptOptions { scope?: string; planChecks?: boolean }

export function runFinish(options: AcceptOptions & { scope?: undefined; planChecks?: false }, ctx: CommandContext): Promise<AcceptOutcome>;
export function runFinish(options: FinishOptions, ctx: CommandContext): Promise<FinishOutcome>;
export async function runFinish(
  options: FinishOptions,
  ctx: CommandContext
): Promise<FinishOutcome> {
  if (options.scope !== undefined && options.planChecks) return {
    exit: 2, errors: [{ severity: 'error', code: 'usage_error', message: '--scope and --plan-checks select different evidence and cannot be combined.' }],
  };
  if (options.planChecks) return runVerificationPlan(ctx);
  return options.scope === undefined ? runAccept(options, ctx) : runScope(options.scope, ctx);
}
