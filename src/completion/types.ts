import type { EvaluateInput, Verdict } from '../acceptance/evaluate.js';
import type { ForgeDeliveryWritePort, ForgeEvidencePort } from '../github/port.js';
import type { RepoRef } from '../gitfacts/origin.js';
import type { Diagnostic } from '../kernel/diagnostics.js';
import type { Evidence } from '../kernel/evidence.js';
import type { EffectivePolicy } from '../record/effective-policy.js';
import type { PolicyLanguage } from '../record/policy.js';
import type { DeliveryBinding } from '../record/schema.js';

export interface CompletionInput {
  root: Evidence<string>;
  closeOnly?: boolean;
}

/** Reads needed for acceptance and only the two authorized completion writes. */
export type CompletionForge = NonNullable<EvaluateInput['gh']> &
  Pick<ForgeEvidencePort, 'getPrChecks'> &
  Pick<ForgeDeliveryWritePort, 'mergePr' | 'closeIssue'>;

export interface CompletionDependencies {
  git: EvaluateInput['git'];
  gh: CompletionForge;
  record: { readRecord(root: string): Promise<Evidence<DeliveryBinding>> };
  resolvePolicy(root: string, record: Evidence<DeliveryBinding>, options: { requireApproved: true }): Promise<Evidence<EffectivePolicy>>;
  evaluate(input: EvaluateInput): Promise<Verdict>;
  parseRepoRef(originUrl: string): Evidence<RepoRef> | Promise<Evidence<RepoRef>>;
}

export interface CompletionProgress {
  status: 'pending' | 'blocked' | 'unknown' | 'completed';
  pr?: number;
  headSha?: string;
  targetBranch?: string;
  merged: boolean;
  closedIssues: number[];
}

export type CompletionClassification = 'completed' | 'rejected' | 'unknown' | 'disabled' | 'idle';

/** Domain observation; process exits and human rendering belong to adapters. */
export interface CompletionObservation {
  classification: CompletionClassification;
  progress?: CompletionProgress;
  diagnostics: Diagnostic[];
  recovery?: { kind: 'fetch-target'; operation: 'close-only' | 'merge-and-close' };
  language?: PolicyLanguage;
}
