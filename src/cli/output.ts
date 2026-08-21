/**
 * Output contract for every SpecGit command.
 *
 * `--json` mode: stdout receives exactly one JSON document (the envelope
 * below); every human-readable line goes to stderr. Text mode: stdout
 * receives the human rendering, diagnostics still carry stable codes.
 *
 * Envelope shape (stable):
 *   { tool, version, command, status, exit, state?, verdict?, gates?,
 *     evidence?, errors?, warnings?, record?, policy?, probes? }
 *
 * `status` maps to the exit-code contract: 0→ok, 1→rejected, 2→error,
 * 3→unknown. `exit` (#167) carries that same contract as a top-level
 * number, so a piped caller reads the process exit code without mapping
 * the textual `status` back by hand.
 */

import { statusFromExit, EXIT_INTERRUPTED } from './exit-codes.js';
import type {
  BindingState,
  CliIO,
  Diagnostic,
  GateResult,
  Policy,
  Verdict,
} from './types.js';

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;
const ANSI_ESCAPES = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;
const MAX_STRING_LENGTH = 2000;

/**
 * API-sourced strings (branch names, origins, error text from providers) are
 * cleaned of ANSI escapes and C0 control characters before they can reach a
 * terminal, and truncated so a hostile payload cannot flood the screen.
 */
export function sanitize(value: string): string {
  const cleaned = value.replace(ANSI_ESCAPES, '').replace(CONTROL_CHARS, '');
  if (cleaned.length <= MAX_STRING_LENGTH) {
    return cleaned;
  }
  return `${cleaned.slice(0, MAX_STRING_LENGTH)}…`;
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitize(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry));
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      sanitizeValue(entry),
    ]);
    return Object.fromEntries(entries);
  }
  return value;
}

export interface ProbeResult {
  name: string;
  ok: boolean;
  code?: string;
  detail?: string;
}

/**
 * Per-command outcome model (#179): every command declares exactly the
 * envelope fields it emits as its own subtype; the base carries the fields
 * common to all commands. `CommandOutcome` is the structural union the
 * envelope builders consume — a command returning its own subtype can no
 * longer set a field that does not belong to it.
 */
export interface OutcomeBase {
  exit: number;
  errors?: Diagnostic[];
  warnings?: Diagnostic[];
  human?: string[];
}

/** `specgit accept` / `specgit finish`: the verdict and its binding state. */
export interface AcceptOutcome extends OutcomeBase {
  state?: BindingState;
  verdict?: Verdict;
}

/** `specgit finish` delegates to the accept evaluation; same shape. */
export type FinishOutcome = AcceptOutcome;

/** `specgit bind`: the written record plus the derived binding state. */
export interface BindOutcome extends OutcomeBase {
  state?: BindingState;
  record?: Record<string, unknown>;
}

/** `specgit unbind`: the record is gone, the state is `unbound`. */
export interface UnbindOutcome extends OutcomeBase {
  state?: BindingState;
}

/** `specgit issue`: the bootstrapped record plus the derived binding state. */
export interface IssueOutcome extends OutcomeBase {
  state?: BindingState;
  record?: Record<string, unknown>;
}

/** `specgit pr`: the repaired record plus the derived binding state. */
export interface PrOutcome extends OutcomeBase {
  state?: BindingState;
  record?: Record<string, unknown>;
}

/** `specgit status`: local evidence — gates, context, the asset taxonomy. */
export interface StatusOutcome extends OutcomeBase {
  state?: BindingState;
  gates?: GateResult[];
  evidence?: Record<string, unknown>;
  assets?: Record<string, unknown>;
}

/** `specgit doctor`: the environment probes and nothing else. */
export interface DoctorOutcome extends OutcomeBase {
  probes?: ProbeResult[];
}

/** `specgit setup`: the installed agent-surface asset set (#168). */
export interface SetupOutcome extends OutcomeBase {
  assets?: Record<string, unknown>;
}

