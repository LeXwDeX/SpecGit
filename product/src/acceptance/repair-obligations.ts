import { readRepairLog, repairCheckTarget, repairLogHash, repairPolicyHash, type RepairOperation } from '../automation/repair-log.js';
import { parsePrUrl, sameRepoRef } from '../gitfacts/origin.js';
import { fail, ok, type Evidence } from '../kernel/evidence.js';
import { parseNumericRef } from '../record/schema.js';
import { CODE_INFO } from './codes.js';
import { parseClosingRefs } from '../github/closing-refs.js';
import type { ForgeEvidencePort, MergeChecksFact, PrFact } from '../github/port.js';
import type { GitPort } from '../gitfacts/port.js';
import type { RepoRef } from '../gitfacts/origin.js';
import type { Policy } from '../record/policy.js';
import type { GateContext } from './gates/types.js';

/** Discover only writer-authorized request declarations; issue body markers cannot add obligations. */
export async function collectRepairObligations(ctx: GateContext): Promise<Evidence<number[]>> {
  const reference = ctx.binding!.pr!;
  let request: number | null = typeof reference === 'number' ? reference : parseNumericRef(reference);
  if (request === null && typeof reference === 'string') {
    const parsed = parsePrUrl(reference);
    if (parsed.ok && sameRepoRef(parsed.value.repo, ctx.repoRef!)) request = parsed.value.pr;
  }
  // The PR gate owns invalid or cross-repository request references.
  if (request === null) return ok([]);
  const log = await readRepairLog(ctx.repoRef!, request, ctx.input.gh!);
  if (!log.ok) return log;
  ctx.repairOperations = log.value;
  if (log.value.length === 0) return ok([]);
  ctx.evidence.repairLogHash = repairLogHash(log.value);
  const issues: number[] = [];
  for (const operation of log.value) {
    if (operation.issue === undefined) return fail('repair_creation_pending', 'A confirmed repair intent has no creation receipt yet.',
      'Resume the trusted completion runner to reconcile the recorded repair operation before completing this delivery.');
    if (!issues.includes(operation.issue)) issues.push(operation.issue);
  }
  ctx.evidence.repairIssues = issues;
  return ok(issues.filter((issue) => !ctx.binding!.issues.includes(issue)));
}

/** A removed check or changed policy cannot silently discharge an unbound repair. */
export interface RepairResolutionInput {
  operations: readonly RepairOperation[];
  boundIssues: readonly number[];
  root: string;
  repo: RepoRef;
  request: PrFact;
  policy: Policy;
  git: Pick<GitPort, 'isAncestor'>;
  forge: Pick<ForgeEvidencePort, 'listIssuePullRequests'>;
  checks: MergeChecksFact;
  anchor: string | null;
  host?: string;
}

export async function verifyRepairResolution(input: RepairResolutionInput): Promise<Evidence<void>> {
  const { anchor } = input;
  const unbound = input.operations.filter((operation) => operation.issue !== undefined && !input.boundIssues.includes(operation.issue));
  if (unbound.length === 0) return ok(undefined);
  const unknown = () => fail<void>('repair_resolution_unproven', 'Current evidence does not prove the original repair obligation resolved.',
    'Restore the original verification evidence, or explicitly adopt the repair with specgit bind --issue <number>, preserve its Closes reference, and review the updated delivery.');
  if (input.checks.headSha !== input.request.headSha) return unknown();
  for (const operation of unbound) {
    const claims = await input.forge.listIssuePullRequests(input.repo, operation.issue!);
    if (!claims.ok) return claims;
    if (claims.value.some((request) => request.number !== input.request.number && request.state === 'open' &&
      parseClosingRefs(request.body, input.repo.platform, {
        projectPath: `${input.repo.owner}/${input.repo.repo}`,
        host: input.host,
      }).has(operation.issue!))) return unknown();
    if (operation.policyHash !== repairPolicyHash(input.policy)) return unknown();
    const lineage = await input.git.isAncestor(input.root, operation.headSha, input.request.headSha);
    if (!lineage.ok) return lineage;
    if (!lineage.value.contained) return unknown();
    if (operation.cause.code !== 'checks_failed') {
      if (!Object.hasOwn(CODE_INFO, operation.cause.code)) return unknown();
      continue; // All preceding gates passed under the unchanged policy.
    }
    const matches = input.checks.checks.filter((check) => repairCheckTarget(input.repo.platform, check) === operation.cause.target);
    if (matches.length === 0 || matches.some((check) => check.status !== 'completed' || check.conclusion !== 'success' ||
      (anchor !== null && (!check.startedAt || !Number.isFinite(Date.parse(anchor)) ||
        !Number.isFinite(Date.parse(check.startedAt)) || Date.parse(check.startedAt) < Date.parse(anchor))))) return unknown();
  }
  return ok(undefined);
}
