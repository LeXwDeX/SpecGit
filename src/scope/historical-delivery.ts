import YAML from 'yaml';
import { CODE_INFO } from '../acceptance/codes.js';
import { requiredCheckFailures } from '../acceptance/gates/checks-gate.js';
import { verifyRepairResolution } from '../acceptance/repair-obligations.js';
import { classifyCiEligibility } from '../automation/ci-eligibility.js';
import { readRepairLog, repairLogHash } from '../automation/repair-log.js';
import { parseClosingRefs, hasUnboundClosingRefs } from '../github/closing-refs.js';
import type { ForgeEvidencePort, PrFact } from '../github/port.js';
import { parsePrUrl, sameRepoRef, type RepoRef } from '../gitfacts/origin.js';
import type { GitPort } from '../gitfacts/port.js';
import { fail, ok, type Evidence } from '../kernel/evidence.js';
import { checkLabelConvention, checkTitleConvention } from '../record/conventions.js';
import { PolicySchema } from '../record/policy.js';
import { DeliveryBindingSchema, parseNumericRef, type DeliveryBinding } from '../record/schema.js';
import { checkBodyConvention } from '../record/templates.js';

export interface HistoricalDependencies {
  root: string;
  repo: RepoRef;
  host?: string;
  git: Pick<GitPort, 'readFileAtCommit' | 'readFileBeforeMerge' | 'isAncestor'>;
  forge: Pick<ForgeEvidencePort, 'getIssue' | 'getPr' | 'listIssuePullRequests' | 'getCheckRuns' | 'getPrChecks' | 'getEvidenceAnchor' | 'getRequestDeclarations'>;
}

export interface HistoricalDelivery {
  request: number;
  headSha: string;
  mergeSha: string;
  target: string;
  policySha: string;
  boundIssues: number[];
  repairIssues: number[];
  repairLogHash: string;
}

export type HistoricalObservation = { state: 'completed'; delivery: HistoricalDelivery } | {
  state: 'incomplete' | 'unknown'; diagnostic: { code: string; message: string; fix?: string };
};

const INCOMPLETE_CODES = new Set([
  'scope_delivery_unmerged', 'scope_target_mismatch', 'scope_closing_mismatch',
  'scope_closure_pending', 'scope_ci_incomplete', 'scope_pipeline_incomplete',
  ...Object.entries(CODE_INFO).filter(([, info]) => info.kind === 'factual').map(([code]) => code),
]);

export async function observeHistoricalDelivery(request: PrFact, binding: DeliveryBinding, deps: HistoricalDependencies): Promise<HistoricalObservation> {
  const evidence = await collectHistoricalDelivery(request, binding, deps);
  if (evidence.ok) return { state: 'completed', delivery: evidence.value };
  const { code, message, fix } = evidence;
  return { state: INCOMPLETE_CODES.has(code) ? 'incomplete' : 'unknown', diagnostic: { code, message, ...(fix ? { fix } : {}) } };
}

/** A remote reference suggests a relationship; only the retained head binding proves it. */
export async function readHistoricalBinding(request: PrFact, deps: HistoricalDependencies): Promise<Evidence<DeliveryBinding | null>> {
  const file = await deps.git.readFileAtCommit(deps.root, request.headSha, '.specgit.yaml');
  if (!file.ok) return file;
  if (file.value.content === null) return ok(null);
  try {
    const binding = DeliveryBindingSchema.safeParse(YAML.parse(file.value.content));
    if (!binding.success) return fail('scope_binding_invalid', 'The retained request-head binding is invalid.');
    let number = typeof binding.data.pr === 'number' ? binding.data.pr : null;
    if (typeof binding.data.pr === 'string') {
      number = parseNumericRef(binding.data.pr);
      if (number === null) {
        const parsed = parsePrUrl(binding.data.pr);
        if (parsed.ok && sameRepoRef(parsed.value.repo, deps.repo)) number = parsed.value.pr;
      }
    }
    if (number !== request.number || binding.data.context.branch !== request.headBranch) {
      return fail('scope_binding_mismatch', 'The retained binding does not identify this request and source branch.');
    }
    return ok(binding.data);
  } catch {
    return fail('scope_binding_invalid', 'The retained request-head binding is not valid YAML.');
  }
}

