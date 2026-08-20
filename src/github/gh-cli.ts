/**
 * Stable alias of the canonical adapter home (#113).
 *
 * `GhCliGitHubProvider` lives at `src/providers/github/gh-cli.ts` (option B
 * — neutral provider port with per-platform adapters). This module keeps the
 * historical `src/github/gh-cli.js` import path working unchanged — the
 * existing GitHub suite depends on it — and re-exports the same class and
 * helpers, never copies. Removing this alias is its own delivery.
 */
export * from '../providers/github/gh-cli.js';
