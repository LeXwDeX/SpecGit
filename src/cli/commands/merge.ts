/** Configured, exact-head merge execution behind `specgit pr --merge`. */
import type { PrFact } from '../../github/port.js';
import { classifyCiEligibility } from '../../automation/ci-eligibility.js';
import { hasUnboundClosingRefs } from '../../github/closing-refs.js';
import { extractOriginHost } from '../../gitfacts/origin.js';
import { EXIT_REJECTED, EXIT_SUCCESS, EXIT_UNKNOWN, EXIT_USAGE } from '../exit-codes.js';
import { errorDiagnostic, humanBuilder, renderNextActionsHuman, type NextAction, type PrAutomation, type PrOutcome } from '../output.js';
import { catalogFor, resolveLanguage } from '../language.js';
import type { CommandContext, Evidence } from '../types.js';

const FULL_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

export async function runMerge(ctx: CommandContext): Promise<PrOutcome> {
  const progress: PrAutomation = { status: 'blocked', merged: false, closedIssues: [] };
  const stop = (code: string, message: string, exit = EXIT_REJECTED, fix?: string): PrOutcome => ({
    exit,
    ...(progress.pr !== undefined ? { state: progress.merged ? 'closure_pending' as const : 'bound' as const } : {}),
    automation: {
      ...progress,
      status: exit === EXIT_UNKNOWN ? 'unknown' : progress.status,
      closedIssues: [...progress.closedIssues],
    },
    errors: [errorDiagnostic(code, message, fix === undefined ? {} : { fix })],
  });
  const unavailable = (failure: Extract<Evidence<unknown>, { ok: false }>): PrOutcome =>
    stop(failure.code, failure.message, EXIT_UNKNOWN, failure.fix);

  const root = await ctx.discoverRoot(ctx.cwd);
  if (!root.ok) return unavailable(root);
  const record = await ctx.record.readRecord(root.value);
  const resolved = await ctx.resolvePolicy(root.value, record, { requireApproved: true });
  const policy = resolved.ok ? { ok: true as const, value: resolved.value.policy } : resolved;
  if (!record.ok) return unavailable(record);
  if (!policy.ok) return unavailable(policy);
  const automation = policy.value.automation;
  if (automation?.merge !== true) {
    return stop('automation_disabled', 'Merge automation is not enabled in spec_git/policy.yaml.', EXIT_USAGE,
      'Only the user may enable it: run "specgit init --force --automation yes --merge-target <branch>" with their explicit target choice.');
  }
  if (automation.target_branch === undefined) {
    return stop('automation_target_required', 'Configure automation.target_branch before merging.', EXIT_USAGE);
  }
  if (record.value.pr === undefined || record.value.issues.length === 0) {
    return stop('automation_binding_incomplete', 'Bind the delivery issues and PR/MR before merging.', EXIT_USAGE);
  }
  progress.targetBranch = automation.target_branch;
  const { human } = catalogFor(resolveLanguage(policy.value));
  const lineageActions: NextAction[] = [{
    code: 'merge_lineage', command: 'git fetch origin',
    reason: `Fetch and check out '${automation.target_branch}' containing the merge, then retry specgit pr --merge.`,
  }];
  const explainLineage = (outcome: PrOutcome): PrOutcome => ({
    ...outcome, nextActions: lineageActions,
    human: renderNextActionsHuman(human.nextHeadline(), lineageActions),
  });

  const facts = await ctx.git.facts(root.value);
  if (!facts.originUrl) return stop('no_origin', 'No origin remote is configured.', EXIT_UNKNOWN);
  const repo = await ctx.parseRepoRef(facts.originUrl);
  if (!repo.ok) return unavailable(repo);
  const initial = await ctx.gh.getPr(repo.value, record.value.pr);
  if (!initial.ok) return unavailable(initial);
  const observed = initial.value;
  progress.pr = observed.number;
  progress.headSha = observed.headSha;
  progress.merged = observed.state === 'merged';
  if (!FULL_SHA.test(observed.headSha)) {
    return stop('automation_head_unavailable', 'The PR/MR head is not a full commit SHA.', EXIT_UNKNOWN);
  }
  if (observed.baseBranch !== automation.target_branch) {
    return stop('automation_target_mismatch', `The PR/MR targets '${observed.baseBranch}', but automation permits '${automation.target_branch}'.`);
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
      return explainLineage(stop('merged_lineage_unavailable', 'The merged PR/MR has no lineage anchor.', EXIT_UNKNOWN));
    }
    const lineage = await ctx.git.headContains(root.value, observed.mergeCommitSha);
    if (!lineage.ok) {
      return explainLineage(unavailable(lineage));
    }
    if (!lineage.value.contained) {
      return explainLineage(stop('merged_delivery_not_contained', 'Local HEAD does not contain the merged delivery.', EXIT_REJECTED,
        'Fetch and check out the target branch containing the merge, then retry "specgit pr --merge".'));
    }
  }

  const verdict = await ctx.evaluate({ root, record, policy, git: ctx.git, gh: ctx.gh });
  if (verdict.exitCode !== 0 || !verdict.accepted || !verdict.complete) {
    const failure = verdict.gates.flatMap((gate) => gate.failures)[0];
    if (failure?.code === 'checks_pending') progress.status = 'pending';
    return stop(failure?.code ?? 'automation_not_accepted', failure?.message ?? 'Acceptance has not passed.',
      verdict.exitCode === 0 ? EXIT_UNKNOWN : verdict.exitCode, failure?.fix);
  }
  if (verdict.evidence.pr !== observed.number || verdict.evidence.prHead !== observed.headSha) {
    return stop('automation_head_changed', 'The PR/MR changed while acceptance was evaluated. Retry with fresh evidence.');
  }

  const ci = await ctx.gh.getPrChecks(repo.value, observed.number);
  if (!ci.ok) return unavailable(ci);
  if (ci.value.headSha !== observed.headSha) {
    return stop('automation_head_changed', 'CI/CD evidence belongs to a different PR/MR head.');
  }
  const eligibility = classifyCiEligibility(ci.value.checks, policy.value.required_checks);
  if (eligibility.empty) return stop('automation_checks_missing', 'No CI/CD checks were reported for the PR/MR head.');
  if (eligibility.missingRequired.length > 0) {
    return stop('automation_checks_missing', `Required checks are missing: ${eligibility.missingRequired.join(', ')}.`);
  }
  if (repo.value.platform === 'gitlab' && ci.value.pipelineStatus !== 'success') {
    if (ci.value.pipelineStatus === undefined) {
      return stop('automation_pipeline_unavailable', 'The GitLab head pipeline status is unavailable.', EXIT_UNKNOWN);
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

  const bindingUnchanged = async (checkPolicy = true): Promise<PrOutcome | null> => {
    const currentRecord = await ctx.record.readRecord(root.value);
    if (!currentRecord.ok) return unavailable(currentRecord);
    if (JSON.stringify(currentRecord.value) !== JSON.stringify(record.value)) {
      return stop('automation_binding_changed', 'The delivery binding changed during automation. Retry with fresh evidence.');
    }
    if (!checkPolicy) return null;
    const currentResolved = await ctx.resolvePolicy(root.value, currentRecord, { requireApproved: true });
    const currentPolicy = currentResolved.ok ? { ok: true as const, value: currentResolved.value.policy } : currentResolved;
    if (!currentRecord.ok) return unavailable(currentRecord);
    if (!currentPolicy.ok) return unavailable(currentPolicy);
    if (JSON.stringify(currentRecord.value) !== JSON.stringify(record.value) ||
        JSON.stringify(currentPolicy.value) !== JSON.stringify(policy.value)) {
      return stop('automation_binding_changed', 'The delivery binding or policy changed during automation. Retry with fresh evidence.');
    }
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
    for (const number of record.value.issues) {
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
        return stop('automation_issue_close_unconfirmed', `The platform did not confirm issue #${number} closed.`, EXIT_UNKNOWN);
      }
      progress.closedIssues.push(number);
    }
  }
  // A successful mutation response is not a final state observation. Check
  // every binding again, including issues the platform closed automatically.
  const stillOpen: number[] = [];
  for (const number of record.value.issues) {
    const issue = await ctx.gh.getIssue(repo.value, number);
    if (!issue.ok) return unavailable(issue);
    if (issue.value.number !== number || issue.value.pullRequest) {
      return stop('automation_issue_mismatch', `Bound issue #${number} did not resolve to that issue.`, EXIT_UNKNOWN);
    }
    if (issue.value.state !== 'closed') stillOpen.push(number);
  }
  if (stillOpen.length > 0) {
    progress.status = 'pending';
    return stop('automation_issue_closure_pending', `The PR/MR is merged; bound issues remain open: ${stillOpen.join(', ')}.`, EXIT_REJECTED,
      'Retry the configured completion runner after restoring issue-closure access.');
  }
  progress.status = 'completed';
  const nextActions: NextAction[] = [{
    code: 'next_delivery', command: 'specgit issue "<type>: <title>"',
    reason: human.finishHandoffReasons()['next_delivery'] ?? '',
  }];
  return {
    exit: EXIT_SUCCESS,
    state: 'completed',
    automation: progress,
    nextActions,
    human: humanBuilder()
      .line(human.automationCompleted(observed.number, observed.baseBranch))
      .append(renderNextActionsHuman(human.nextHeadline(), nextActions)).build(),
  };
}