/** Historical completion has no claim about the caller's working tree or current branch. */
async function collectHistoricalDelivery(request: PrFact, binding: DeliveryBinding, deps: HistoricalDependencies): Promise<Evidence<HistoricalDelivery>> {
  if (request.state !== 'merged' || !request.mergeCommitSha || request.draft) {
    return fail('scope_delivery_unmerged', 'The member has no confirmed merged delivery.');
  }
  const policyFile = await deps.git.readFileBeforeMerge(deps.root, request.mergeCommitSha, request.headSha, 'spec_git/policy.yaml', request.targetHistorySha);
  if (!policyFile.ok) return policyFile;
  if (policyFile.value.content === null) return fail('scope_policy_unapproved', 'The delivery has no original approved policy.');
  let parsed;
  try { parsed = PolicySchema.safeParse(YAML.parse(policyFile.value.content)); }
  catch { return fail('policy_invalid', 'The original approved policy is not valid YAML.'); }
  if (!parsed.success) return fail('policy_invalid', 'The original approved policy is invalid.');
  const policy = parsed.data;
  if ((policy.automation?.merge || policy.automation?.close_issues) && policy.automation.target_branch !== request.baseBranch) {
    return fail('scope_target_mismatch', 'The request target differs from its original completion policy.');
  }
  for (const convention of [checkTitleConvention(policy, request.title), checkBodyConvention(policy, 'pr', request.body)]) {
    if (!convention.ok) return convention;
  }
  const closingScope = { projectPath: `${deps.repo.owner}/${deps.repo.repo}`, host: deps.host };
  const closing = parseClosingRefs(request.body, deps.repo.platform, closingScope);
  if (binding.issues.some((issue) => !closing.has(issue)) || hasUnboundClosingRefs(request.body, deps.repo.platform, closingScope, binding.issues)) {
    return fail('scope_closing_mismatch', 'The request closing references and immutable binding disagree.');
  }
  const log = await readRepairLog(deps.repo, request.number, deps.forge);
  if (!log.ok) return log;
  if (log.value.some((operation) => operation.issue === undefined)) return fail('repair_creation_pending', 'A repair intent has no confirmed creation receipt.');
  const repairs = [...new Set(log.value.flatMap((operation) => operation.issue === undefined ? [] : [operation.issue]))];
  for (const issue of [...new Set([...binding.issues, ...repairs])]) {
    const fact = await deps.forge.getIssue(deps.repo, issue);
    if (!fact.ok) return fact;
    if (fact.value.number !== issue || fact.value.pullRequest) return fail('scope_issue_invalid', 'A bound issue was not confirmed as an issue.');
    if (fact.value.state !== 'closed') return fail('scope_closure_pending', `Issue #${issue} remains open.`);
    if (binding.issues.includes(issue)) {
      for (const convention of [checkTitleConvention(policy, fact.value.title), checkLabelConvention(policy, fact.value.labels), checkBodyConvention(policy, 'issue', fact.value.body)]) {
        if (!convention.ok) return convention;
      }
    }
  }
  const checks = await deps.forge.getPrChecks(deps.repo, request.number);
  if (!checks.ok) return checks;
  if (checks.value.headSha !== request.headSha) return fail('scope_ci_head_mismatch', 'CI evidence belongs to another request head.');
  if (deps.repo.platform === 'gitlab' && checks.value.pipelineStatus !== 'success') {
    return checks.value.pipelineStatus === undefined
      ? fail('scope_pipeline_unproven', 'The GitLab request-head pipeline state is unavailable.')
      : fail('scope_pipeline_incomplete', `The GitLab request-head pipeline is ${checks.value.pipelineStatus}.`);
  }
  if (!classifyCiEligibility(checks.value.checks, policy.required_checks).eligible) {
    return fail('scope_ci_incomplete', 'Applicable CI checks do not prove this delivery successful.');
  }
  const runs = await deps.forge.getCheckRuns(deps.repo, request.headSha, request.number);
  if (!runs.ok) return runs;
  const anchor = await deps.forge.getEvidenceAnchor(deps.repo, request.number);
  if (!anchor.ok) return anchor;
  const failures = requiredCheckFailures(runs.value, policy.required_checks, anchor.value.anchoredAt);
  if (failures.length) return fail(failures[0].code, failures[0].message, failures[0].fix);
  const resolution = await verifyRepairResolution({ operations: log.value, boundIssues: binding.issues,
    root: deps.root, repo: deps.repo, request, policy, git: deps.git, forge: deps.forge,
    checks: checks.value, anchor: anchor.value.anchoredAt, host: deps.host });
  if (!resolution.ok) return resolution;
  const refreshed = await deps.forge.getPr(deps.repo, request.number);
  if (!refreshed.ok) return refreshed;
  if (JSON.stringify(refreshed.value) !== JSON.stringify(request)) return fail('scope_request_changed', 'The request changed during scope assessment. Retry with fresh evidence.');
  const finalLog = await readRepairLog(deps.repo, request.number, deps.forge);
  if (!finalLog.ok) return finalLog;
  if (repairLogHash(log.value) !== repairLogHash(finalLog.value)) return fail('repair_log_changed', 'Repair obligations changed during scope assessment.');
  return ok({ request: request.number, headSha: request.headSha, mergeSha: request.mergeCommitSha,
    target: request.baseBranch, policySha: policyFile.value.sha, boundIssues: binding.issues,
    repairIssues: repairs, repairLogHash: repairLogHash(log.value) });
}
