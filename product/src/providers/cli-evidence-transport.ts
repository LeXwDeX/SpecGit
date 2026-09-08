import { fail, ok, type Evidence } from '../kernel/evidence.js';
import { sanitizeApiText } from './cli-spawn.js';

/**
 * The shared CLI-evidence transport (#274): the layer between the spawn
 * seam (`cli-spawn`) and the forge adapters. It owns the three mechanisms
 * the fail-closed contract promises identically on every platform —
 * pagination to exhaustion (I3b), JSON decoding, and spawn-failure
 * classification (I3a) — parameterised by page size, cap, and the
 * platform's diagnostic vocabulary. What remains adapter-local is
 * genuinely platform-shaped only: endpoint paths, stderr marker patterns,
 * state-machine mappings.
 */

// --------------------------------------------------------------------------
// Pagination to exhaustion (I3b)
// --------------------------------------------------------------------------

/**
 * The single construction site of `evidence_truncated` (#274): every
 * completeness failure — a pagination cap or a platform-reported
 * truncation signal — is built here, so the code and its fail-closed
 * meaning cannot drift between call sites or platforms.
 */
export function evidenceTruncated(message: string): Evidence<never> {
  return fail('evidence_truncated', message);
}

export interface PaginationPlan {
  /** Items requested per page; a shorter page proves exhaustion. */
  pageSize: number;
  /** Completeness guard: pagination beyond this cap fails closed. */
  maxPages: number;
  /** The list's name for the cap diagnostic. */
  what: string;
  /** Unit word for the cap diagnostic; defaults to `items`. */
  unit?: string;
  /**
   * Full override of the cap diagnostic, for platform-shaped caps whose
   * prose does not fit the generic template.
   */
  capMessage?: string;
}

/**
 * Page until a short page proves exhaustion; the cap reached with a full
 * page fails closed instead of returning a silently partial list (#120,
 * I3b). A page failure short-circuits unchanged — the transport never
 * launders another layer's diagnostic.
 */
export async function paginateToExhaustion<T>(
  plan: PaginationPlan,
  fetchPage: (page: number) => Promise<Evidence<T[]>>
): Promise<Evidence<T[]>> {
  const items: T[] = [];
  for (let page = 1; page <= plan.maxPages; page += 1) {
    const pageEv = await fetchPage(page);
    if (!pageEv.ok) {
      return pageEv;
    }
    items.push(...pageEv.value);
    if (pageEv.value.length < plan.pageSize) {
      return ok(items);
    }
  }
  return evidenceTruncated(
    plan.capMessage ??
      `${plan.what} pagination hit its cap (${plan.maxPages * plan.pageSize} ${plan.unit ?? 'items'}); ` +
        'the list may be truncated.'
  );
}

// --------------------------------------------------------------------------
// JSON decoding
// --------------------------------------------------------------------------

/**
 * One JSON decoder for every CLI response: an undecodable payload is a
 * transport failure in the platform's code, never a coerced value.
 */
export function decodeJsonResponse(
  stdout: string,
  transportCode: string,
  platformWord: string
): Evidence<unknown> {
  try {
    return ok(JSON.parse(stdout));
  } catch {
    return fail(transportCode, `${platformWord} returned a response that is not valid JSON.`);
  }
}

// --------------------------------------------------------------------------
// Spawn-failure classification (I3a)
// --------------------------------------------------------------------------

export interface CliRunFailure {
  code: string;
  message: string;
  fix?: string;
  exitCode?: number;
  /** The underlying error, for attribution; never serialized to output. */
  error?: unknown;
}

/** The failure arm of {@link CliRunOutcome}. */
export type CliRunFailureOutcome = { ok: false } & CliRunFailure;

export type CliRunOutcome =
  | { ok: true; value: { stdout: string; stderr: string } }
  | CliRunFailureOutcome;

export interface SpawnErrorSpec {
  /** The platform's diagnostic name, e.g. `GitHub`. */
  platformWord: string;
  codes: {
    missing: string;
    transport: string;
    /** Distinct timeout code; absent means the transport code carries it. */
    timeout?: string;
  };
  missingMessage: string;
  missingFix: string;
  timeoutFix?: string;
  /** stderr markers that mean the looked-up resource does not exist. */
  notFoundPattern: RegExp;
  timeoutMs: number;
}

function isSpawnNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * The one spawn-failure taxonomy both adapters share (#274): missing CLI,
 * timeout, response-size cap, not-found, and generic transport — in that
 * order, each fail-closed. The platform supplies its codes and marker
 * pattern; the classification shape itself exists once.
 */
export function classifySpawnError(error: unknown, spec: SpawnErrorSpec): CliRunFailureOutcome {
  if (isSpawnNotFoundError(error)) {
    return {
      ok: false,
      code: spec.codes.missing,
      message: spec.missingMessage,
      fix: spec.missingFix,
      error,
    };
  }

  const err = error as {
    killed?: boolean;
    signal?: NodeJS.Signals;
    code?: unknown;
    stderr?: unknown;
    message?: unknown;
  };

  if (err.killed || err.signal === 'SIGTERM') {
    return {
      ok: false,
      code: spec.codes.timeout ?? spec.codes.transport,
      message: `${spec.platformWord} CLI timed out after ${spec.timeoutMs} ms.`,
      ...(spec.timeoutFix ? { fix: spec.timeoutFix } : {}),
      error,
    };
  }

  if (err.code === 'ERR_CHILD_PROCESS_STDOUT_MAXBUFFER') {
    return {
      ok: false,
      code: spec.codes.transport,
      message: `${spec.platformWord} CLI returned more output than the response size cap allows.`,
      error,
    };
  }

  const stderr = typeof err.stderr === 'string' ? err.stderr : '';
  const exitCode = typeof err.code === 'number' ? err.code : undefined;
  if (spec.notFoundPattern.test(stderr)) {
    return {
      ok: false,
      code: 'not_found',
      message: sanitizeApiText(stderr || 'Not found.'),
      exitCode,
      error,
    };
  }

  const detail = sanitizeApiText(stderr || (typeof err.message === 'string' ? err.message : String(error)));
  return {
    ok: false,
    code: spec.codes.transport,
    message: detail ? `${spec.platformWord} CLI failed: ${detail}` : `${spec.platformWord} CLI failed.`,
    exitCode,
    error,
  };
}
