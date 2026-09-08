/**
 * Deprecated alias of the canonical adapter home (#113, #170).
 *
 * `GhCliGitHubProvider` lives at `src/providers/github/gh-cli.ts` (option B
 * — neutral provider port with per-platform adapters). This module keeps the
 * historical `src/github/gh-cli.js` import path working unchanged — the
 * existing GitHub suite depends on it — and re-exports the same class and
 * helpers, never copies. `src/github/` itself stays the canonical home of
 * the port definition (`port.ts`); only the adapter aliases here are
 * deprecated, and removing them is its own delivery.
 *
 * @deprecated Import from `src/providers/github/gh-cli.ts` instead.
 */
export * from '../providers/github/gh-cli.js';
