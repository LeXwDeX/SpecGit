/**
 * CLI-layer type surface. Every domain contract is re-exported from the
 * modules that own it (kernel, record, gitfacts, github, acceptance) — the
 * CLI never carries a parallel copy. CLI-owned additions: the RecordPort
 * shape (persistence as injected into commands), the evaluator function
 * type, and the command context.
 */

export { ok, fail } from '../kernel/evidence.js';
export type { Evidence } from '../kernel/evidence.js';
export type { Diagnostic, Severity } from '../kernel/diagnostics.js';

export {
  SPEC_GIT_DIR,
  POLICY_FILENAME,
  RECORD_FILENAME,
  isKebabId,
  KEBAB_ID_FIX,
} from '../record/schema.js';
export type { DeliveryBinding, ExecutionContext } from '../record/schema.js';
export type { Policy } from '../record/policy.js';

export type { GitFacts, GitPort } from '../gitfacts/port.js';
export type { RepoRef } from '../gitfacts/origin.js';

export type {
  ForgeProvider,
  GitHubProvider,
  IssueFact,
  PrFact,
  CheckRunInfo,
} from '../github/port.js';

export type {
  Verdict,
  VerdictEvidence,
  GateResult,
  GateFailure,
  EvaluateInput,
  DeliveryState as BindingState,
} from '../acceptance/evaluate.js';

import type { Evidence } from '../kernel/evidence.js';
import type { DeliveryBinding } from '../record/schema.js';
import type { Policy } from '../record/policy.js';
import type { GitPort } from '../gitfacts/port.js';
import type { RepoRef } from '../gitfacts/origin.js';
import type { ForgeProvider } from '../github/port.js';
import type { EvaluateInput, Verdict } from '../acceptance/evaluate.js';

// -----------------------------------------------------------------------------
// Record/policy persistence as seen from the CLI. Implemented by
// `src/record/io.ts`: reads fail closed with Evidence; writes and deletes
// throw on IO failure, which the CLI converts to fail-closed unknown exits.
// -----------------------------------------------------------------------------

export interface RecordPort {
  readRecord(root: string): Promise<Evidence<DeliveryBinding>>;
  writeRecord(root: string, record: DeliveryBinding): Promise<void>;
  deleteRecord(root: string): Promise<void>;
  readPolicy(root: string): Promise<Evidence<Policy>>;
  writePolicy(root: string, policy: Policy): Promise<void>;
}

export type EvaluateFn = (input: EvaluateInput) => Promise<Verdict>;

// -----------------------------------------------------------------------------
// CLI context: everything a command needs, injected at the composition root
// (`src/cli/wiring.ts` for production, test fakes for the focused suite).
// -----------------------------------------------------------------------------

export interface CliIO {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface CommandContext {
  io: CliIO;
  version: string;
  cwd: string;
  stdinIsTTY: boolean;
  discoverRoot(cwd: string): Promise<Evidence<string>>;
  probeGitBinary(): Promise<Evidence<string>>;
  git: GitPort;
  gh: ForgeProvider;
  record: RecordPort;
  evaluate: EvaluateFn;
  parseRepoRef(originUrl: string): Evidence<RepoRef> | Promise<Evidence<RepoRef>>;
}
