/** Approved, exact-head completion shared by local and remote callers. */
import { verifyCiEntry } from '../verification/resolve.js';
import { verifyRepairResolution } from '../acceptance/repair-obligations.js';
import type { PrFact } from '../github/port.js';
import { classifyCiEligibility } from '../automation/ci-eligibility.js';
import { hasUnboundClosingRefs } from '../github/closing-refs.js';
import { extractOriginHost } from '../gitfacts/origin.js';
import { readRepairLog, repairLogHash } from '../automation/repair-log.js';
import type { Evidence } from '../kernel/evidence.js';
import type { PolicyLanguage } from '../record/policy.js';
import type {
  CompletionClassification, CompletionDependencies, CompletionInput,
  CompletionObservation, CompletionProgress,
} from './types.js';

const FULL_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

export async function completeDelivery(
  input: CompletionInput, ctx: CompletionDependencies,
): Promise<CompletionObservation> {
  const options = input;
  let language: PolicyLanguage | undefined;
  let repairIssues: number[] | undefined;
  const progress: CompletionProgress = { status: 'blocked', merged: false, closedIssues: [] };
  const stop = (code: string, message: string, classification: CompletionClassification = 'rejected', fix?: string): CompletionObservation => ({
    classification,
    language,
    ...(repairIssues?.length ? { repairIssues } : {}),
    progress: {
      ...progress,
      status: classification === 'unknown' ? 'unknown' : progress.status,
      closedIssues: [...progress.closedIssues],
    },
    diagnostics: [{ severity: 'error', code, message, ...(fix === undefined ? {} : { fix }) }],
  });
  const unavailable = (failure: Extract<Evidence<unknown>, { ok: false }>): CompletionObservation =>
    stop(failure.code, failure.message, 'unknown', failure.fix);

  const root = input.root;
  if (!root.ok) return unavailable(root);
  const record = await ctx.record.readRecord(root.value);
  const resolved = await ctx.resolvePolicy(root.value, record, { requireApproved: true });
  const policy = resolved.ok ? { ok: true as const, value: resolved.value.policy } : resolved;
  if (!record.ok) return unavailable(record);
  if (!policy.ok) return unavailable(policy);
  const automation = policy.value.automation;
  if (options.closeOnly && automation?.close_issues !== true) {
    return stop('closure_disabled', 'Automatic issue closure is not enabled in spec_git/policy.yaml.', 'disabled',
      'Only the user may enable it: run "specgit init --force --close-issues yes --close-target <branch>".');
  }
  if (!options.closeOnly && automation?.merge !== true) {
    return stop('automation_disabled', 'Merge automation is not enabled in spec_git/policy.yaml.', 'disabled',
      'Only the user may enable it: run "specgit init --force --automation yes --merge-target <branch>" with their explicit target choice.');
  }
  if (automation?.target_branch === undefined) {
    return stop('automation_target_required', 'Configure automation.target_branch before merging.', 'disabled');
  }
  if (record.value.pr === undefined || record.value.issues.length === 0) {
    return stop('automation_binding_incomplete', 'Bind the delivery issues and PR/MR before merging.', 'disabled');
  }
  progress.targetBranch = automation.target_branch;
  language = policy.value.language;
  const explainLineage = (outcome: CompletionObservation): CompletionObservation => ({
    ...outcome, recovery: { kind: 'fetch-target', operation: options.closeOnly ? 'close-only' : 'merge-and-close' },
  });

  const facts = await ctx.git.facts(root.value);
  if (!facts.originUrl) return stop('no_origin', 'No origin remote is configured.', 'unknown');
  const repo = await ctx.parseRepoRef(facts.originUrl);
  if (!repo.ok) return unavailable(repo);
  const initial = await ctx.gh.getPr(repo.value, record.value.pr);
  if (!initial.ok) return unavailable(initial);
  const observed = initial.value;
  progress.pr = observed.number;
  progress.headSha = observed.headSha;
  progress.merged = observed.state === 'merged';
  if (!FULL_SHA.test(observed.headSha)) {
    return stop('automation_head_unavailable', 'The PR/MR head is not a full commit SHA.', 'unknown');
  }
  if (observed.baseBranch !== automation.target_branch) {
    return stop('automation_target_mismatch', `The PR/MR targets '${observed.baseBranch}', but automation permits '${automation.target_branch}'.`);
  }
  if (options.closeOnly && observed.state !== 'merged') {
    return stop('automation_merge_required', 'Issue closure requires a PR/MR already confirmed merged into the configured target.');
  }
  const originHost = extractOriginHost(facts.originUrl);
  const nonDefaultPort = originHost?.port !== null && originHost?.port !== undefined &&
    !((originHost.scheme === 'https' && originHost.port === '443') ||
      (originHost.scheme === 'ssh' && originHost.port === '22'));
  const closingHost = originHost === null ? undefined :
    `${originHost.host}${nonDefaultPort ? `:${originHost.port}` : ''}`;
  if (hasUnboundClosingRefs(observed.body, repo.value.platform, {
    projectPath: `${repo.value.owner}/${repo.value.repo}`, host: closingHost,
  }, record.value.issues)) {
    return stop('automation_unbound_closing_refs', 'The PR/MR body contains closing references outside the bound issues. Remove or replace those references before automated merging.');
  }

  // A resumed closure must prove which merged delivery the checkout
  // contains, even when the old source branch still exists.
  if (observed.state === 'merged') {
    if (!observed.mergeCommitSha) {
      return explainLineage(stop('merged_lineage_unavailable', 'The merged PR/MR has no lineage anchor.', 'unknown'));
    }
    const lineage = await ctx.git.headContains(root.value, observed.mergeCommitSha);
    if (!lineage.ok) {
      return explainLineage(unavailable(lineage));
    }
    if (!lineage.value.contained) {
      return explainLineage(stop('merged_delivery_not_contained', 'Local HEAD does not contain the merged delivery.', 'rejected',
        `Fetch and check out the target branch containing the merge, then retry "specgit pr ${options.closeOnly ? '--close-issues' : '--merge'}".`));
    }
  }

  const verdict = await ctx.evaluate({ root, record, policy, policySha: resolved.ok ? resolved.value.sha : undefined, git: ctx.git, gh: ctx.gh });
  repairIssues = verdict.evidence.repairIssues;
  if (verdict.exitCode !== 0 || !verdict.accepted || !verdict.complete) {
    const failure = verdict.gates.flatMap((gate) => gate.failures)[0];
    if (failure?.code === 'checks_pending') progress.status = 'pending';
    return stop(failure?.code ?? 'automation_not_accepted', failure?.message ?? 'Acceptance has not passed.',
      verdict.exitCode === 1 ? 'rejected' : 'unknown', failure?.fix);
  }
  if (verdict.evidence.pr !== observed.number || verdict.evidence.prHead !== observed.headSha) {
    return stop('automation_head_changed', 'The PR/MR changed while acceptance was evaluated. Retry with fresh evidence.');
  }
  const repairLog = await readRepairLog(repo.value, observed.number, ctx.gh);
  if (!repairLog.ok) return unavailable(repairLog);
  const expectedRepairHash = verdict.evidence.repairLogHash ?? repairLogHash([]);
  if (repairLogHash(repairLog.value) !== expectedRepairHash) {
    return stop('repair_log_changed', 'Repair obligations changed while acceptance was evaluated.', 'unknown');
  }
  const issueNumbers = [...new Set([...record.value.issues, ...(verdict.evidence.repairIssues ?? [])])];

  const ci = await ctx.gh.getPrChecks(repo.value, observed.number);
  if (!ci.ok) return unavailable(ci);
  if (ci.value.headSha !== observed.headSha) {
    return stop('automation_head_changed', 'CI/CD evidence belongs to a different PR/MR head.');
  }
  const eligibility = classifyCiEligibility(ci.value.checks, verdict.evidence.verification?.requiredChecks ?? policy.value.required_checks);
  if (eligibility.empty) return stop('automation_checks_missing', 'No CI/CD checks were reported for the PR/MR head.');
  if (eligibility.missingRequired.length > 0) {
    return stop('automation_checks_missing', `Required checks are missing: ${eligibility.missingRequired.join(', ')}.`);
  }
  if (repo.value.platform === 'gitlab' && ci.value.pipelineStatus !== 'success') {
    if (ci.value.pipelineStatus === undefined) {
      return stop('automation_pipeline_unavailable', 'The GitLab head pipeline status is unavailable.', 'unknown');
    }
    progress.status = ['created', 'pending', 'preparing', 'running', 'waiting_for_resource', 'scheduled', 'manual']
      .includes(ci.value.pipelineStatus) ? 'pending' : 'blocked';
    return stop('automation_pipeline_not_successful', `The GitLab head pipeline is ${ci.value.pipelineStatus}.`);
  }
  const firstProblem = eligibility.problems[0];
  if (firstProblem !== undefined) {
    const { check } = firstProblem;
    if (firstProblem.kind === 'pending') {
      progress.status = 'pending';
      return stop('automation_checks_pending', `CI/CD check '${check.name}' is ${check.status}.`);
    }
    return stop('automation_checks_failed', `CI/CD check '${check.name}' concluded ${check.conclusion ?? 'unknown'}.`);
  }
  if (eligibility.executedCount === 0) return stop('automation_checks_missing', 'No executed CI/CD checks prove this head successful.');

  if (repairLog.value.some((operation) => operation.issue !== undefined && !record.value.issues.includes(operation.issue))) {
    const anchor = await ctx.gh.getEvidenceAnchor(repo.value, observed.number);
    if (!anchor.ok) return unavailable(anchor);
    const repairs = await verifyRepairResolution({
      operations: repairLog.value, boundIssues: record.value.issues,
      root: root.value, repo: repo.value, request: observed, policy: policy.value,
      git: ctx.git, forge: ctx.gh, checks: ci.value,
      anchor: anchor.value.anchoredAt ?? null, host: closingHost,
    });
    if (!repairs.ok) return unavailable(repairs);
  }

  const bindingUnchanged = async (checkPolicy = true): Promise<CompletionObservation | null> => {
    const currentRecord = await ctx.record.readRecord(root.value);
    if (!currentRecord.ok) return unavailable(currentRecord);
    if (JSON.stringify(currentRecord.value) !== JSON.stringify(record.value)) {
      return stop('automation_binding_changed', 'The delivery binding changed during automation. Retry with fresh evidence.');
    }
    const currentRepairs = await readRepairLog(repo.value, observed.number, ctx.gh);
    if (!currentRepairs.ok) return unavailable(currentRepairs);
    if (repairLogHash(currentRepairs.value) !== expectedRepairHash) {
      return stop('repair_log_changed', 'Repair obligations changed during completion. Retry with fresh evidence.', 'unknown');
    }
    if (!checkPolicy) return null;
    const currentResolved = await ctx.resolvePolicy(root.value, currentRecord, { requireApproved: true });
    const currentPolicy = currentResolved.ok ? { ok: true as const, value: currentResolved.value.policy } : currentResolved;
    if (!currentRecord.ok) return unavailable(currentRecord);
    if (!currentPolicy.ok) return unavailable(currentPolicy);
    if (JSON.stringify(currentRecord.value) !== JSON.stringify(record.value) ||
        JSON.stringify(currentPolicy.value) !== JSON.stringify(policy.value) ||
        (policy.value.verification && resolved.ok && currentResolved.ok && currentResolved.value.sha !== resolved.value.sha)) {
      return stop('automation_binding_changed', 'The delivery binding or policy changed during automation. Retry with fresh evidence.');
    }
    const entry = await verifyCiEntry({ policy: policy.value, request: observed, repo: repo.value, forge: ctx.gh });
    if (!entry.ok) return unavailable(entry);
    return null;
  };
  const changedPr = (current: PrFact): boolean =>
    current.number !== observed.number || current.headSha !== observed.headSha ||
    current.headBranch !== observed.headBranch || current.baseBranch !== observed.baseBranch ||
    current.body !== observed.body || current.draft;

  const localChange = await bindingUnchanged();
  if (localChange) return localChange;
  const beforeMerge = await ctx.gh.getPr(repo.value, observed.number);
  if (!beforeMerge.ok) return unavailable(beforeMerge);
  if (changedPr(beforeMerge.value)) {
    return stop('automation_head_changed', 'The PR/MR changed after CI/CD verification. Retry with fresh evidence.');
  }
  if (beforeMerge.value.state !== 'merged') {
    if (options.closeOnly) return stop('automation_merge_unconfirmed', 'The request is no longer confirmed merged.');
    if (beforeMerge.value.state !== 'open') return stop('pr_closed_unmerged', 'The PR/MR closed without merging.');
    const merged = await ctx.gh.mergePr(repo.value, observed.number, observed.headSha);
    if (!merged.ok) return unavailable(merged);
    if (!merged.value.merged) {
      progress.status = 'pending';
      return stop('automation_merge_pending', 'The platform has not completed the requested merge.');
    }
  }
  const confirmed = await ctx.gh.getPr(repo.value, observed.number);
  if (!confirmed.ok) return unavailable(confirmed);
  if (changedPr(confirmed.value)) {
    return stop('automation_head_changed', 'The merged PR/MR no longer matches the verified delivery.');
  }
  if (confirmed.value.state !== 'merged') {
    progress.status = 'pending';
    return stop('automation_merge_unconfirmed', 'The platform has not confirmed the PR/MR as merged.');
  }
  progress.merged = true;
  const afterMergeChange = await bindingUnchanged(false);
  if (afterMergeChange) return afterMergeChange;

  if (automation.close_issues) {
    for (const number of issueNumbers) {
      const issue = await ctx.gh.getIssue(repo.value, number);
      if (!issue.ok) return unavailable(issue);
      if (issue.value.number !== number || issue.value.pullRequest) {
        return stop('automation_issue_mismatch', `Bound issue #${number} did not resolve to that issue.`);
      }
      if (issue.value.state === 'closed') continue;
      const changed = await bindingUnchanged(false);
      if (changed) return changed;
      const closed = await ctx.gh.closeIssue(repo.value, number);
      if (!closed.ok) return unavailable(closed);
      if (!closed.value.closed) {
        return stop('automation_issue_close_unconfirmed', `The platform did not confirm issue #${number} closed.`, 'unknown');
      }
      progress.closedIssues.push(number);
    }
  }
  // A successful mutation response is not a final state observation. Check
  // every binding again, including issues the platform closed automatically.
  const stillOpen: number[] = [];
  for (const number of issueNumbers) {
    const issue = await ctx.gh.getIssue(repo.value, number);
    if (!issue.ok) return unavailable(issue);
    if (issue.value.number !== number || issue.value.pullRequest) {
      return stop('automation_issue_mismatch', `Bound issue #${number} did not resolve to that issue.`, 'unknown');
    }
    if (issue.value.state !== 'closed') stillOpen.push(number);
  }
  if (stillOpen.length > 0) {
    progress.status = 'pending';
    return stop('automation_issue_closure_pending', `The PR/MR is merged; bound issues remain open: ${stillOpen.join(', ')}.`, 'rejected',
      'Retry the configured completion runner after restoring issue-closure access.');
  }
  const finalChange = await bindingUnchanged(false);
  if (finalChange) return finalChange;
  progress.status = 'completed';
  return { classification: 'completed', progress, diagnostics: [], language };
}
