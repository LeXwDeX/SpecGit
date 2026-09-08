import { planBoundVerification } from '../../verification/resolve.js';
import { errorDiagnostic, humanBuilder, sanitize, type VerificationOutcome } from '../output.js';
import type { CommandContext } from '../types.js';

/** CI scheduling consumes a decision; only ordinary finish can return acceptance. */
export async function runVerificationPlan(ctx: CommandContext): Promise<VerificationOutcome> {
  const stop = (error: { code: string; message: string; fix?: string }): VerificationOutcome => ({
    exit: 3, errors: [errorDiagnostic(error.code, error.message, error.fix ? { fix: error.fix } : {})],
  });
  const root = await ctx.discoverRoot(ctx.cwd);
  if (!root.ok) return stop(root);
  const record = await ctx.record.readRecord(root.value);
  const resolution = await ctx.resolvePolicy(root.value, record);
  const decision = await planBoundVerification({ root: root.value, record, resolution, git: ctx.git, forge: ctx.gh, parseRepoRef: ctx.parseRepoRef });
  if (!decision.ok) return stop(decision);
  return { exit: 0, verification: decision.value,
    human: humanBuilder().line('Verification plan (not acceptance)')
      .detail(`Required checks: ${decision.value.requiredChecks.map(sanitize).join(', ') || '(none)'}`)
      .append(decision.value.paths.map((entry) => `  ${sanitize(entry.path)}: ${entry.kind} (${entry.reason})`)).build() };
}
