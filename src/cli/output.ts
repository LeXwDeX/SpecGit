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
  /** #361: the accepted/completed hand-off — merge, or the next delivery. */
  nextActions?: NextAction[];
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
  /** #361: forge web URLs for the bound issues and the draft PR. */
  urls?: { issues: string[]; pr: string };
  /** #361: fill the issue bodies and PR brief, then mark ready. */
  nextActions?: NextAction[];
}

export interface PrAutomation {
  status: 'pending' | 'blocked' | 'unknown' | 'completed';
  pr?: number;
  headSha?: string;
  targetBranch?: string;
  merged: boolean;
  closedIssues: number[];
}

/** `specgit pr`: repaired binding or configured merge execution. */
export interface PrOutcome extends OutcomeBase {
  state?: BindingState;
  record?: Record<string, unknown>;
  automation?: PrAutomation;
  nextActions?: NextAction[];
}

/**
 * The status-level state vocabulary (#351): status is offline, so a
 * merged-delivery record it cannot confirm reads `historical-candidate`;
 * the forge-backed verdict vocabulary (`BindingState`, with
 * `accepted`/`completed`/`rejected`/`unknown`) belongs to `finish`.
 */
export type StatusState = 'unbound' | 'draft' | 'bound' | 'historical-candidate' | 'unknown';

/**
 * #363: the three question-layered states, each answerable on its own —
 * is the record complete, does the checkout match it, where is the
 * delivery in its lifecycle. `state` stays as the compat rollup; the
 * verdict layer belongs to `finish` alone.
 */
export type RecordState = 'missing' | 'partial' | 'complete';
export type LocalContext = 'matching' | 'mismatch' | 'unknown';
export type Lifecycle = 'active' | 'historical-candidate';

