import type { CommandContext } from '../cli/types.js';
import type { PrOutcome } from '../cli/output.js';
import { parsePrUrl, sameRepoRef, type RepoRef } from '../gitfacts/origin.js';
import type { DeliveryBinding } from '../record/schema.js';
import { runMerge } from '../cli/commands/merge.js';
import { ensureFailureIssues, type DeliveryFailure } from './failure-issues.js';
import { classifyCiEligibility } from './ci-eligibility.js';
import { fail, ok, type Evidence } from '../kernel/evidence.js';
import type { Policy } from '../record/policy.js';

/** Checked before a privileged workflow loads this runtime. Increment for incompatible entry contracts. */
export const REMOTE_DELIVERY_PROTOCOL = 1;

export interface RemoteDeliveryInput {
  repo: RepoRef;
  pr: number;
  headSha: string;
  record: DeliveryBinding;
}

/** Retain the public record's numeric and full GitHub URL reference forms. */
export function matchesBoundRequest(record: DeliveryBinding, repo: RepoRef, pr: number): boolean {
  if (typeof record.pr === 'number') return record.pr === pr;
  if (typeof record.pr !== 'string') return false;
  if (/^[1-9][0-9]*$/.test(record.pr)) return Number(record.pr) === pr;
  const parsed = parsePrUrl(record.pr);
  return parsed.ok && parsed.value.repo.platform === repo.platform && sameRepoRef(parsed.value.repo, repo) && parsed.value.pr === pr;
}

/** Collect independent current causes, even when a sibling check is still pending. */
async function currentFailures(input: RemoteDeliveryInput, ctx: CommandContext, root: string, policy: Policy): Promise<Evidence<DeliveryFailure[]>> {
  const checks = await ctx.gh.getPrChecks(input.repo, input.pr);
  if (!checks.ok) return checks;
  if (checks.value.headSha !== input.headSha) return fail('automation_head_changed', 'Failure evidence belongs to a different request head.');
  const anchor = await ctx.gh.getEvidenceAnchor(input.repo, input.pr);
  if (!anchor.ok) return anchor;
  const boundary = anchor.value.anchoredAt == null ? null : Date.parse(anchor.value.anchoredAt);
  if (boundary !== null && !Number.isFinite(boundary)) return fail('automation_evidence_unknown', 'The failure evidence anchor is unavailable.');
  const failures: DeliveryFailure[] = [];
  for (const problem of classifyCiEligibility(checks.value.checks, policy.required_checks).problems) {
    if (problem.kind !== 'failed') continue;
    const { check } = problem;
    const started = check.startedAt === null ? Number.NaN : Date.parse(check.startedAt);
    if (boundary !== null && (!Number.isFinite(started) || started < boundary)) continue;
    const name = check.name.replace(/^downstream:(\d+)\/\d+:/, 'downstream:$1:');
    failures.push({ code: 'checks_failed', target: `${input.repo.platform}:${check.source ?? 'pipeline'}:${name}`,
      message: `CI/CD check '${check.name}' concluded ${check.conclusion ?? 'unknown'}.` });
  }
  const verdict = await ctx.evaluate({ root: ok(root), record: ok(input.record), policy: ok(policy), git: ctx.git, gh: ctx.gh });
  if (verdict.exitCode === 1) {
    for (const failure of verdict.gates.flatMap((gate) => gate.failures)) {
      if (['checks_pending', 'checks_missing', 'checks_failed', 'pr_draft'].includes(failure.code)) continue;
      const detail = failure.detail as { issue?: unknown; name?: unknown } | undefined;
      const target = detail?.issue !== undefined ? `issue:${String(detail.issue)}` : detail?.name !== undefined ? String(detail.name) : undefined;
      failures.push({ code: failure.code, message: failure.message, ...(target ? { target } : {}) });
    }
  }
  return ok(failures);
}

/** The workflow serializes by repository/request; this driver is shared by gh and glab runners. */
export async function runRemoteDelivery(
  input: RemoteDeliveryInput,
  ctx: CommandContext,
  options: { deadlineMs?: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void>;
    prepareMerged?: () => Promise<void> } = {},
): Promise<PrOutcome> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.deadlineMs ?? 20 * 60_000);
  const blocked = (code: string, message: string, exit = 3): PrOutcome => ({ exit, errors: [{ severity: 'error', code, message }] });
  if (!Number.isSafeInteger(input.pr) || input.pr <= 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.headSha) ||
      !matchesBoundRequest(input.record, input.repo, input.pr) || input.record.issues.length === 0) {
    return blocked('automation_event_invalid', 'The completion event must identify one bound request and full head SHA.');
  }
  // The immutable PR-head record remains available when closure recovery checks
  // out the merged target; a newer delivery's main-branch record cannot replace it.
  const boundContext: CommandContext = { ...ctx, record: { ...ctx.record, readRecord: async () => ({ ok: true, value: input.record }) } };
  let outcome: PrOutcome;
  do {
    const current = await ctx.gh.getPr(input.repo, input.pr);
    if (!current.ok) return blocked(current.code, current.message);
    if (current.value.headSha !== input.headSha || current.value.headBranch !== input.record.context.branch) {
      return blocked('automation_head_changed', 'The completion event no longer identifies the current delivery head.', 1);
    }
    if (current.value.draft) return blocked('pr_draft', 'A draft request cannot be completed automatically.', 1);
    if (current.value.state === 'merged' && options.prepareMerged) await options.prepareMerged();
    outcome = await runMerge(boundContext);
    if (outcome.exit === 0) return outcome;
    if (outcome.exit === 1 && !outcome.automation?.merged && current.value.state === 'open') {
      const root = await ctx.discoverRoot(ctx.cwd);
      if (!root.ok) return outcome;
      const approved = await ctx.resolvePolicy(root.value, ok(input.record), { requireApproved: true });
      if (!approved.ok) return outcome;
      const failures = await currentFailures(input, boundContext, root.value, approved.value.policy);
      if (!failures.ok) return blocked(failures.code, failures.message);
      if (failures.value.length > 0) {
        const repairs = await ensureFailureIssues({ repo: input.repo, pr: current.value,
          delivery: input.record.delivery, issueNumbers: input.record.issues,
          failures: failures.value, policy: approved.value.policy }, ctx.gh);
        if (!repairs.ok) return blocked(repairs.code, repairs.message);
        return { ...outcome, exit: 1, ...(outcome.automation ? { automation: { ...outcome.automation, status: 'blocked' } } : {}),
          errors: failures.value.map((failure) => ({ severity: 'error', ...failure })) };
      }
    }
    const waiting = outcome.automation?.status === 'pending' ||
      (outcome.automation?.merged === true && outcome.exit === 3 && outcome.errors?.[0]?.code !== 'policy_history_unavailable');
    if (!waiting) {
      return outcome;
    }
    if (now() >= deadline) return outcome;
    await sleep(Math.min(options.pollMs ?? 10_000, Math.max(0, deadline - now())));
  } while (now() <= deadline);
  return outcome;
}
