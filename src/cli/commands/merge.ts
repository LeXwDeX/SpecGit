import { completeDelivery } from '../../completion/complete-delivery.js';
import { presentCompletion } from '../completion-output.js';
import type { PrOutcome } from '../output.js';
import type { CommandContext } from '../types.js';

/** CLI adapter for the shared guarded completion operation. */
export async function runMerge(ctx: CommandContext, options: { closeOnly?: boolean } = {}): Promise<PrOutcome> {
  const root = await ctx.discoverRoot(ctx.cwd);
  return presentCompletion(await completeDelivery({ root, ...options }, ctx));
}