/** `specgit status`: local evidence — gates, context, the asset taxonomy. */
export interface StatusOutcome extends OutcomeBase {
  state?: StatusState;
  recordState?: RecordState;
  localContext?: LocalContext;
  lifecycle?: Lifecycle;
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

/**
 * #352/#360: one structured hand-off step in a command's success output —
 * what to run next and why. Codes/commands interpolate verbatim (machine
 * contract, never localized); only the surrounding prose localizes.
 */
export interface NextAction {
  code: string;
  command: string;
  reason: string;
}

/**
 * #360: the ONE human renderer for nextActions — a localized headline
 * (command-specific content) followed by each command with its reason.
 * No command renders its own next-step list.
 */
export function renderNextActionsHuman(headline: string, actions: NextAction[]): string[] {
  if (actions.length === 0) {
    return [];
  }
  return [headline, ...actions.map((action) => `  ${action.command} — ${action.reason}`)];
}

/** `specgit init`: policy, harness, platform, detection, protection, local-asset ignore. */
export interface InitOutcome extends OutcomeBase {
  policy?: Policy;
  harness?: Record<string, unknown>;
  platform?: Record<string, unknown>;
  protection?: Record<string, unknown>;
  detected?: Record<string, unknown>;
  /** #292: the managed .gitignore block for the local delivery assets (absent with --no-ignore). */
  ignore?: { path: string; entries: string[]; created: boolean };
  /**
   * #305: what the managed-asset reconciliation transaction did to converge
   * the repository to this version's desired init-owned asset set —
   * created/updated/removed asset paths, plus removal candidates preserved
   * because SpecGit ownership could not be proven.
   */
  reconciled?: { created: string[]; updated: string[]; removed: string[]; preserved: string[] };
  /** #352: the adoption hand-off steps; present only on a fresh adoption (harness not yet tracked). */
  nextActions?: NextAction[];
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
  if ('recordState' in outcome) optional.push(['recordState', outcome.recordState]);
  if ('localContext' in outcome) optional.push(['localContext', outcome.localContext]);
  if ('lifecycle' in outcome) optional.push(['lifecycle', outcome.lifecycle]);
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
  if ('reconciled' in outcome) optional.push(['reconciled', outcome.reconciled]);
  if ('ignore' in outcome) optional.push(['ignore', outcome.ignore]);
  if ('nextActions' in outcome) optional.push(['nextActions', outcome.nextActions]);
  if ('urls' in outcome) optional.push(['urls', outcome.urls]);
  if ('assets' in outcome) optional.push(['assets', outcome.assets]);
  if ('automation' in outcome) optional.push(['automation', outcome.automation]);
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

/**
 * The shared human rendering builder (#190). Every command composes its
 * `CommandOutcome.human` lines through this builder and the line formatters
 * below instead of bespoke string assembly, so the human surface has one
 * home and one set of byte shapes (locked by the CLI suites).
 *
 * Localization is pass-through: catalog text from `catalogFor(language)` is
 * appended verbatim — the builder only owns structure (order, indentation),
 * never wording.
 */
export interface HumanBuilder {
  /** A top-level line (catalog prose, headline, status line). */
  line(text: string): HumanBuilder;
  /** Pre-rendered lines (nested groups, formatter batches); empty is a no-op. */
  append(lines: string[]): HumanBuilder;
  /** A two-space indented detail line. */
  detail(text: string): HumanBuilder;
  /** A two-space indented `- ` bullet item. */
  bullet(text: string): HumanBuilder;
  /** Snapshot of the composed lines; later appends do not leak into it. */
  build(): string[];
}

export function humanBuilder(initial: string[] = []): HumanBuilder {
  const lines = [...initial];
  const builder: HumanBuilder = {
    line(text: string): HumanBuilder {
      lines.push(text);
      return builder;
    },
    append(entries: string[]): HumanBuilder {
      lines.push(...entries);
      return builder;
    },
    detail(text: string): HumanBuilder {
      return builder.line(detailLine(text));
    },
    bullet(text: string): HumanBuilder {
      return builder.line(bulletItem(text));
    },
    build(): string[] {
      return [...lines];
    },
  };
  return builder;
}

/** Two-space indented detail line (bind context, init skipped workflows). */
export function detailLine(text: string): string {
  return `  ${text}`;
}

/** Two-space indented `- ` bullet item (setup installed entry points). */
export function bulletItem(text: string): string {
  return `  - ${text}`;
}

/** Unexpected-error headline; the message is sanitized before the terminal. */
export function errorLine(message: string): string {
  return `Error: ${sanitize(message)}`;
}

/**
 * Warning line for human summaries (#215): sanitized like `errorLine` —
 * every formatter that interpolates runtime-sourced text goes through the
 * same terminal guard, no exceptions by provenance.
 */
export function warningLine(message: string): string {
  return `Warning: ${sanitize(message)}`;
}

/** One doctor probe line: `ok    <name> — <detail>` or `FAIL  <name> (<code>)`. */
export function probeLine(probe: ProbeResult): string {
  return probe.ok
    ? `ok    ${probe.name}${probe.detail ? ` — ${probe.detail}` : ''}`
    : `FAIL  ${probe.name}${probe.code ? ` (${probe.code})` : ''}`;
}

/**
 * The status-surface gate failure: `Gate <id>: <code>[ — <fix>]` (#215:
 * code and fix are runtime-sourced, so both pass the terminal guard).
 */
export function gateFailureLine(gateId: string, code: string, fix?: string): string {
  return `Gate ${gateId}: ${sanitize(code)}${fix ? ` — ${sanitize(fix)}` : ''}`;
}

/**
 * The accept/finish-surface gate failure line: `  <id>: <code>`. The
 * evidence structure only — the fix belongs to the diagnostics renderer
 * below, which prints it exactly once (#362).
 */
export function verdictFailureLine(gateId: string, code: string): string {
  return `  ${gateId}: ${sanitize(code)}`;
}

/** Issue numbers as closing-ref style references: `#1, #2`. */
export function issueList(issues: number[]): string {
  return issues.map((n) => `#${n}`).join(', ');
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
      // #362: a warning's fix is advisory guidance — it reaches the
      // human exactly once, as a Next line.
      if (diagnostic.fix) {
        io.stderr(`Next: ${sanitize(diagnostic.fix)}`);
      }
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
