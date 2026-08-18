/**
 * Stable SpecGit exit-code contract.
 *
 * 0 success/accepted · 1 rejected with complete evidence · 2 usage error ·
 * 3 fail-closed unknown (record invalid/missing, provider missing/
 * unauthenticated/transport, not-a-repo, anything undeterminable).
 */

export const EXIT_SUCCESS = 0;
export const EXIT_REJECTED = 1;
export const EXIT_USAGE = 2;
export const EXIT_UNKNOWN = 3;

export type EnvelopeStatus = 'ok' | 'rejected' | 'unknown' | 'error';

export function statusFromExit(exit: number): EnvelopeStatus {
  switch (exit) {
    case EXIT_SUCCESS:
      return 'ok';
    case EXIT_REJECTED:
      return 'rejected';
    case EXIT_USAGE:
      return 'error';
    default:
      return 'unknown';
  }
}
