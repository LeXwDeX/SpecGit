/**
 * CLI-side language resolution (#118): the presentation language of a
 * command run, read from the policy. The generated-text catalog itself is
 * layer-neutral and lives in `src/i18n/language.ts`.
 *
 * Resolution is presentation-only, so it fails OPEN: when the policy
 * cannot be read (missing, invalid, or unreadable), commands that do not
 * themselves gate on the policy fall back to `en` rather than failing —
 * the acceptance path still fails closed on the policy where it always
 * did.
 */

import { resolveLanguage, type PolicyLanguage } from '../i18n/language.js';
import type { CommandContext } from './types.js';

export { catalogFor, formatRequestRef, resolveLanguage, DEFAULT_LANGUAGE } from '../i18n/language.js';
export type { LanguageCatalog, HumanText, ScaffoldText } from '../i18n/language.js';

/** Presentation language for a command run. Never a verdict input. */
export async function commandLanguage(ctx: CommandContext, root: string): Promise<PolicyLanguage> {
  try {
    const policy = await ctx.record.readPolicy(root);
    return resolveLanguage(policy.ok ? policy.value : null);
  } catch {
    return 'en';
  }
}
