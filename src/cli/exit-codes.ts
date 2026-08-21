/**
 * Stable SpecGit exit-code contract.
 *
 * 0 success/accepted · 1 rejected with complete evidence · 2 usage error ·
 * 3 fail-closed unknown (record invalid/missing, provider missing/
 * unauthenticated/transport, not-a-repo, anything undeterminable).
 * Documented exception (#175): `specgit status` reports a MISSING record as
 * the healthy pre-binding state — exit 0 with state `unbound`; only an
 * invalid record fails closed there.
 */

export const EXIT_SUCCESS = 0;
export const EXIT_REJECTED = 1;
export const EXIT_USAGE = 2;
export const EXIT_UNKNOWN = 3;

/**
 * Ctrl-C at an interactive prompt. The one interruption exception: it sits
 * outside the 0/1/2/3 product contract and outside the JSON envelope —
 * stdout stays empty (exactly-zero documents even under `--json`), the
 * human "Interrupted." line goes to stderr.
 */
export const EXIT_INTERRUPTED = 130;

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
