/**
 * Output contract for every SpecGit command.
 *
 * `--json` mode: stdout receives exactly one JSON document (the envelope
 * below); every human-readable line goes to stderr. Text mode: stdout
 * receives the human rendering, diagnostics still carry stable codes.
 *
 * Envelope shape (stable):
 *   { tool, version, command, status, state?, verdict?, gates?, evidence?,
 *     errors?, warnings?, record?, policy?, probes? }
 *
 * `status` maps to the exit-code contract: 0→ok, 1→rejected, 2→error,
 * 3→unknown.
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

export interface CommandOutcome {
  exit: number;
  state?: BindingState;
  verdict?: Verdict;
  gates?: GateResult[];
  evidence?: Record<string, unknown>;
  errors?: Diagnostic[];
  warnings?: Diagnostic[];
  record?: Record<string, unknown>;
  policy?: Policy;
  probes?: ProbeResult[];
  detected?: Record<string, unknown>;
  protection?: Record<string, unknown>;
  platform?: Record<string, unknown>;
  harness?: Record<string, unknown>;
  assets?: Record<string, unknown>;
  human?: string[];
}

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
  };
  const optional: Array<[string, unknown]> = [
    ['state', outcome.state],
    ['verdict', outcome.verdict],
    ['gates', outcome.gates],
    ['evidence', outcome.evidence],
    ['errors', outcome.errors],
    ['warnings', outcome.warnings],
    ['record', outcome.record],
    ['policy', outcome.policy],
    ['probes', outcome.probes],
    ['detected', outcome.detected],
    ['protection', outcome.protection],
    ['platform', outcome.platform],
    ['harness', outcome.harness],
    ['assets', outcome.assets],
  ];
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
