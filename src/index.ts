/**
 * SpecGit public API.
 *
 * The product surface is the `specgit` CLI (`bin/specgit.js` →
 * `dist/cli/index.js`). The library export re-exposes the delivery-binding
 * domain so tools can compose the same building blocks the CLI uses:
 * record/policy IO, local git facts, the GitHub provider seam, and the
 * fail-closed acceptance evaluator. Acceptance is derived exclusively from
 * git, PR, and check evidence — spec/task artifacts are never inputs.
 */

export { runCli, runMain, createProgram } from './cli/index.js';

export { ok, fail } from './kernel/evidence.js';
export type { Evidence } from './kernel/evidence.js';
export type { Diagnostic, Severity } from './kernel/diagnostics.js';

export {
  SPEC_GIT_DIR,
  POLICY_FILENAME,
  RECORD_FILENAME,
  KEBAB_ID_REGEX,
  KEBAB_ID_FIX,
  isKebabId,
  ExecutionContextSchema,
  DeliveryBindingSchema,
  mergeIssueNumbers,
  parseNumericRef,
} from './record/schema.js';
export type { ExecutionContext, DeliveryBinding } from './record/schema.js';

export { PolicySchema } from './record/policy.js';
export type { Policy } from './record/policy.js';

export {
  recordPath,
  policyDir,
  policyPath,
  writeFileAtomically,
  readRecord,
  writeRecord,
  deleteRecord,
  readPolicy,
  writePolicy,
} from './record/io.js';

export { discoverRepoRoot } from './record/root.js';

export type {
  GitFacts,
  GitPort,
  GitWritePort,
  SpawnFn,
  SpawnOptions,
  BranchCheckout,
} from './gitfacts/port.js';
export { GIT_PORT_MEMBERS } from './gitfacts/port.js';
export { LocalGitAdapter } from './gitfacts/local.js';
export type { LocalGitAdapterOptions } from './gitfacts/local.js';
export {
  parseRepoRef,
  formatRepoRef,
  requireGithubRoute,
  sameRepoRef,
  parsePrUrl,
} from './gitfacts/origin.js';
export type { RepoRef } from './gitfacts/origin.js';

export type {
  GitHubProvider,
  IssueFact,
  PrFact,
  CheckRunInfo,
  IssueCreation,
  PrCreation,
  PrSummary,
  BranchProtectionFact,
  RepoAutomergeFact,
} from './github/port.js';
export { GITHUB_PROVIDER_MEMBERS } from './github/port.js';
export { GhCliGitHubProvider, sanitizeApiText } from './providers/github/gh-cli.js';
export type { GhCliGitHubProviderOptions } from './providers/github/gh-cli.js';
export { GlabProvider, versionInWindow } from './providers/gitlab/glab-cli.js';
export type { GlabProviderOptions } from './providers/gitlab/glab-cli.js';
export { parseClosingRefs } from './github/closing-refs.js';

export { CODE_INFO } from './acceptance/codes.js';
export type { SpecGitCode, CodeKind, CodeInfo } from './acceptance/codes.js';
export { evaluate } from './acceptance/evaluate.js';
export type {
  DeliveryState,
  VerdictClassification,
  GateId,
  GateFailure,
  GateResult,
  VerdictEvidence,
  Verdict,
  EvaluateInput,
} from './acceptance/evaluate.js';
