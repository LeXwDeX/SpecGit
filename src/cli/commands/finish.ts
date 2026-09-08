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

export interface FinishOptions extends AcceptOptions { scope?: string }

export function runFinish(options: AcceptOptions & { scope?: undefined }, ctx: CommandContext): Promise<AcceptOutcome>;
export function runFinish(options: FinishOptions, ctx: CommandContext): Promise<FinishOutcome>;
export async function runFinish(
  options: FinishOptions,
  ctx: CommandContext
): Promise<FinishOutcome> {
  return options.scope === undefined ? runAccept(options, ctx) : runScope(options.scope, ctx);
}
