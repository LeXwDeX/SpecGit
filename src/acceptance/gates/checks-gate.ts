import type { CheckRunInfo } from '../../github/port.js';
import { makeFailure, type GateContext, type GateFailure } from './types.js';

/**
 * #119: the truth run for a check name — the run with the latest
 * started_at, ties broken by the higher check-run id. Re-runs keep every
 * same-name run in the Checks API and response position is never
 * evidence (the product decision docs/reference.md states once).
 */
function truthRun(runs: CheckRunInfo[], name: string): CheckRunInfo | undefined {
  let best: CheckRunInfo | undefined;
  for (const run of runs) {
    if (run.name !== name) continue;
    if (best === undefined || isLaterRun(run, best)) best = run;
  }
  return best;
}

function isLaterRun(a: CheckRunInfo, b: CheckRunInfo): boolean {
  const keyA = a.startedAt ?? '';
  const keyB = b.startedAt ?? '';
  if (keyA !== keyB) return keyA > keyB;
  return a.id > b.id;
}

/**
 * Gate 11 — checks: every policy-required check ran green at the PR
 * head. The walk only reaches this gate when a forge provider is
 * present (see `GATE_FNS` in `index.ts`).
 */
export async function checksGate(ctx: GateContext): Promise<GateFailure[]> {
  const runs = await ctx.input.gh!.getCheckRuns(ctx.repoRef!, ctx.prFact!.headSha);
  if (!runs.ok) {
    return [makeFailure(runs)];
  }
  // #269: diagnostic prose is the greppable surface — on a declared
  // GitLab origin the platform's CI is a GitLab pipeline, never GitHub
  // Actions, so the checks_missing fix is GitLab-shaped there.
  const onGitLab = ctx.input.gitlabHost !== undefined;
  const failures: GateFailure[] = [];
  for (const requiredName of ctx.policy!.required_checks) {
    // #119: re-runs keep every same-name run in the Checks API. The
    // truth run is the latest by started_at, ties broken by the
    // higher check-run id (docs/reference.md, Checks G11); response
    // position is never evidence.
    const run = truthRun(runs.value, requiredName);
    if (!run) {
      const missing = makeFailure('checks_missing', { name: requiredName });
      if (onGitLab) {
        missing.fix = 'Ensure the required GitLab CI pipeline runs on the MR head commit.';
      }
      failures.push(missing);
      continue;
    }
    if (run.status !== 'completed') {
      const pending = makeFailure('checks_pending', {
        name: requiredName,
        status: run.status,
      });
      // Honest diagnostics (#68): the message names the check and its
      // live status so pending reads as a specific, transient state.
      pending.message = `${pending.message} [check: ${requiredName}, status: ${run.status}]`;
      failures.push(pending);
      continue;
    }
    if (run.conclusion !== 'success') {
      // #116 (D-4″, ledger row 17): a failed `allow_failure` job
      // keeps the pipeline green. The fact above still reports the
      // truthful failure — the gate verdict follows the pipeline,
      // and only failure is affected: every other conclusion
      // (cancelled, timed out, …) still fails, allowed or not.
      if (!(run.conclusion === 'failure' && run.allowFailure === true)) {
        const failed = makeFailure('checks_failed', {
          name: requiredName,
          conclusion: run.conclusion,
        });
        failed.message = `${failed.message} [check: ${requiredName}, conclusion: ${run.conclusion}]`;
        failures.push(failed);
      }
    }
  }
  return failures;
}
