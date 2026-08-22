import { CODE_INFO } from '../codes.js';
import { makeFailure, type GateContext, type GateFailure } from './types.js';

/**
 * Gate 6 — provider: the forge CLI must pass its preflight (installed
 * and authenticated). The walk only reaches this gate when a forge
 * provider is present (see `GATE_FNS` in `index.ts`).
 */
export async function providerGate(ctx: GateContext): Promise<GateFailure[]> {
  const preflight = await ctx.input.gh!.preflight();
  if (!preflight.ok) {
    return [makeFailure(preflight)];
  }
  // Advisory verified-window flag from the GitLab preflight (#241):
  // a version outside the verified window warns but never blocks —
  // the live evidence pass is the fail-closed guarantee.
  if (preflight.value.versionUnverified === true) {
    ctx.warnings.push({
      severity: 'warning',
      code: 'gitlab_version_unverified',
      message: CODE_INFO.gitlab_version_unverified.message,
      fix: CODE_INFO.gitlab_version_unverified.fix,
    });
  }
  return [];
}
