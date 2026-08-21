/**
 * `specgit finish` — the verdict command of the human story
 * (issue → work → finish). Delegates to exactly the same evaluation as
 * `specgit accept`: the eleven-gate, fail-closed evaluator in
 * `src/acceptance/**`. `accept` remains as the script/CI alias; only
 * the envelope's `command` field differs.
 */

import { runAccept, type AcceptOptions } from './accept.js';
import type { FinishOutcome } from '../output.js';
import type { CommandContext } from '../types.js';

export type FinishOptions = AcceptOptions;

export async function runFinish(
  options: FinishOptions,
  ctx: CommandContext
): Promise<FinishOutcome> {
  return runAccept(options, ctx);
}