/** `specgit init`: policy, harness, platform, detection, protection. */
export interface InitOutcome extends OutcomeBase {
  policy?: Policy;
  harness?: Record<string, unknown>;
  platform?: Record<string, unknown>;
  protection?: Record<string, unknown>;
  detected?: Record<string, unknown>;
}

export type CommandOutcome =
  | AcceptOutcome
  | BindOutcome
  | UnbindOutcome
  | IssueOutcome
  | PrOutcome
  | StatusOutcome
  | DoctorOutcome
  | SetupOutcome
  | InitOutcome;

export function buildEnvelope(
  command: string,
  version: string,
  outcome: CommandOutcome
): Record<string, unknown> {
  const envelope: Record<string, unknown> = {
    tool: 'specgit',
    version,
    command,
    status: statusFromExit(outcome.exit),
    exit: outcome.exit,
  };
  // Optional fields are read through `in` narrowing (#179): each key exists
  // only on the subtypes that emit it, and the envelope order matches the
  // documented shape exactly.
  const optional: Array<[string, unknown]> = [];
  if ('state' in outcome) optional.push(['state', outcome.state]);
  if ('verdict' in outcome) optional.push(['verdict', outcome.verdict]);
  if ('gates' in outcome) optional.push(['gates', outcome.gates]);
  if ('evidence' in outcome) optional.push(['evidence', outcome.evidence]);
  optional.push(['errors', outcome.errors], ['warnings', outcome.warnings]);
  if ('record' in outcome) optional.push(['record', outcome.record]);
  if ('policy' in outcome) optional.push(['policy', outcome.policy]);
  if ('probes' in outcome) optional.push(['probes', outcome.probes]);
  if ('detected' in outcome) optional.push(['detected', outcome.detected]);
  if ('protection' in outcome) optional.push(['protection', outcome.protection]);
  if ('platform' in outcome) optional.push(['platform', outcome.platform]);
  if ('harness' in outcome) optional.push(['harness', outcome.harness]);
  if ('assets' in outcome) optional.push(['assets', outcome.assets]);
  for (const [key, value] of optional) {
    if (value !== undefined) {
      envelope[key] = value;
    }
  }
  return sanitizeValue(envelope) as Record<string, unknown>;
}

export function emitJson(io: CliIO, envelope: Record<string, unknown>): void {
  io.stdout(JSON.stringify(envelope, null, 2));
}

export function errorDiagnostic(
  code: string,
  message: string,
  extra: { target?: string; fix?: string } = {}
): Diagnostic {
  return {
    severity: 'error',
    code,
    message,
    ...(extra.target !== undefined ? { target: extra.target } : {}),
    ...(extra.fix !== undefined ? { fix: extra.fix } : {}),
  };
}

export function finishOutcome(
  io: CliIO,
  command: string,
  version: string,
  outcome: CommandOutcome,
  json: boolean
): number {
  if (json) {
    emitJson(io, buildEnvelope(command, version, outcome));
  } else {
    for (const line of outcome.human ?? []) {
      io.stdout(line);
    }
    for (const diagnostic of outcome.errors ?? []) {
      io.stderr(`Error: ${sanitize(diagnostic.message)}`);
      if (diagnostic.fix) {
        io.stderr(`Fix: ${sanitize(diagnostic.fix)}`);
      }
    }
    for (const diagnostic of outcome.warnings ?? []) {
      io.stderr(`Warning: ${sanitize(diagnostic.message)}`);
    }
  }
  return outcome.exit;
}

/**
 * The Ctrl-C path (#69): the one interruption exception. Deterministic and
 * JSON-mode-aware by being JSON-mode-invariant — stdout receives nothing
 * (exactly-zero documents even under `--json`), stderr carries the human
 * "Interrupted." line, and the exit code is 130.
 */
export function emitInterrupted(io: CliIO): number {
  io.stderr('Interrupted.');
  return EXIT_INTERRUPTED;
}
