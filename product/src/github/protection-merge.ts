/**
 * Deprecated alias of the canonical adapter home (#113, #170).
 *
 * The classic-protection read-modify-write transform lives at
 * `src/providers/github/protection-merge.ts`. This module keeps the
 * historical `src/github/protection-merge.js` import path working unchanged
 * and re-exports the same functions, never copies. Removing this alias is
 * its own delivery.
 *
 * @deprecated Import from `src/providers/github/protection-merge.ts` instead.
 */
export * from '../providers/github/protection-merge.js';
