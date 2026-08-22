import type { Diagnostic } from '../../kernel/diagnostics.js';
import type { Evidence } from '../../kernel/evidence.js';
import type { Policy } from '../../record/policy.js';
import type { DeliveryBinding } from '../../record/schema.js';
import type { GitFacts, GitPort } from '../../gitfacts/port.js';
import type { RepoRef } from '../../gitfacts/origin.js';
import type { ForgeProvider, PrFact } from '../../github/port.js';
import { CODE_INFO, type SpecGitCode } from '../codes.js';

/**
 * The shared surface of the acceptance gates (#276): the gate identity,
 * the failure shape every gate returns, and the explicit context the
 * driver threads through the walk. Gate implementations live one per
 * file in this directory and are registered in `index.ts`.
 */

export type GateId =
  | 'record'
  | 'policy'
  | 'completeness'
  | 'context'
  | 'origin'
  | 'provider'
  | 'issues'
  | 'sequence'
  | 'pr'
  | 'closing'
  | 'checks';

export interface GateFailure {
  code: SpecGitCode;
  message: string;
  detail?: unknown;
  fix?: string;
}

export interface VerdictEvidence {
  root: string | null;
  repo: string | null;
  delivery: string | null;
  branch: string | null;
  headSha: string | null;
  dirty: boolean | null;
  upstreamDrift: { ahead: number; behind: number } | null;
  context: { kind: 'branch' } | { kind: 'worktree' } | null;
  issues: number[] | null;
  pr: number | null;
  prHead: string | null;
}

export interface EvaluateInput {
  root: Evidence<string>;
  record: Evidence<DeliveryBinding>;
  policy: Evidence<Policy>;
  git: GitPort;
  gh?: ForgeProvider;
  /** Declared self-hosted GitLab host (spec_git/providers.yaml), if any. */
  gitlabHost?: string;
}

/**
 * The explicit evaluation context threaded through every gate (#276).
 * Gates read the inputs and the evidence prior gates published, and
 * publish their own findings back onto it — because the context is an
 * explicit typed object instead of closures over driver locals, the walk
 * needs no type assertions anywhere.
 */
export interface GateContext {
  readonly input: EvaluateInput;
  /** The delivery binding, once the record gate admitted it. */
  readonly binding: DeliveryBinding | null;
  /** The policy, once the policy gate admitted it. */
  readonly policy: Policy | null;
  /** The verdict evidence object gates publish into. */
  readonly evidence: VerdictEvidence;
  /** Advisory diagnostics; warnings never block the verdict. */
  readonly warnings: Diagnostic[];
  /** Git facts, published by the context gate. */
  facts: GitFacts | null;
  /** True when the record belongs to a delivery whose PR already merged. */
  mergedRecord: boolean;
  /** The resolved origin, published by the origin gate. */
  repoRef: RepoRef | null;
  /** The bound pull request fact, published by the pr gate. */
  prFact: PrFact | null;
}

/** The one gate shape: read the context, publish evidence, return failures. */
export type GateFn = (context: GateContext) => Promise<GateFailure[]> | GateFailure[];

/**
 * One failure construction site for every gate: the diagnostic prose comes
 * from the code registry, so gate modules never restate it.
 */
export function makeFailure(code: string, detail?: unknown): GateFailure {
  const info = CODE_INFO[code as SpecGitCode];
  return {
    code: code as SpecGitCode,
    message: info?.message ?? code,
    fix: info?.fix,
    ...(detail === undefined ? {} : { detail }),
  };
}
